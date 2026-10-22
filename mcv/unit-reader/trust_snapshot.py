"""Project captured TRUST activations into conservative, staff-only ECS rows.

No Kafka consumer here: index the existing durable archive incrementally.
Movement times are matched to their scheduled event before interpreting them.
"""
import argparse
from contextlib import closing
import datetime as dt
import json
import os
import re
import sqlite3
import time
import zlib
from pathlib import Path
from zoneinfo import ZoneInfo

from schedule_import import lookup

UTC = dt.timezone.utc
LONDON = ZoneInfo("Europe/London")
FEED_MAX_AGE = 180
SCHEDULE_MAX_AGE = 36 * 3600


def open_readonly(path):
    return sqlite3.connect(Path(path).resolve().as_uri() + "?mode=ro", uri=True, timeout=10)


def index_archive(raw, cache, stanox):
    cache.executescript("""
        CREATE TABLE IF NOT EXISTS progress (id INTEGER PRIMARY KEY CHECK(id=1), last_row INTEGER);
        INSERT OR IGNORE INTO progress VALUES (1, 0);
        CREATE TABLE IF NOT EXISTS events (
            batch_row INTEGER, ordinal INTEGER, received_at INTEGER,
            train_id TEXT, kind TEXT, queue_time INTEGER, body TEXT,
            PRIMARY KEY(batch_row, ordinal));
        CREATE INDEX IF NOT EXISTS train_events ON events(train_id);
    """)
    cache.commit()
    target = raw.execute("SELECT coalesce(max(rowid),0) FROM trust_batches").fetchone()[0]
    cursor = cache.execute("SELECT last_row FROM progress").fetchone()[0]
    if cursor > target:
        raise ValueError("TRUST archive replaced; rebuild trust-projection.sqlite3")
    while cursor < target:
        rows = raw.execute("""SELECT rowid, received_at, payload_zlib, parse_error
            FROM trust_batches WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT 500""",
            (cursor, target)).fetchall()
        if not rows:
            break
        with cache:
            for batch_id, received, compressed, error in rows:
                if error:
                    continue
                for ordinal, event in enumerate(json.loads(zlib.decompress(compressed))):
                    header, body = event["header"], event["body"]
                    kind, train = header.get("msg_type"), body.get("train_id")
                    if not train:
                        continue
                    if kind == "0003":
                        # Keep only MCV movements. Lifecycle messages are small;
                        # retain them nationally so schedule refreshes can match
                        # an activation that did not previously have a timetable.
                        if str(body.get("loc_stanox", "")).zfill(5) != stanox:
                            continue
                    elif kind not in {"0001", "0002", "0005", "0006", "0007", "0008"}:
                        continue
                    try:
                        queue = int(header.get("msg_queue_timestamp") or received * 1000)
                    except (ValueError, TypeError):
                        queue = received * 1000
                    cache.execute("INSERT OR IGNORE INTO events VALUES (?, ?, ?, ?, ?, ?, ?)",
                        (batch_id, ordinal, received, train, kind, queue, json.dumps(body)))
            cursor = rows[-1][0]
            cache.execute("UPDATE progress SET last_row=? WHERE id=1", (cursor,))
    with cache:
        cache.execute("DELETE FROM events WHERE received_at < ?", (int(time.time()) - 2 * 86400,))


def timed_route(schedule, operating_date):
    date = dt.date.fromisoformat(operating_date)
    previous = -1
    route = []
    initial_offset = None
    for stop in schedule["schedule_segment"]["schedule_location"]:
        times = {}
        for field in ("arrival", "pass", "departure"):
            value = stop.get(field)
            if not value:
                continue
            if not re.fullmatch(r"(?:[01]\d|2[0-3])[0-5]\dH?", value):
                raise ValueError("Unknown timetable clock")
            seconds = int(value[:2]) * 3600 + int(value[2:4]) * 60 + (30 if value.endswith("H") else 0)
            if seconds < previous:
                date += dt.timedelta(days=1)
            previous = seconds
            naive = dt.datetime.combine(date, dt.time()) + dt.timedelta(seconds=seconds)
            moment = naive.replace(tzinfo=LONDON)
            # Do not guess the fold or the industry overnight clock convention
            # for a train crossing a daylight-saving transition.
            if moment.utcoffset() != moment.replace(fold=1).utcoffset():
                raise ValueError("Ambiguous daylight-saving timetable time")
            if moment.astimezone(UTC).astimezone(LONDON).replace(tzinfo=None) != naive:
                raise ValueError("Nonexistent daylight-saving timetable time")
            if initial_offset is None:
                initial_offset = moment.utcoffset()
            if moment.utcoffset() != initial_offset:
                raise ValueError("Timetable crosses daylight-saving transition")
            times[field] = moment
        route.append((stop, times))
    return route


