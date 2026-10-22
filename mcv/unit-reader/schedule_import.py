"""Import a full Network Rail JSON timetable into an atomic MCV lookup database.

Keep every variant of each UID that visits MCV, including cancellations and
overlays diverted away from MCV. This is timetable data, not a live train board.
"""
import argparse
import datetime as dt
import gzip
import json
import os
import sqlite3
import tempfile
import zlib
from pathlib import Path

STATION = "MNCRVIC"


def import_timetable(source, destination, report=print):
    source, destination = Path(source), Path(destination)
    destination.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=destination.name + ".", suffix=".building",
                                           dir=destination.parent)
    os.close(descriptor)
    db = None
    try:
        db = sqlite3.connect(temporary)
        db.executescript("""
            CREATE TABLE metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE locations (
                tiploc TEXT PRIMARY KEY, stanox TEXT, crs TEXT, description TEXT);
            CREATE TABLE schedules (
                uid TEXT NOT NULL, start_date TEXT NOT NULL, stp TEXT NOT NULL,
                end_date TEXT NOT NULL, days TEXT NOT NULL,
                applicable TEXT, bank_holiday TEXT,
                payload_zlib BLOB,
                PRIMARY KEY (uid, start_date, stp));
        """)
        header = None
        ended = False
        count = visits = 0
        with gzip.open(source, "rt", encoding="utf-8") as stream:
            for line in stream:
                if not line.strip():
                    continue
                if ended:
                    raise ValueError("Data after timetable EOF")
                item = json.loads(line)
                if not isinstance(item, dict) or len(item) != 1:
                    raise ValueError("Unexpected timetable envelope")
                kind, value = next(iter(item.items()))
                if kind == "JsonTimetableV1":
                    if header is not None or count:
                        raise ValueError("Repeated or misplaced timetable header")
                    if value.get("Metadata", {}).get("type") != "full":
                        raise ValueError("A full timetable is required, not an update")
                    header = value
                elif header is None:
                    raise ValueError("Missing full timetable header")
                elif kind == "EOF":
                    ended = True
                elif kind == "TiplocV1":
                    if value.get("transaction_type") != "Create":
                        raise ValueError("Unexpected location transaction in full file")
                    db.execute("INSERT INTO locations VALUES (?, ?, ?, ?)", (
                        value["tiploc_code"], value.get("stanox"), value.get("crs_code"),
                        value.get("description") or value.get("tps_description")))
                elif kind == "JsonScheduleV1":
                    if value.get("transaction_type") != "Create":
                        raise ValueError("Unexpected schedule transaction in full file")
                    uid = value["CIF_train_uid"]
                    start, end = value["schedule_start_date"], value["schedule_end_date"]
                    dt.date.fromisoformat(start)
                    dt.date.fromisoformat(end)
                    days, stp = value["schedule_days_runs"], value["CIF_stp_indicator"]
                    if len(days) != 7 or set(days) - {"0", "1"} or stp not in {"C", "N", "O", "P"}:
                        raise ValueError("Invalid running days or STP indicator")
                    segment = value.get("schedule_segment") or {}
                    locations = segment.get("schedule_location") or []
                    visits_mcv = any(stop.get("tiploc_code") == STATION for stop in locations)
                    payload = zlib.compress(json.dumps(value, separators=(",", ":")).encode()) if visits_mcv else None
                    db.execute("INSERT INTO schedules VALUES (?, ?, ?, ?, ?, ?, ?, ?)", (
                        uid, start, stp, end, days, value.get("applicable_timetable"),
                        value.get("CIF_bank_holiday_running"), payload))
                    count += 1
                    visits += visits_mcv
                    if count % 50000 == 0:
                        db.commit()
                        report(f"Read {count} schedules; {visits} include MCV", flush=True)
                elif kind != "JsonAssociationV1":
                    raise ValueError("Unknown timetable record: " + kind)
        if not header or not ended or not visits:
            raise ValueError("Incomplete timetable or no MCV schedules; existing database retained")
        # Do this after reading the entire file: an overlay without MCV may come
        # before or after its permanent MCV schedule. Both must be retained.
        db.execute("""DELETE FROM schedules WHERE uid NOT IN
            (SELECT uid FROM schedules WHERE payload_zlib IS NOT NULL)""")
        db.execute("INSERT INTO metadata VALUES ('header', ?)", (json.dumps(header),))
        db.execute("INSERT INTO metadata VALUES ('imported_at', ?)",
                   (dt.datetime.now(dt.timezone.utc).isoformat(),))
        db.execute("INSERT INTO metadata VALUES ('source_schedule_count', ?)", (str(count),))
        retained = db.execute("SELECT count(*) FROM schedules").fetchone()[0]
        location_count = db.execute("SELECT count(*) FROM locations").fetchone()[0]
        db.commit()
        db.execute("VACUUM")
        if db.execute("PRAGMA quick_check").fetchone()[0] != "ok":
            raise ValueError("Timetable database failed integrity check")
        db.close()
        db = None
        with open(temporary, "rb") as completed:
            os.fsync(completed.fileno())
        os.replace(temporary, destination)
        report(f"Imported {retained} MCV UID variants and {location_count} locations into {destination}")
        return retained
    finally:
        if db is not None:
            db.close()
        Path(temporary).unlink(missing_ok=True)


