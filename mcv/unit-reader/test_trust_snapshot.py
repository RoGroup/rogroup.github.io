import datetime as dt
import json
import sqlite3
import tempfile
import unittest
import zlib
from pathlib import Path

from trust_snapshot import build_snapshot, index_archive, project_train, timed_route, reported_time, UTC

NOW = dt.datetime(2026, 10, 22, 3, 40, tzinfo=UTC)
SCHEDULE = {
    "CIF_train_uid": "P28858", "atoc_code": "NT", "CIF_stp_indicator": "P",
    "schedule_segment": {"signalling_id": "3D32", "CIF_train_category": "EE", "schedule_location": [
        {"tiploc_code": "NWTNHDD", "departure": "0431"},
        {"tiploc_code": "MNCRVIC", "arrival": "0437", "departure": "0448", "platform": "4"},
        {"tiploc_code": "MNCRDST", "pass": "0449H"},
        {"tiploc_code": "CHST", "arrival": "0546"}]}}
ACTIVATION = {"train_id": "313D32M422", "train_uid": "P28858", "tp_origin_timestamp": "2026-10-22"}
ARRIVAL = {"train_id": "313D32M422", "loc_stanox": "31510", "event_type": "ARRIVAL",
           "planned_event_type": "ARRIVAL", "planned_timestamp": "1792643820000",
           "actual_timestamp": "1792643700000", "platform": " 4", "auto_expected": "true"}


class ProjectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.db = sqlite3.connect(":memory:")
        self.addCleanup(self.db.close)
        self.db.execute("CREATE TABLE locations (tiploc TEXT, crs TEXT, description TEXT, stanox TEXT)")
        self.db.executemany("INSERT INTO locations(tiploc,crs,description) VALUES (?, ?, ?)", [
            ("MNCRVIC", "MCV", "MANCHESTER VIC"), ("NWTNHDD", "XNN", "AM&EE MANCHSTR N"),
            ("CHST", "CTR", "CHESTER"), ("MNCRDST", None, "DEAL STREET")])
        self.db.execute("UPDATE locations SET stanox='31510' WHERE tiploc='MNCRVIC'")
        self.db.commit()

    def project(self, events=(), now=NOW, schedule=SCHEDULE):
        return project_train(schedule, ACTIVATION, list(events), self.db, now)

    def test_real_3d32_bst_report_matches_clock_without_double_summer_time(self):
        result = self.project([("0003", ARRIVAL)])
        self.assertEqual(result["ata"], "2026-10-22T04:35:00+01:00")
        self.assertIsNone(result["atd"])
        self.assertNotIn("etd", result)
        self.assertEqual(result["trust"]["platformSource"], "reported")
        self.assertEqual(result["trust"]["departureDirection"], "West")
        self.assertEqual(result["origin"][0]["crs"], "NWTNHDD")
        self.assertEqual(result["subsequentCallingPoints"][0]["callingPoint"][0]["crs"], "CTR")
        booked = self.project()
        self.assertEqual(booked["trust"]["platformSource"], "booked")

    def test_wrong_planned_time_offroute_and_future_reports_are_not_confirmations(self):
        for changes in [{"planned_timestamp": "1792643880000"}, {"offroute_ind": "true"},
                        {"actual_timestamp": "1792647300000"}]:
            row = self.project([("0003", {**ARRIVAL, **changes})])
            self.assertIsNone(row["ata"])
            self.assertEqual(row["trust"]["platformSource"], "booked")

    def test_passenger_reports_share_matching_and_lifecycle_guards(self):
        passenger = json.loads(json.dumps(SCHEDULE))
        passenger["schedule_segment"]["CIF_train_category"] = "OO"
        self.assertIsNone(self.project([("0003", ARRIVAL)], schedule=passenger))
        row = project_train(passenger, ACTIVATION, [("0003", ARRIVAL)], self.db, NOW, ecs_only=False)
        self.assertEqual(row["ata"], "2026-10-22T04:35:00+01:00")
        self.assertEqual(row["category"], "OO")
        for kind in ("0002", "0006", "0007", "0008"):
            self.assertIsNone(project_train(passenger, ACTIVATION, [("0003", ARRIVAL), (kind, {})], self.db, NOW, ecs_only=False))
        mismatch = {**ARRIVAL, "event_type": "DEPARTURE"}
        self.assertIsNone(self.project([("0003", mismatch)])["atd"])

    def test_passenger_calling_patterns_exclude_passes_and_operational_stops(self):
        passenger = json.loads(json.dumps(SCHEDULE))
        passenger["schedule_segment"]["CIF_train_category"] = "OO"
        stops = passenger["schedule_segment"]["schedule_location"]
        stops[-1]["public_arrival"] = "0547"
        stops.insert(-1, {"tiploc_code":"TESTST", "arrival":"0500", "departure":"0501", "public_arrival":None, "public_departure":None})
        self.db.execute("INSERT INTO locations VALUES ('TESTST','TST','OPERATIONAL STOP',NULL)")
        row = project_train(passenger, ACTIVATION, [], self.db, NOW, ecs_only=False)
        calls = row["timetableCallingPoints"][0]["callingPoint"]
        self.assertEqual([point["crs"] for point in calls], ["CTR"])
        self.assertEqual(calls[0]["st"], "2026-10-22T05:47:00+01:00")
        self.assertNotIn("et",calls[0])
        self.assertIsNone(row["ata"], "A booked pattern does not require a movement report")
        stops[-2].update(public_arrival="0000",public_departure="0501")
        pickup = project_train(passenger, ACTIVATION, [], self.db, NOW, ecs_only=False)
        self.assertEqual([point["crs"] for point in pickup["timetableCallingPoints"][0]["callingPoint"]], ["TST","CTR"])
        stops[-2]["public_departure"] = "0000"
        stops[-1]["public_arrival"] = None
        self.assertEqual(project_train(passenger, ACTIVATION, [], self.db, NOW, ecs_only=False)["timetableCallingPoints"], [])

    def test_passenger_public_call_after_midnight_keeps_next_date(self):
        passenger = json.loads(json.dumps(SCHEDULE))
        passenger["schedule_segment"]["CIF_train_category"] = "OO"
        stops = passenger["schedule_segment"]["schedule_location"]
        stops[0]["departure"] = "2350"
        stops[1].update(arrival="2355",departure="2356")
        stops[2]["pass"] = "2357"
        stops[3].update(arrival="0005",public_arrival="0006")
        row = project_train(passenger, ACTIVATION, [], self.db, dt.datetime(2026,10,22,22,56,tzinfo=UTC), ecs_only=False)
        self.assertEqual(row["timetableCallingPoints"][0]["callingPoint"][0]["st"], "2026-10-23T00:06:00+01:00")

    def test_departed_rows_expire_and_lifecycle_changes_are_withheld(self):
        departure = {**ARRIVAL, "event_type": "DEPARTURE", "planned_event_type": "DEPARTURE",
                     "planned_timestamp": "1792644480000", "actual_timestamp": "1792644480000"}
        now = dt.datetime(2026, 10, 22, 3, 50, tzinfo=UTC)
        self.assertIsNotNone(self.project([("0003", departure)], now))
        self.assertIsNone(self.project([("0003", departure)], now + dt.timedelta(minutes=4)))
        self.assertIsNone(self.project([("0002", {})]))
        self.assertIsNotNone(self.project([("0002", {}), ("0005", {})]))
        for kind in ("0006", "0007", "0008"):
            self.assertIsNone(self.project([(kind, {})]))
        self.assertIsNone(self.project([("0003", {**ARRIVAL, "correction_ind": "true"})]))
        self.assertIsNone(self.project(now=NOW + dt.timedelta(hours=2)))

    def test_midnight_rollover_winter_time_and_dst_ambiguity(self):
        overnight = json.loads(json.dumps(SCHEDULE))
        stops = overnight["schedule_segment"]["schedule_location"]
        stops[0]["departure"] = "2359H"
        stops[1].update(arrival="0002", departure="0003")
        stops[2]["pass"] = "0004"
        stops[3]["arrival"] = "0010"
        route = timed_route(overnight, "2026-12-01")
        self.assertEqual(route[1][1]["arrival"].isoformat(), "2026-12-02T00:02:00+00:00")
        planned = route[1][1]["arrival"]
        stamp = str(int(planned.timestamp() * 1000))
        self.assertEqual(reported_time({"planned_timestamp": stamp, "actual_timestamp": stamp}, planned,
                                      planned + dt.timedelta(minutes=1)), planned)
        stops[0]["departure"] = "0130"
        with self.assertRaises(ValueError):
            timed_route(overnight, "2026-10-25")

    def test_incremental_index_replay_and_stale_feed(self):
        with sqlite3.connect(self.folder / "trust.sqlite3") as raw, sqlite3.connect(":memory:") as cache:
            raw.execute("CREATE TABLE trust_batches (received_at INTEGER, payload_zlib BLOB, parse_error TEXT)")
            def insert(events):
                raw.execute("INSERT INTO trust_batches VALUES (?, ?, NULL)",
                    (int(NOW.timestamp()), zlib.compress(json.dumps(events).encode())))
                raw.commit()
            insert([{"header": {"msg_type": "0001"}, "body": ACTIVATION},
                    {"header": {"msg_type": "0003"}, "body": ARRIVAL},
                    {"header": {"msg_type": "0003"}, "body": {**ARRIVAL, "loc_stanox": "99999"}}])
            # The fixture clock differs from wall time: test index retention
            # with a controlled time source as well as the projection clock.
            from unittest.mock import patch
            with patch("trust_snapshot.time.time", return_value=NOW.timestamp()):
                index_archive(raw, cache, "31510")
                index_archive(raw, cache, "31510")
                self.assertEqual(cache.execute("SELECT count(*) FROM events").fetchone()[0], 2)
                insert([{"header": {"msg_type": "0005"}, "body": {"train_id": ACTIVATION["train_id"]}}])
                index_archive(raw, cache, "31510")
                self.assertEqual(cache.execute("SELECT count(*) FROM events").fetchone()[0], 3)
        target = sqlite3.connect(self.folder / "schedules.sqlite3")
        self.db.backup(target)
        target.executescript("""
            CREATE TABLE metadata (name TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE schedules (uid TEXT, start_date TEXT, stp TEXT, end_date TEXT,
                days TEXT, applicable TEXT, bank_holiday TEXT, payload_zlib BLOB);
        """)
        target.execute("INSERT INTO metadata VALUES ('header', ?)",
                       (json.dumps({"timestamp": int(NOW.timestamp()) - 3600}),))
        target.execute("INSERT INTO schedules VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                       ("P28858", "2026-05-18", "P", "2026-12-11", "1111100", "Y", None,
                        zlib.compress(json.dumps(SCHEDULE).encode())))
        target.commit()
        target.close()
        result = build_snapshot(self.folder, NOW)
        self.assertTrue(result["available"])
        self.assertEqual(len(result["services"]), 1)
        self.assertEqual(result["services"][0]["ata"], "2026-10-22T04:35:00+01:00")
        self.assertEqual(result["movements"][0]["reportedPlatform"], "4")
        passenger = json.loads(json.dumps(SCHEDULE))
        passenger["schedule_segment"]["CIF_train_category"] = "OO"
        passenger["schedule_segment"]["schedule_location"][-1]["public_arrival"] = "0546"
        with sqlite3.connect(self.folder / "schedules.sqlite3") as target:
            target.execute("UPDATE schedules SET payload_zlib=?", (zlib.compress(json.dumps(passenger).encode()),))
        with patch("trust_snapshot.time.time", return_value=NOW.timestamp()):
            result = build_snapshot(self.folder, NOW)
        self.assertEqual(result["services"], [], "Passenger reports must not create standalone TRUST trains")
        self.assertEqual(result["movements"][0]["ata"], "2026-10-22T04:35:00+01:00")
        self.assertEqual(result["routes"][0]["callingPoints"][0]["crs"], "CTR")
        result = build_snapshot(self.folder, NOW + dt.timedelta(minutes=4))
        self.assertFalse(result["available"])
        self.assertEqual(result["services"], [])


if __name__ == "__main__":
    unittest.main()