def reported_time(body, scheduled, now):
    if scheduled is None or str(body.get("offroute_ind", "false")).lower() == "true":
        return None
    try:
        planned_ms, actual_ms = int(body["planned_timestamp"]), int(body["actual_timestamp"])
        encoded_clock = dt.datetime.fromtimestamp(planned_ms / 1000, UTC).replace(tzinfo=None)
        wall_matches = encoded_clock == scheduled.replace(tzinfo=None)
        utc_matches = abs(planned_ms / 1000 - scheduled.timestamp()) < 1
        if not (wall_matches or utc_matches) or abs(actual_ms - planned_ms) > 12 * 3600000:
            return None
        actual = scheduled.astimezone(UTC) + dt.timedelta(milliseconds=actual_ms - planned_ms)
        if actual > now + dt.timedelta(seconds=90):
            return None
        return actual
    except (KeyError, ValueError, TypeError, OverflowError, OSError):
        return None


def project_train(schedule, activation, events, db, now):
    segment = schedule["schedule_segment"]
    if segment.get("CIF_train_category") != "EE":
        return None
    headcode, uid = segment.get("signalling_id", ""), schedule["CIF_train_uid"]
    train_id, date = activation["train_id"], activation["tp_origin_timestamp"]
    if not re.fullmatch(r"[0-9][A-Z][0-9]{2}", headcode) or not re.fullmatch(r"[A-Z]\d{5}", uid):
        return None
    if not re.fullmatch(r"[A-Z0-9]{10}", train_id) or train_id[2:6] != headcode:
        return None
    # Special lifecycle changes need route-specific reconciliation. Withhold
    # their rows in this first integration rather than showing an obsolete route.
    if any(kind in {"0006", "0007", "0008"} or
           (kind == "0003" and str(body.get("correction_ind")).lower() == "true")
           for kind, body in events):
        return None
    lifecycle = [kind for kind, _ in events if kind in {"0002", "0005"}]
    if lifecycle and lifecycle[-1] == "0002":
        return None
    route = timed_route(schedule, date)
    indices = [i for i, (stop, _) in enumerate(route) if stop["tiploc_code"] == "MNCRVIC"]
    if len(indices) != 1:
        return None
    index = indices[0]
    stop, times = route[index]
    if "pass" in times or not (times.get("arrival") or times.get("departure")):
        return None  # Passing movements require a separate staff presentation.
    arrival = departure = None
    reported_platform = ""
    last_report = None
    for kind, body in events:
        if kind != "0003":
            continue
        event = body.get("event_type")
        planned_type = body.get("planned_event_type")
        field = "arrival" if planned_type in {"ARRIVAL", "DESTINATION"} else "departure" if planned_type == "DEPARTURE" else None
        actual = reported_time(body, times.get(field), now) if field else None
        if actual is None:
            continue
        if str(body.get("train_terminated", "false")).lower() == "true" and index != len(route) - 1:
            return None
        if body.get("route") == "F":
            return None
        if event == "ARRIVAL" and field == "arrival":
            arrival = actual
        elif event == "DEPARTURE":
            departure = actual
        else:
            continue
        platform = str(body.get("platform") or "").strip()
        if last_report is None or actual >= last_report:
            last_report = actual
            if re.fullmatch(r"[1-6](?:[AB])?", platform):
                reported_platform = platform
    booked = times.get("departure") or times["arrival"]
    if departure and (now - departure).total_seconds() > 300:
        return None
    if index == len(route) - 1 and arrival and (now - arrival).total_seconds() > 300:
        return None
    if booked > now + dt.timedelta(hours=2):
        return None
    if booked < now - dt.timedelta(minutes=30):
        # An arrival report is evidence of arrival, not indefinite occupancy.
        if not arrival or (now - arrival).total_seconds() > 1800:
            return None

    def place(point):
        tiploc = point["tiploc_code"]
        row = db.execute("SELECT crs, description FROM locations WHERE tiploc=?", (tiploc,)).fetchone()
        crs = (row[0] if row else None) or ""
        return {"tiploc": tiploc, "crs": tiploc if not crs or crs.startswith("X") else crs,
                "locationName": tiploc if not crs or crs.startswith("X") else (row[1] or tiploc)}

    def points(parts):
        result = []
        for point, clocks in parts:
            clock = clocks.get("arrival") or clocks.get("departure")
            if clock:
                result.append({**place(point), "st": clock.isoformat()})
        return [{"callingPoint": result}] if result else []

    next_tiploc = route[index + 1][0]["tiploc_code"] if index + 1 < len(route) else ""
    direction = "West" if next_tiploc in {"MNCRDST", "SLFDORD", "SALFDSC", "MNCRVRS"} else "East" if next_tiploc in {"MILESPL", "THRPSBJ", "NWTNHDD"} else ""
    operator = schedule.get("atoc_code") or ""
    operators = {"NT": "Northern", "TP": "TransPennine Express", "AW": "Transport for Wales"}
    return {
        "serviceID": f"trust:{date}:{train_id}", "uid": uid, "trainid": headcode, "sdd": date,
        "operatorCode": operator, "operator": operators.get(operator, operator or "Operator not supplied"),
        "category": "EE", "serviceType": "train", "isPassengerService": False,
        "origin": [place(route[0][0])], "destination": [place(route[-1][0])],
        "sta": times["arrival"].isoformat() if times.get("arrival") else None,
        "std": times["departure"].isoformat() if times.get("departure") else None,
        "ata": arrival.astimezone(LONDON).isoformat() if arrival else None, "atd": departure.astimezone(LONDON).isoformat() if departure else None,
        "platform": reported_platform or str(stop.get("platform") or "").strip(),
        "previousCallingPoints": points(route[:index]), "subsequentCallingPoints": points(route[index + 1:]),
        "mcvSource": "TRUST", "trust": {"trainId": train_id,
            "platformSource": "reported" if reported_platform else "booked",
            "lastReportAt": last_report.isoformat() if last_report else None,
            "departureDirection": direction, "directionPoint": next_tiploc}
    }