def lookup(db, uid, operating_date):
    """Return the effective MCV schedule, or an explicit reason it is unavailable.

    The date is the train's origin operating date, not necessarily the MCV date.
    Bank-holiday restrictions need a verified holiday calendar before use on a
    live board; expose such schedules as unresolved rather than guessing.
    """
    date = dt.date.fromisoformat(operating_date)
    rows = db.execute("""SELECT stp, bank_holiday, payload_zlib, start_date
        FROM schedules WHERE uid=? AND start_date<=? AND end_date>=?
        AND substr(days, ?, 1)='1' AND applicable='Y'""",
        (uid, operating_date, operating_date, date.weekday() + 1)).fetchall()
    if not rows:
        return {"status": "not-found"}
    best = min(row[0] for row in rows)  # C, N, O, P: cancellation wins.
    rows = [row for row in rows if row[0] == best]
    if best == "C":
        return {"status": "cancelled"}
    if len(rows) != 1:
        return {"status": "ambiguous"}
    _, holiday, payload, _ = rows[0]
    if holiday and holiday.strip():
        return {"status": "holiday-rule-unresolved"}
    if payload is None:
        return {"status": "does-not-visit-mcv"}
    return {"status": "scheduled", "schedule": json.loads(zlib.decompress(payload))}


def main():
    os.umask(0o077)
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path, nargs="?", help="full timetable .json.gz")
    parser.add_argument("--database", type=Path, default=Path(__file__).resolve().parent / "schedules.sqlite3")
    parser.add_argument("--check-uid", help="show the effective MCV schedule for this UID")
    parser.add_argument("--date", default=dt.date.today().isoformat(), help="origin operating date")
    args = parser.parse_args()
    if args.source:
        import_timetable(args.source, args.database)
    if args.check_uid:
        with sqlite3.connect(args.database.resolve().as_uri() + "?mode=ro", uri=True) as db:
            result = lookup(db, args.check_uid, args.date)
            schedule = result.pop("schedule", None)
            if schedule:
                segment = schedule["schedule_segment"]
                stops = segment["schedule_location"]
                result.update({"uid": schedule["CIF_train_uid"], "headcode": segment.get("signalling_id"),
                    "stp": schedule["CIF_stp_indicator"], "operator": schedule.get("atoc_code"),
                    "category": segment.get("CIF_train_category"),
                    "origin": stops[0], "destination": stops[-1],
                    "victoria": [stop for stop in stops if stop["tiploc_code"] == STATION]})
            print(json.dumps(result, indent=2))
    elif not args.source:
        parser.error("supply a full timetable file or --check-uid")


if __name__ == "__main__":
    main()
