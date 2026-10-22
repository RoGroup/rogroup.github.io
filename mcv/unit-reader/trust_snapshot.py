"""Project captured TRUST evidence into staff ECS, timetable and journey data.

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


def index_history_archive(raw, cache, schedules, schedule_stamp, now):
    """Index lifecycle events first, then retain movements for MCV schedules.

    A separate disposable index keeps upgrades compatible with the old publisher.
    The first pass allows a movement preceding its activation in the same replay
    to be joined. A later activation can leave earlier reports absent; the UI
    therefore describes captured reports, never a complete journey record.
    """
    cache.executescript("""
        CREATE TABLE IF NOT EXISTS history_progress (
            id INTEGER PRIMARY KEY CHECK(id=1), lifecycle_row INTEGER,
            movement_row INTEGER, schedule_stamp INTEGER);
        INSERT OR IGNORE INTO history_progress VALUES (1,0,0,0);
        CREATE TABLE IF NOT EXISTS events (
            batch_row INTEGER, ordinal INTEGER, received_at INTEGER,
            train_id TEXT, kind TEXT, queue_time INTEGER, body TEXT,
            PRIMARY KEY(batch_row,ordinal));
        CREATE INDEX IF NOT EXISTS history_train ON events(train_id);
    """)
    cache.commit()
    target = raw.execute("SELECT coalesce(max(rowid),0) FROM trust_batches").fetchone()[0]
    life_cursor, movement_cursor, previous_stamp = cache.execute("SELECT lifecycle_row,movement_row,schedule_stamp FROM history_progress WHERE id=1").fetchone()
    if life_cursor > target or movement_cursor > target:
        raise ValueError("TRUST archive replaced; rebuild trust-history-projection.sqlite3")
    if previous_stamp != schedule_stamp:
        with cache:
            cache.execute("DELETE FROM events WHERE kind='0003'")
            cache.execute("UPDATE history_progress SET movement_row=0,schedule_stamp=? WHERE id=1", (schedule_stamp,))
        movement_cursor = 0

    def replay(cursor, movements, relevant=None):
        column = "movement_row" if movements else "lifecycle_row"
        while cursor < target:
            rows = raw.execute("SELECT rowid,received_at,payload_zlib,parse_error FROM trust_batches WHERE rowid>? AND rowid<=? ORDER BY rowid LIMIT 500", (cursor,target)).fetchall()
            if not rows:
                break
            with cache:
                for batch, received, compressed, error in rows:
                    if error:
                        continue
                    for ordinal, event in enumerate(json.loads(zlib.decompress(compressed))):
                        header, body = event["header"], event["body"]
                        kind, train = header.get("msg_type"), body.get("train_id")
                        if not train or (movements and (kind != "0003" or train not in relevant)):
                            continue
                        if not movements and kind not in {"0001","0002","0005","0006","0007","0008"}:
                            continue
                        try:
                            queue = int(header.get("msg_queue_timestamp") or received*1000)
                        except (ValueError,TypeError):
                            queue = received*1000
                        cache.execute("INSERT OR IGNORE INTO events VALUES (?,?,?,?,?,?,?)", (batch,ordinal,received,train,kind,queue,json.dumps(body)))
                cursor = rows[-1][0]
                cache.execute(f"UPDATE history_progress SET {column}=? WHERE id=1", (cursor,))
    replay(life_cursor, False)
    uids = {row[0] for row in schedules.execute("SELECT DISTINCT uid FROM schedules WHERE payload_zlib IS NOT NULL")}
    relevant = {train for train, body in cache.execute("SELECT train_id,body FROM events WHERE kind='0001'") if json.loads(body).get("train_uid") in uids}
    replay(movement_cursor, True, relevant)
    with cache:
        cache.execute("DELETE FROM events WHERE received_at<?", (int(now.timestamp())-2*86400,))


def project_history(schedule, activation, events, db, now):
    """Return captured evidence separately from live status or location claims."""
    uid, headcode, date = schedule["CIF_train_uid"], schedule["schedule_segment"].get("signalling_id", ""), activation["tp_origin_timestamp"]
    train_id = activation["train_id"]
    if not re.fullmatch(r"[A-Z]\d{5}",uid) or not re.fullmatch(r"[0-9][A-Z]\d{2}",headcode) or not re.fullmatch(r"[A-Z0-9]{10}",train_id) or train_id[2:6] != headcode:
        return None
    route = timed_route(schedule,date)
    visits = [(stop,times) for stop,times in route if stop["tiploc_code"] == "MNCRVIC"]
    if len(visits) != 1 or "pass" in visits[0][1]:
        return None
    clocks = visits[0][1]
    booked = clocks.get("departure") or clocks.get("arrival")
    if not booked or not now-dt.timedelta(hours=6) <= booked <= now+dt.timedelta(hours=2):
        return None
    tiplocs = list({stop["tiploc_code"] for stop,_ in route})
    if len(tiplocs) > 500:
        return None
    location_rows = list(db.execute("SELECT tiploc,stanox,crs,description FROM locations WHERE tiploc IN ("+",".join("?" for _ in tiplocs)+")",tiplocs))
    locations = {row[0]:row for row in location_rows}
    by_stanox = {}
    for stop,times in route:
        row = locations.get(stop["tiploc_code"])
        if row and row[1]:
            by_stanox.setdefault(str(row[1]).zfill(5),[]).append((stop,times))

    def place(tiploc):
        row = locations.get(tiploc)
        crs = str(row[2] or "") if row else ""
        if not re.fullmatch(r"[A-Z]{3}",crs) or crs.startswith("X"):
            crs = ""
        return {"tiploc":tiploc,"crs":crs,"locationName":str(row[3] or tiploc) if row else tiploc}

    corrected = {(str(body.get("loc_stanox","")).zfill(5),body.get("event_type")) for kind,body,_ in events if kind == "0003" and str(body.get("correction_ind","")).lower() == "true"}
    lifecycle_names = {"0001":"activation","0002":"cancellation","0005":"reinstatement","0006":"origin-change","0007":"identity-change","0008":"location-change"}
    lifecycle, movements = [], {}
    seen_lifecycle = set()
    changed = False
    for kind,body,received in events:
        if kind in lifecycle_names:
            if received <= now.timestamp()+30:
                entry = {"kind":lifecycle_names[kind],"at":dt.datetime.fromtimestamp(received,UTC).isoformat(),"timeBasis":"received",
                         "tiploc":"","crs":"","locationName":"Location not supplied","platform":"","delaySeconds":None}
                candidates = by_stanox.get(str(body.get("loc_stanox","")).zfill(5),[])
                if len(candidates) == 1:
                    entry.update(place(candidates[0][0]["tiploc_code"]))
                # Duplicate deliveries do not create duplicate history entries.
                fingerprint = (kind,json.dumps(body,sort_keys=True))
                if fingerprint not in seen_lifecycle:
                    lifecycle.append(entry)
                    seen_lifecycle.add(fingerprint)
            if kind in {"0006","0007","0008"}:
                changed = True
            continue
        if kind != "0003" or changed or (str(body.get("loc_stanox","")).zfill(5),body.get("event_type")) in corrected or body.get("route") == "F":
            continue
        event, planned = body.get("event_type"), body.get("planned_event_type")
        field = "arrival" if event == "ARRIVAL" and planned in {"ARRIVAL","DESTINATION"} else "departure" if event == "DEPARTURE" and planned in {"DEPARTURE","ORIGIN"} else "pass" if event == "PASS" and planned == "PASS" else None
        if not field:
            continue
        matches = []
        for stop,times in by_stanox.get(str(body.get("loc_stanox","")).zfill(5),[]):
            actual = reported_time(body,times.get(field),now)
            if actual and actual <= now:
                matches.append((stop,times[field],actual))
        if len(matches) != 1:
            continue
        stop,planned_time,actual = matches[0]
        platform = str(body.get("platform") or "").strip()
        if not re.fullmatch(r"[A-Z0-9 -]{1,10}",platform):
            platform = ""
        movements[(stop["tiploc_code"],field,planned_time.isoformat())] = {**place(stop["tiploc_code"]),"kind":field,"at":actual.isoformat(),"timeBasis":"actual",
            "delaySeconds":int((actual-planned_time).total_seconds()),"platform":platform}
    if not movements and not lifecycle:
        return None
    # Keep lifecycle events even on services with many reporting points.
    mcv_reports = [item for item in movements.values() if item["tiploc"] == "MNCRVIC"]
    other_reports = sorted([item for item in movements.values() if item["tiploc"] != "MNCRVIC"],key=lambda item:item["at"])
    remaining = max(0,48-len(mcv_reports))
    history = sorted([*mcv_reports,*(other_reports[-remaining:] if remaining else []),*lifecycle[-12:]],key=lambda item:item["at"])
    return {"uid":uid,"trainid":headcode,"sdd":date,
        "sta":clocks["arrival"].isoformat() if clocks.get("arrival") else None,
        "std":clocks["departure"].isoformat() if clocks.get("departure") else None,
        "events":history,"reconciliationRequired":changed or bool(corrected) or any(kind == "0003" and (body.get("route") == "F" or str(body.get("offroute_ind","")).lower() == "true") for kind,body,_ in events)}


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


def project_train(schedule, activation, events, db, now, ecs_only=True):
    segment = schedule["schedule_segment"]
    if ecs_only and segment.get("CIF_train_category") != "EE":
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
        elif event == "DEPARTURE" and field == "departure":
            departure = actual
        else:
            continue
        platform = str(body.get("platform") or "").strip()
        if last_report is None or actual >= last_report:
            last_report = actual
            if re.fullmatch(r"[1-6](?:[AB])?", platform):
                reported_platform = platform
    if arrival and departure and arrival > departure:
        return None
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

    def passenger_points(parts):
        result = booked_passenger_points(parts, db)
        return [{"callingPoint": result}] if result else []

    next_tiploc = route[index + 1][0]["tiploc_code"] if index + 1 < len(route) else ""
    direction = "West" if next_tiploc in {"MNCRDST", "SLFDORD", "SALFDSC", "MNCRVRS"} else "East" if next_tiploc in {"MILESPL", "THRPSBJ", "NWTNHDD"} else ""
    operator = schedule.get("atoc_code") or ""
    operators = {"NT": "Northern", "TP": "TransPennine Express", "AW": "Transport for Wales"}
    return {
        "serviceID": f"trust:{date}:{train_id}", "uid": uid, "trainid": headcode, "sdd": date,
        "operatorCode": operator, "operator": operators.get(operator, operator or "Operator not supplied"),
        "category": segment.get("CIF_train_category"), "serviceType": "train", "isPassengerService": segment.get("CIF_train_category") != "EE",
        "origin": [place(route[0][0])], "destination": [place(route[-1][0])],
        "sta": times["arrival"].isoformat() if times.get("arrival") else None,
        "std": times["departure"].isoformat() if times.get("departure") else None,
        "ata": arrival.astimezone(LONDON).isoformat() if arrival else None, "atd": departure.astimezone(LONDON).isoformat() if departure else None,
        "platform": reported_platform or str(stop.get("platform") or "").strip(),
        "previousCallingPoints": points(route[:index]), "subsequentCallingPoints": points(route[index + 1:]),
        "timetableCallingPoints": points(route[index + 1:]) if segment.get("CIF_train_category") == "EE" else passenger_points(route[index + 1:]),
        "mcvSource": "TRUST", "trust": {"trainId": train_id,
            "platformSource": "reported" if reported_platform else "booked",
            "lastReportAt": last_report.isoformat() if last_report else None,
            "departureDirection": direction, "directionPoint": next_tiploc}
    }


def build_booked_patterns(folder, services, now=None):
    """Match the current Darwin board directly to the effective daily timetable.

    No TRUST activation or raw-feed freshness is required for booked calls.
    Never creates services or supplies actuals, forecasts or live platforms.
    """
    now = now or dt.datetime.now(UTC)
    with closing(open_readonly(Path(folder) / "schedules.sqlite3")) as db:
        header = json.loads(db.execute("SELECT value FROM metadata WHERE name='header'").fetchone()[0])
        stamp = int(header["timestamp"])
        if not 0 <= now.timestamp() - stamp <= SCHEDULE_MAX_AGE:
            return {"version": 1, "available": False, "routes": []}
        identities = [(s.get("uid"), s.get("trainid"), s.get("sdd")) for s in services]
        routes, checks = [], []
        def explain(service, reason):
            if re.fullmatch(r"[A-Z]\d{5}", str(service.get("uid") or "")) and re.fullmatch(r"\d[A-Z]\d{2}", str(service.get("trainid") or "")) and re.fullmatch(r"\d{4}-\d\d-\d\d", str(service.get("sdd") or "")):
                checks.append({**{key: str(service.get(key) or "") for key in ("uid", "trainid", "sdd", "sta", "std")}, "reason": reason})
        for service, identity in zip(services, identities):
            uid, headcode, date = identity
            if identities.count(identity) != 1 or not re.fullmatch(r"[A-Z]\d{5}", str(uid or "")) or not re.fullmatch(r"\d[A-Z]\d{2}", str(headcode or "")):
                continue
            if any(service.get(flag) for flag in ("isCancelled", "filterLocationCancelled", "futureCancellation", "diversion", "affectedByDiversion")) or service.get("isPassengerService") is False:
                continue
            if (service.get("subsequentLocations") or any(group.get("callingPoint") for group in service.get("subsequentCallingPoints", []))):
                continue
            try:
                result = lookup(db, uid, date)
                if result["status"] != "scheduled":
                    explain(service, result["status"])
                    continue
                schedule = result["schedule"]
                if schedule["schedule_segment"].get("signalling_id") != headcode or schedule["schedule_segment"].get("CIF_train_category") == "EE":
                    explain(service, "headcode-or-category")
                    continue
                route = timed_route(schedule, date)
                indices = [i for i, (stop, _) in enumerate(route) if stop["tiploc_code"] == "MNCRVIC"]
                if len(indices) != 1:
                    explain(service, "ambiguous-visit")
                    continue
                index = indices[0]
                times = route[index][1]
                if not times.get("departure") or "pass" in times or not now-dt.timedelta(minutes=30) <= times["departure"].astimezone(UTC) <= now+dt.timedelta(hours=24):
                    explain(service, "outside-window-or-no-departure")
                    continue
                def matches(value, planned):
                    if not value or planned is None:
                        return False
                    if re.fullmatch(r"\d\d:\d\d(?::\d\d)?", value):
                        return value[:5] == planned.strftime("%H:%M")
                    moment = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
                    if moment.tzinfo is None:
                        moment = moment.replace(tzinfo=LONDON)
                        if moment.utcoffset() != moment.replace(fold=1).utcoffset() or moment.astimezone(UTC).astimezone(LONDON).replace(tzinfo=None) != moment.replace(tzinfo=None):
                            return False
                    return int(moment.timestamp() // 60) == int(planned.timestamp() // 60)
                stop = route[index][0]
                public_times = {name: public_booked_time(stop.get("public_"+name), times.get(name)) for name in ("arrival", "departure")}
                # Darwin can supply public rather than working booked times.
                # Require one consistent pair, never a widened time tolerance
                # or an arrival from one basis and departure from the other.
                chosen = next((candidate for candidate in (public_times, times)
                    if all(matches(str(service.get(field) or ""), candidate.get(name))
                           for field, name in (("sta", "arrival"), ("std", "departure")) if service.get(field))), None)
                if chosen is None or not service.get("std"):
                    explain(service, "booked-time-mismatch")
                    continue
                calls = booked_passenger_points(route[index+1:], db)
                if 0 < len(calls) <= 100:
                    routes.append({"uid": uid, "trainid": headcode, "sdd": date,
                        "sta": chosen["arrival"].isoformat() if chosen.get("arrival") else None,
                        "std": chosen["departure"].isoformat(), "callingPoints": calls})
                else:
                    explain(service, "no-public-calls")
            except (ValueError, TypeError, KeyError):
                explain(service, "invalid-timetable")
                continue
        return {"version": 1, "available": True, "updatedAt": now.isoformat(),
                "scheduleAt": dt.datetime.fromtimestamp(stamp, UTC).isoformat(), "routes": routes[:200], "checks": checks[:200]}


def public_booked_time(value, working):
    if working is None or not isinstance(value, str) or value == "0000" or not re.fullmatch(r"(?:[01]\d|2[0-3])[0-5]\d", value):
        return None
    public = working.replace(hour=int(value[:2]), minute=int(value[2:]), second=0)
    public = min((public+dt.timedelta(days=offset) for offset in (-1,0,1)), key=lambda candidate: abs((candidate-working).total_seconds()))
    if abs((public-working).total_seconds()) > 1800 or public.utcoffset() != public.replace(fold=1).utcoffset() or public.utcoffset() != working.utcoffset():
        return None
    if public.astimezone(UTC).astimezone(LONDON).replace(tzinfo=None) != public.replace(tzinfo=None):
        return None
    return public


def booked_passenger_points(parts, db):
    result = []
    for point, clocks in parts:
        row = db.execute("SELECT crs, description FROM locations WHERE tiploc=?", (point["tiploc_code"],)).fetchone()
        crs = row[0] if row else ""
        value = next((value for value in (point.get("public_arrival"), point.get("public_departure"))
                      if isinstance(value, str) and value != "0000" and re.fullmatch(r"(?:[01]\d|2[0-3])[0-5]\d", value)), None)
        working = clocks.get("arrival") or clocks.get("departure")
        if not working or not re.fullmatch(r"[A-Z]{3}", crs or "") or crs.startswith("X") or value is None:
            continue
        public = public_booked_time(value, working)
        if public is not None:
            result.append({"tiploc": point["tiploc_code"], "crs": crs, "locationName": row[1] or point["tiploc_code"], "st": public.isoformat()})
    return result


def build_snapshot(folder, now=None, services=None):
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
        with closing(sqlite3.connect(folder / "trust-history-projection.sqlite3", timeout=10)) as cache:
            index_history_archive(raw, cache, schedules, schedule_stamp, now)
            by_train = {}
            for train, kind, body, received in cache.execute("SELECT train_id, kind, body,received_at FROM events ORDER BY queue_time, received_at, batch_row, ordinal"):
                by_train.setdefault(train, []).append((kind, json.loads(body), received))
            output = []
            movements = []
            routes = []
            histories = []
            requested = {(row.get("uid"),row.get("trainid"),row.get("sdd")) for row in services} if services is not None else None
            counts = {"matchedEcs": 0, "withheld": 0}
            for events in by_train.values():
                activations = [body for kind, body, _ in events if kind == "0001"]
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
                    local_events = [(kind,body) for kind,body,_ in events if kind != "0003" or str(body.get("loc_stanox","")).zfill(5) == str(location[0]).zfill(5)]
                    service = project_train(result["schedule"], activation, local_events, schedules, now, ecs_only=False)
                    if requested is None or (activation.get("train_uid"),result["schedule"]["schedule_segment"].get("signalling_id"),activation.get("tp_origin_timestamp")) in requested:
                        history = project_history(result["schedule"],activation,events,schedules,now)
                        if history:
                            histories.append(history)
                except (ValueError, TypeError, KeyError):
                    counts["withheld"] += 1
                    continue
                if service and service["category"] == "EE":
                    output.append({key:value for key,value in service.items() if key != "timetableCallingPoints"})
                if service and (service["ata"] or service["atd"]):
                    movements.append({key: service[key] for key in ("uid", "trainid", "sdd", "sta", "std", "ata", "atd")}
                    | {"reportedPlatform": service["platform"] if service["trust"]["platformSource"] == "reported" else "",
                       "lastReportAt": service["trust"]["lastReportAt"]})
                if service and service["timetableCallingPoints"]:
                    routes.append({key: service[key] for key in ("uid", "trainid", "sdd", "sta", "std")}
                        | {"callingPoints": service["timetableCallingPoints"][0]["callingPoint"]})
            output.sort(key=lambda row: row.get("std") or row["sta"])
            counts["matchedEcs"] = len(output)
            return {"version": 1, "available": True, "updatedAt": now.isoformat(),
                    "feedAt": dt.datetime.fromtimestamp(latest[0], UTC).isoformat(),
                    "scheduleAt": dt.datetime.fromtimestamp(schedule_stamp, UTC).isoformat(),
                    "services": output[:100], "movements": movements[:200], "routes": routes[:200], "histories": histories[:200], "diagnostics": counts}


if __name__ == "__main__":
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--folder", type=Path, default=Path(__file__).resolve().parent)
    args = parser.parse_args()
    print(json.dumps(build_snapshot(args.folder), indent=2))
