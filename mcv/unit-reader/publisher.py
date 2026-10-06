"""Publish a small snapshot for the services currently on the MCV staff board."""
import datetime as dt
import json
import re
import sqlite3
import subprocess
import time
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

BASE = "https://mcv-rdm-proxy.railstaffhub.uk"
FOLDER = Path(__file__).resolve().parent
INTERVAL = 120


def clock(value):
    if not isinstance(value, str) or "T" not in value:
        return None
    try:
        return dt.datetime.fromisoformat(value).replace(tzinfo=None)
    except ValueError:
        return None


def location(allocation, name):
    return allocation.findtext(name + "/LocationSubsidiaryIdentification/LocationSubsidiaryCode") or ""


def signature(service):
    return {name: str(service.get(name) or "") for name in
            ("serviceID", "uid", "trainid", "sdd", "sta", "std")}


def resolve(db, service):
    identity = signature(service)
    result = {**identity, "status": "not-supplied", "arrivalUnits": [], "departureUnits": []}
    uid, headcode, date = identity["uid"], identity["trainid"], identity["sdd"]
    if not re.fullmatch(r"[A-Z][0-9]{5}", uid) or not headcode or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", date):
        return result
    rows = db.execute("""SELECT xml FROM trains WHERE start_date=? AND headcode=?
        AND substr(core, 5, 6)=?""", (date, headcode, uid)).fetchall()
    candidates = []
    origins = {item.get("tiploc") for item in service.get("origin", []) if item.get("tiploc")}
    destinations = {item.get("tiploc") for item in service.get("destination", []) if item.get("tiploc")}
    for (data,) in rows:
        root = ET.fromstring(data)
        for node in root.iter():
            node.tag = node.tag.split("}")[-1]
        allocations = root.findall("Allocation")
        # Require the board route to agree when endpoints are provided.
        if allocations and ((origins and any(location(a, "TrainOriginLocation") not in origins for a in allocations)) or
                            (destinations and any(location(a, "TrainDestLocation") not in destinations for a in allocations))):
            continue
        candidates.append(root)
    if len(candidates) != 1:
        return result
    root = candidates[0]
    result["messageTime"] = root.findtext("MessageHeader/MessageReference/MessageDateTime")
    if root.findtext("MessageStatus") != "1":
        return result
    segments = root.findall("Allocation")
    if not segments:
        result["status"] = "unallocated"
        return result
    for field, output in (("sta", "arrivalUnits"), ("std", "departureUnits")):
        movement = clock(service.get(field))
        if movement is None:
            continue
        selected = {}
        vehicle_sets = {}
        unit_classes = {}
        vehicle_order = {}
        for allocation in segments:
            start = clock(allocation.findtext("AllocationOriginDateTime"))
            end = clock(allocation.findtext("AllocationDestinationDateTime"))
            if start is None or end is None:
                continue
            # At an exact change boundary, arrivals use the ending segment;
            # departures use the starting segment, rather than combining both.
            covered = start <= movement < end if field == "std" else start < movement <= end
            if not covered:
                continue
            group = allocation.find("ResourceGroup")
            if group is None or group.findtext("TypeOfResource") != "U":
                continue
            unit = group.findtext("ResourceGroupId") or ""
            if not re.fullmatch(r"\d{6}", unit):
                continue
            position = allocation.findtext("ResourceGroupPosition") or "999"
            selected[unit] = int(position) if position.isdigit() else 999
            fleet = group.findtext("FleetId") or ""
            if re.fullmatch(r"\d{3}(?:/\d{1,3})?", fleet):
                unit_classes[unit] = fleet
            vehicles = group.findall("Vehicle")
            reverse = allocation.findtext("Reversed")
            positions = [v.findtext("ResourcePosition") or "" for v in vehicles]
            ordered = sorted(vehicles, key=lambda v: int(v.findtext("ResourcePosition") or "0")) if all(x.isdigit() for x in positions) else []
            if ordered and sorted(int(x) for x in positions) == list(range(1, len(vehicles)+1)) and reverse in ("Y", "N"):
                vehicle_order[unit] = list(reversed(ordered)) if reverse == "Y" else ordered

            ids = [v.findtext("VehicleId") or "" for v in vehicles]
            valid = bool(ids) and all(ids) and len(ids) == len(set(ids))
            current = frozenset(ids) if valid else None
            if unit in vehicle_sets and vehicle_sets[unit] != current:
                vehicle_sets[unit] = None
            else:
                vehicle_sets[unit] = current
        result[output] = sorted(selected, key=lambda unit: (selected[unit], unit))
        prefix = "arrival" if field == "sta" else "departure"
        order_known = sorted(selected.values()) == list(range(1, len(selected)+1))
        result[prefix + "OrderKnown"] = bool(selected) and order_known
        result[prefix + "UnitClasses"] = unit_classes
        # Coach letters and order are feed-reported, not a physical verification.
        if order_known and selected and all(vehicle_order.get(unit) for unit in selected):
            first = []
            offset = 0
            complete = True
            for unit in result[output]:
                fleet = unit_classes.get(unit, "").split("/")[0]
                letters = {"185": {"C", "G"}, "802": {"E"}}.get(fleet)
                vehicles = vehicle_order[unit]
                matches = [i+1 for i, v in enumerate(vehicles) if (v.findtext("CoachLetter") or "").strip().upper() in (letters or set())]
                if not letters or not matches:
                    complete = False
                    break
                first.extend(offset + i for i in matches)
                offset += len(vehicles)
            if complete:
                result[prefix + "FirstClassCarriages"] = first
        if selected and all(vehicle_sets.get(unit) for unit in selected):
            sets = [vehicle_sets[unit] for unit in selected]
            total = sum(len(ids) for ids in sets)
            if total == len(set().union(*sets)):
                result["arrivalCarriages" if field == "sta" else "departureCarriages"] = total
    if result["arrivalUnits"] or result["departureUnits"]:
        result["status"] = "allocated"
    return result