def build_snapshot(folder, now=None):
    folder = Path(folder)
    now = now or dt.datetime.now(UTC)
    unavailable = {"version": 1, "available": False, "services": []}
    with closing(open_readonly(folder / "trust.sqlite3")) as raw, closing(open_readonly(folder / "schedules.sqlite3")) as schedules:
        latest = raw.execute("SELECT received_at, parse_error FROM trust_batches ORDER BY rowid DESC LIMIT 1").fetchone()
        if not latest or latest[1] or not 0 <= now.timestamp() - latest[0] <= FEED_MAX_AGE:
            return {**unavailable, "reason": "capture-stale"}
        header = json.loads(schedules.execute("SELECT value FROM metadata WHERE name='header'").fetchone()[0])
        schedule_stamp = int(header["timestamp"])
        if not 0 <= now.timestamp() - schedule_stamp <= SCHEDULE_MAX_AGE:
            return {**unavailable, "reason": "timetable-stale"}
        location = schedules.execute("SELECT stanox FROM locations WHERE tiploc='MNCRVIC'").fetchone()
        if not location or not location[0]:
            raise ValueError("Missing Victoria STANOX")
        with closing(sqlite3.connect(folder / "trust-projection.sqlite3", timeout=10)) as cache:
            index_archive(raw, cache, str(location[0]).zfill(5))
            by_train = {}
            for train, kind, body in cache.execute("SELECT train_id, kind, body FROM events ORDER BY queue_time, received_at, batch_row, ordinal"):
                by_train.setdefault(train, []).append((kind, json.loads(body)))
            output = []
            counts = {"matchedEcs": 0, "withheld": 0}
            for events in by_train.values():
                activations = [body for kind, body in events if kind == "0001"]
                if not activations:
                    continue
                dates = {a.get("tp_origin_timestamp") for a in activations}
                uids = {a.get("train_uid") for a in activations}
                if len(dates) != 1 or len(uids) != 1:
                    continue
                activation = activations[-1]
                try:
                    result = lookup(schedules, activation.get("train_uid"), activation.get("tp_origin_timestamp"))
                    if result["status"] != "scheduled":
                        continue
                    service = project_train(result["schedule"], activation, events, schedules, now)
                except (ValueError, TypeError, KeyError):
                    counts["withheld"] += 1
                    continue
                if service:
                    output.append(service)
            output.sort(key=lambda row: row.get("std") or row["sta"])
            counts["matchedEcs"] = len(output)
            return {"version": 1, "available": True, "updatedAt": now.isoformat(),
                    "feedAt": dt.datetime.fromtimestamp(latest[0], UTC).isoformat(),
                    "scheduleAt": dt.datetime.fromtimestamp(schedule_stamp, UTC).isoformat(),
                    "services": output[:100], "diagnostics": counts}


if __name__ == "__main__":
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--folder", type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    print(json.dumps(build_snapshot(args.folder), indent=2))
