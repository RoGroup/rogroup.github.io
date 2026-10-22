import datetime as dt
import json
import sqlite3
import tempfile
import unittest
import zlib
from pathlib import Path

from trust_snapshot import build_booked_patterns, build_snapshot, index_archive, index_history_archive, project_history, project_train, timed_route, reported_time, UTC

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

    def history_report(self, tiploc, field, delay=0):
        self.db.execute("UPDATE locations SET stanox=? WHERE tiploc=?", ({"NWTNHDD":"31500","MNCRVIC":"31510","MNCRDST":"31511","CHST":"40000"}[tiploc],tiploc))
        planned = next(times[field] for stop,times in timed_route(SCHEDULE,ACTIVATION["tp_origin_timestamp"]) if stop["tiploc_code"] == tiploc)
        encoded = int(planned.replace(tzinfo=UTC).timestamp()*1000)
        return {"train_id":ACTIVATION["train_id"],"loc_stanox":{"NWTNHDD":"31500","MNCRVIC":"31510","MNCRDST":"31511","CHST":"40000"}[tiploc],
            "event_type":field.upper(),"planned_event_type":field.upper(),"planned_timestamp":str(encoded),"actual_timestamp":str(encoded+delay*1000),"platform":"4"}

    def history(self, rows, now=None):
        now = now or dt.datetime(2026,10,22,3,52,tzinfo=UTC)
        events = [(kind,body,int(NOW.timestamp())) for kind,body in rows]
        return project_history(SCHEDULE,ACTIVATION,events,self.db,now)

    def test_journey_history_matches_origin_victoria_and_passing_reports(self):
        origin = self.history_report("NWTNHDD","departure")
        origin["planned_event_type"] = "ORIGIN"
        departure = self.history_report("MNCRVIC","departure",60)
        passed = self.history_report("MNCRDST","pass",60)
        row = self.history([("0001",ACTIVATION),("0003",origin),("0003",ARRIVAL),("0003",departure),("0003",passed),("0003",passed)])
        actual = [event for event in row["events"] if event["timeBasis"] == "actual"]
        self.assertEqual(len(actual),4,"Duplicate delivery must not duplicate a movement")
        self.assertEqual(actual[-1]["tiploc"],"MNCRDST")
        self.assertEqual(actual[-1]["at"],"2026-10-22T03:50:30+00:00")
        self.assertEqual(actual[-1]["delaySeconds"],60)
        self.assertEqual([event["kind"] for event in actual if event["tiploc"] == "MNCRVIC"],["arrival","departure"])

    def test_history_keeps_lifecycle_messages_without_inventing_route_after_change(self):
        arrival = self.history_report("MNCRVIC","arrival")
        passed = self.history_report("MNCRDST","pass")
        row = self.history([("0003",arrival),("0002",{"train_id":ACTIVATION["train_id"]}),("0005",{"train_id":ACTIVATION["train_id"]}),("0006",{"train_id":ACTIVATION["train_id"]}),("0003",passed)])
        kinds = [event["kind"] for event in row["events"]]
        self.assertIn("cancellation",kinds)
        self.assertIn("reinstatement",kinds)
        self.assertIn("origin-change",kinds)
        self.assertNotIn("pass",kinds)
        self.assertTrue(row["reconciliationRequired"])
        self.assertTrue(all(event["timeBasis"] == "received" for event in row["events"] if event["kind"] != "arrival"))

    def test_history_withholds_corrected_future_offroute_and_wrong_planned_reports(self):
        arrival = self.history_report("MNCRVIC","arrival")
        row = self.history([("0001",ACTIVATION),("0003",arrival),("0003",{**arrival,"correction_ind":"true"})])
        self.assertFalse(any(event["timeBasis"] == "actual" for event in row["events"]))
        self.assertTrue(row["reconciliationRequired"])
        for changes in ({"offroute_ind":"true"},{"planned_timestamp":"0"},{"actual_timestamp":str(int(arrival["actual_timestamp"])+3600000)},{"route":"F"}):
            row = self.history([("0001",ACTIVATION),("0003",{**arrival,**changes})])
            self.assertFalse(any(event["timeBasis"] == "actual" for event in row["events"]))

    def test_history_index_replays_related_movements_before_activation_and_refreshes(self):
        origin = self.history_report("NWTNHDD","departure")
        self.db.execute("CREATE TABLE schedules(uid TEXT,payload_zlib BLOB)")
        self.db.execute("INSERT INTO schedules VALUES ('P28858',X'00')")
        raw,cache = sqlite3.connect(":memory:"),sqlite3.connect(":memory:")
        self.addCleanup(raw.close);self.addCleanup(cache.close)
        raw.execute("CREATE TABLE trust_batches(received_at INTEGER,payload_zlib BLOB,parse_error TEXT)")
        def add(events):
            raw.execute("INSERT INTO trust_batches VALUES (?,?,NULL)",(int(NOW.timestamp()),zlib.compress(json.dumps(events).encode())))
            raw.commit()
        add([{"header":{"msg_type":"0003"},"body":origin}])
        add([{"header":{"msg_type":"0001"},"body":ACTIVATION},
             {"header":{"msg_type":"0003"},"body":ARRIVAL},
             {"header":{"msg_type":"0001"},"body":{**ACTIVATION,"train_id":"XX2N00XX22","train_uid":"P99999"}},
             {"header":{"msg_type":"0003"},"body":{**origin,"train_id":"XX2N00XX22"}}])
        for _ in range(2):
            index_history_archive(raw,cache,self.db,1,NOW)
            self.assertEqual(cache.execute("SELECT count(*) FROM events WHERE kind='0003'").fetchone()[0],2)
        add([{"header":{"msg_type":"0003"},"body":origin}])
        index_history_archive(raw,cache,self.db,2,NOW)
        self.assertEqual(cache.execute("SELECT count(*) FROM events WHERE kind='0003'").fetchone()[0],3)
        raw.execute("DELETE FROM trust_batches");raw.commit()
        with self.assertRaises(ValueError):
            index_history_archive(raw,cache,self.db,2,NOW)

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
        self.assertEqual(len(result["histories"]), 1)
        self.assertEqual(build_snapshot(self.folder,NOW,services=[])["histories"], [])
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



class BookedPatternTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name)
        self.db = sqlite3.connect(self.folder / "schedules.sqlite3")
        self.addCleanup(self.db.close)
        self.db.executescript("""CREATE TABLE metadata(name TEXT,value TEXT);
            CREATE TABLE locations(tiploc TEXT,crs TEXT,description TEXT);
            CREATE TABLE schedules(uid TEXT,stp TEXT,start_date TEXT,end_date TEXT,days TEXT,applicable TEXT,bank_holiday TEXT,payload_zlib BLOB);""")
        self.db.execute("INSERT INTO metadata VALUES ('header',?)", (json.dumps({"timestamp": int(NOW.timestamp())}),))
        self.db.executemany("INSERT INTO locations VALUES (?,?,?)", [("ORIGIN","ORG","Origin"),("MNCRVIC","MCV","Manchester Victoria"),("PASSING","PAS","Passing"),("OPERATE","OPR","Operational"),("CHST","CTR","Chester")])
        self.schedule = {"CIF_train_uid":"P28858","schedule_segment":{"signalling_id":"2N01","CIF_train_category":"OO","schedule_location":[
            {"tiploc_code":"ORIGIN","departure":"0900","public_departure":"0900"},
            {"tiploc_code":"MNCRVIC","arrival":"0958","departure":"1000","public_arrival":"0958","public_departure":"1000"},
            {"tiploc_code":"PASSING","pass":"1015","public_arrival":"1015"},
            {"tiploc_code":"OPERATE","arrival":"1030","departure":"1031","public_arrival":"0000","public_departure":"0000"},
            {"tiploc_code":"CHST","arrival":"1130","public_arrival":"1130"}]}}
        self.service = {"uid":"P28858","trainid":"2N01","sdd":"2026-10-22","sta":"2026-10-22T09:58:00","std":"2026-10-22T10:00:00","destination":[{"crs":"CTR"}]}
        self.save()

    def save(self, stp='P', payload=True, holiday=''):
        self.db.execute("INSERT INTO schedules VALUES ('P28858',?,'2026-10-01','2026-12-01','1111111','Y',?,?)", (stp,holiday,zlib.compress(json.dumps(self.schedule).encode()) if payload else None))
        self.db.commit()

    def build(self, services=None, now=NOW):
        return build_booked_patterns(self.folder, [self.service] if services is None else services, now)

    def test_later_service_without_trust_activation_and_public_calls_only(self):
        self.assertFalse((self.folder / "trust.sqlite3").exists())
        result = self.build()
        self.assertTrue(result['available'])
        self.assertEqual(len(result['routes']),1)
        route = result['routes'][0]
        self.assertEqual([p['crs'] for p in route['callingPoints']],['CTR'])
        self.assertEqual(route['callingPoints'][0]['st'],'2026-10-22T11:30:00+01:00')
        self.assertNotIn('ata',route)
        self.assertNotIn('platform',route)

    def test_wrong_identity_booked_times_and_live_pattern_are_withheld(self):
        for change in ({'uid':'P99999'},{'trainid':'2N02'},{'sdd':'2026-10-23'},{'sta':'2026-10-22T09:59:00'},{'std':'2026-10-22T10:01:00'},
                       {'isCancelled':True},{'futureCancellation':True},{'diversion':True},{'isPassengerService':False},
                       {'subsequentLocations':[{'crs':'CTR'}]},{'subsequentCallingPoints':[{'callingPoint':[{'crs':'CTR'}]}]}):
            self.assertEqual(self.build([{**self.service,**change}])['routes'],[],str(change))
        self.assertEqual(self.build([self.service,self.service])['routes'],[])
        self.assertEqual(len(self.build([{**self.service,'sta':'2026-10-22T08:58:00Z','std':'2026-10-22T09:00:00Z'}])['routes']),1)

    def test_public_and_working_pairs_match_without_time_tolerance(self):
        stop=self.schedule['schedule_segment']['schedule_location'][1]
        stop.update(arrival='0957H',public_arrival='0958',departure='1001',public_departure='1000')
        self.db.execute('DELETE FROM schedules');self.save()
        public=self.build()['routes'][0]
        self.assertEqual(public['sta'],'2026-10-22T09:58:00+01:00')
        self.assertEqual(public['std'],'2026-10-22T10:00:00+01:00')
        working=self.build([{**self.service,'sta':'2026-10-22T09:57:00','std':'2026-10-22T10:01:00'}])['routes'][0]
        self.assertEqual(working['sta'],'2026-10-22T09:57:30+01:00')
        self.assertEqual(working['std'],'2026-10-22T10:01:00+01:00')
        for change in ({'sta':'2026-10-22T09:59:00'},{'std':'2026-10-22T10:02:00'},
                       {'sta':'2026-10-22T09:57:00'},{'std':'2026-10-22T10:01:00'}):
            self.assertEqual(self.build([{**self.service,**change}])['routes'],[],str(change))
        # A public departure just before midnight retains its operating date,
        # even when its working departure is just after midnight.
        stop.update(arrival='2358H',public_arrival='2359',departure='0001',public_departure='2359')
        stops=self.schedule['schedule_segment']['schedule_location']
        stops[0]['departure']='2300';stops[2]['pass']='0015';stops[3].update(arrival='0030',departure='0031')
        stops[4].update(arrival='0130',public_arrival='0130')
        self.db.execute('DELETE FROM schedules');self.save()
        service={**self.service,'sta':'2026-10-22T23:59:00','std':'2026-10-22T23:59:00'}
        pattern=self.build([service],now=NOW+dt.timedelta(hours=8))['routes'][0]
        self.assertEqual(pattern['std'],'2026-10-22T23:59:00+01:00')
        self.assertEqual(pattern['callingPoints'][-1]['st'],'2026-10-23T01:30:00+01:00')

    def test_stale_timetable_cancelled_overlay_and_ambiguous_schedules(self):
        self.assertFalse(self.build(now=NOW+dt.timedelta(hours=37))['available'])
        for stp,payload,holiday in [('C',False,''),('O',False,''),('P',True,''),('O',True,'X')]:
            self.save(stp,payload,holiday)
            self.assertEqual(self.build()['routes'],[])
            self.db.execute("DELETE FROM schedules WHERE rowid=(SELECT max(rowid) FROM schedules)")
            self.db.commit()

    def test_origin_date_and_midnight_are_preserved(self):
        stops = self.schedule['schedule_segment']['schedule_location']
        stops[0]['departure']='2300'
        stops[1].update(arrival='2358',departure='2359')
        stops[2]['pass']='0015';stops[3].update(arrival='0030',departure='0031')
        stops[4].update(arrival='0130',public_arrival='0130')
        self.db.execute('DELETE FROM schedules');self.save()
        service={**self.service,'sta':'2026-10-22T23:58:00','std':'2026-10-22T23:59:00'}
        result=self.build([service],now=NOW+dt.timedelta(hours=8))
        self.assertEqual(result['routes'][0]['callingPoints'][0]['st'],'2026-10-23T01:30:00+01:00')
        self.assertEqual(result['routes'][0]['sdd'],'2026-10-22')

if __name__ == "__main__":
    unittest.main()