def run_once(db, token):
    with urllib.request.urlopen(BASE + "/staff-departures", timeout=30) as response:
        board = json.load(response)
    services = board.get("trainServices")
    if not isinstance(services, list) or len(services) > 200:
        raise ValueError("Unexpected staff board")
    running = subprocess.run(["/usr/bin/systemctl", "is-active", "mcv-unit-reader"],
                             capture_output=True, text=True).stdout.strip() == "active"
    entries = [resolve(db, service) for service in services] if running else []
    payload = {"version": 1, "updatedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
               "readerRunning": running, "services": entries}
    request = urllib.request.Request(BASE + "/unit-ingest", data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + token}, method="POST")
    with urllib.request.urlopen(request, timeout=30) as response:
        if response.status != 200:
            raise RuntimeError("Snapshot upload failed")
    matched = sum(entry["status"] == "allocated" for entry in entries)
    print(f"Published {len(entries)} services; {matched} have unit allocations; reader active={running}", flush=True)


def main():
    token = (FOLDER / "unit-ingest-token.txt").read_text().strip()
    if not re.fullmatch(r"[A-Za-z0-9_-]{32,128}", token):
        raise ValueError("Invalid ingestion token")
    db = sqlite3.connect(FOLDER / "allocations.sqlite3", timeout=10)
    db.execute("CREATE INDEX IF NOT EXISTS unit_lookup ON trains(start_date, headcode, substr(core, 5, 6))")
    db.commit()
    # Wait before every upload, including after restarts, to limit write frequency.
    while True:
        time.sleep(INTERVAL)
        try:
            run_once(db, token)
        except Exception as error:
            print(f"Snapshot update failed: {type(error).__name__}: {error}", flush=True)


if __name__ == "__main__":
    main()
