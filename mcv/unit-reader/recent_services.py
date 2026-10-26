"""Bounded, persistent archive of staff-board observations, never a live feed."""
import datetime as dt
import json
import re
import sqlite3
from zoneinfo import ZoneInfo

UTC = dt.timezone.utc
LONDON = ZoneInfo("Europe/London")
RETENTION = 48 * 3600
UPLOAD_INTERVAL = 600


def booked(value):
    # Offset-free Darwin datetimes are London wall clocks. A clock alone lacks
    # a reliable calendar date around midnight, so do not guess its date.
    if not isinstance(value, str) or "T" not in value:
        return None
    try:
        stamp = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
        return (stamp if stamp.tzinfo else stamp.replace(tzinfo=LONDON)).astimezone(UTC).replace(second=0, microsecond=0).isoformat()
    except ValueError:
        return None


def identity(service):
    return tuple(str(service.get(key) or "").strip() for key in ("uid", "trainid", "sdd")) + tuple(booked(service.get(key)) or "" for key in ("sta", "std"))


def capture(folder, services, allocations, trust, now=None):
    now = now or dt.datetime.now(UTC)
    stamp, cutoff = now.timestamp(), now.timestamp() - RETENTION
    db = sqlite3.connect(folder / "recent-services.sqlite3", timeout=10)
    try:
        db.execute("CREATE TABLE IF NOT EXISTS recent (identity TEXT PRIMARY KEY, booked REAL NOT NULL, body TEXT NOT NULL)")
        db.execute("CREATE TABLE IF NOT EXISTS metadata (name TEXT PRIMARY KEY, value TEXT NOT NULL)")
        db.execute("INSERT OR IGNORE INTO metadata VALUES ('startedAt', ?)", (now.isoformat(),))
        db.execute("DELETE FROM recent WHERE booked < ?", (cutoff,))
        matches = {}
        if trust.get("available"):
            for history in trust.get("histories", []):
                key = identity(history)
                matches[key] = None if key in matches else history
        seen = set()
        for service in services:
            key = identity(service)
            if key in seen or not re.fullmatch(r"(?:[A-Z]\d{5}|\d{5})", key[0]) or not re.fullmatch(r"\d[A-Z]\d{2}", key[1]) or not re.fullmatch(r"\d{4}-\d\d-\d\d", key[2]):
                continue
            seen.add(key)
            times = [dt.datetime.fromisoformat(value).timestamp() for value in key[3:] if value]
            if not times or min(times) < cutoff or max(times) > stamp + 12 * 3600:
                continue
            encoded_key = json.dumps(key)
            old = db.execute("SELECT body FROM recent WHERE identity=?", (encoded_key,)).fetchone()
            old = json.loads(old[0]) if old else {}
            record = {"uid": key[0], "headcode": key[1], "date": key[2], "sta": key[3], "std": key[4],
                      "firstSeen": old.get("firstSeen", now.isoformat()), "lastSeen": now.isoformat(),
                      "source": "TRUST" if service.get("mcvSource") == "TRUST" else "Darwin",
                      "origin": " & ".join(str(p.get("locationName") or p.get("crs") or "") for p in service.get("origin", [])[:4])[:240],
                      "destination": " & ".join(str(p.get("locationName") or p.get("crs") or "") for p in service.get("destination", [])[:4])[:240],
                      "platform": str(service.get("platform") or "")[:20],
                      "cancelled": service.get("isCancelled") is True or service.get("filterLocationCancelled") is True,
                      "ata": str(service.get("ata") or "")[:50], "atd": str(service.get("atd") or "")[:50],
                      "eta": str(service.get("eta") or "")[:50], "etd": str(service.get("etd") or "")[:50]}
            allocation = next((a for a in allocations if a.get("serviceID") == service.get("serviceID") and identity(a) == key), None)
            if allocation and allocation.get("status") in ("allocated", "unallocated"):
                record["allocation"] = {"status": allocation["status"], "capturedAt": now.isoformat(),
                                        "arrivalUnits": allocation.get("arrivalUnits", [])[:20], "departureUnits": allocation.get("departureUnits", [])[:20]}
            elif old.get("allocation"):
                record["allocation"] = old["allocation"]
            history = matches.get(key)
            if history:
                record["history"] = {"events": history["events"], "reconciliationRequired": history["reconciliationRequired"], "capturedAt": now.isoformat()}
            elif old.get("history"):
                record["history"] = old["history"]
            db.execute("INSERT OR REPLACE INTO recent VALUES (?, ?, ?)", (encoded_key, max(times), json.dumps(record, separators=(",", ":"))))
        # A hard record/byte bound also protects a misconfigured upstream feed.
        db.execute("DELETE FROM recent WHERE identity NOT IN (SELECT identity FROM recent ORDER BY booked DESC LIMIT 1200)")
        rows = [json.loads(row[0]) for row in db.execute("SELECT body FROM recent ORDER BY booked DESC, identity")]
        while len(json.dumps(rows).encode()) > 5500000:
            rows.pop()
        meta = dict(db.execute("SELECT name, value FROM metadata"))
        db.commit()
        return {"version": 1, "startedAt": meta["startedAt"], "updatedAt": now.isoformat(), "retentionHours": 48,
                "services": rows}, stamp - float(meta.get("uploadedAt", "0")) >= UPLOAD_INTERVAL
    finally:
        db.close()


def mark_uploaded(folder, now=None):
    with sqlite3.connect(folder / "recent-services.sqlite3") as db:
        db.execute("INSERT OR REPLACE INTO metadata VALUES ('uploadedAt', ?)", (str((now or dt.datetime.now(UTC)).timestamp()),))
