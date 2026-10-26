import copy
import datetime as dt
import json
import sqlite3
import tempfile
import unittest
import zlib
from pathlib import Path
from trust_snapshot import build_booked_patterns, build_snapshot, project_train, timed_route, match_booked_visit, UTC

NOW=dt.datetime(2026,10,26,15,13,tzinfo=UTC)
SCHEDULE={'CIF_train_uid':'N03290','atoc_code':'TP','schedule_segment':{'signalling_id':'5P31','CIF_train_category':'EE','schedule_location':[
 {'tiploc_code':'MNCRVIC','departure':'1522','platform':'3'},
 {'tiploc_code':'MNCRVRS','arrival':'1525','departure':'1534'},
 {'tiploc_code':'MNCRVIC','arrival':'1537','platform':'3'}]}}
BASE={'uid':'N03290','trainid':'5P31','sdd':'2026-10-26','isPassengerService':False,'category':'EE','destination':[{'crs':'MCV'}]}
OUT={**BASE,'std':'2026-10-26T15:22:00'}
BACK={**BASE,'sta':'2026-10-26T15:37:00'}
ACTIVATION={'train_id':'315P31IQ26','train_uid':'N03290','tp_origin_timestamp':'2026-10-26'}
class TurnbackTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.folder=Path(self.temp.name)
        self.db=sqlite3.connect(self.folder/'schedules.sqlite3');self.addCleanup(self.db.close)
        self.db.executescript('''CREATE TABLE metadata(name TEXT,value TEXT);
        CREATE TABLE locations(tiploc TEXT,crs TEXT,description TEXT,stanox TEXT);
        CREATE TABLE schedules(uid TEXT,start_date TEXT,stp TEXT,end_date TEXT,days TEXT,applicable TEXT,bank_holiday TEXT,payload_zlib BLOB);''')
        self.db.execute('INSERT INTO metadata VALUES (\'header\',?)',(json.dumps({'timestamp':int(NOW.timestamp())}),))
        self.db.executemany('INSERT INTO locations VALUES (?,?,?,?)',[('MNCRVIC','MCV','Manchester Victoria','31510'),('MNCRVRS','XVR','Manchester Victoria West Turnback','31511')])
        self.save(SCHEDULE)
    def save(self,schedule):
        self.db.execute('DELETE FROM schedules');self.db.execute('INSERT INTO schedules VALUES (?,?,?,?,?,?,?,?)',('N03290','2026-10-26','N','2026-10-30','1111100','Y','',zlib.compress(json.dumps(schedule).encode())));self.db.commit()
    def build(self,rows):return build_booked_patterns(self.folder,rows,NOW)
    def test_outbound_and_return_select_their_own_booked_visits(self):
        routes=self.build([OUT,BACK])['routes'];self.assertEqual(len(routes),2)
        out,back=routes
        self.assertEqual([p['tiploc'] for p in out['callingPoints']],['MNCRVRS','MNCRVIC'])
        self.assertEqual(out['callingPoints'][0]['st'],'2026-10-26T15:25:00+00:00')
        self.assertEqual(out['callingPoints'][1]['st'],'2026-10-26T15:37:00+00:00')
        self.assertIsNone(out['sta']);self.assertIsNone(back['std'])
        self.assertEqual(back['callingPoints'],[]);self.assertEqual([p['tiploc'] for p in back['previousCallingPoints']],['MNCRVIC','MNCRVRS'])
    def test_duplicate_wrong_time_live_pattern_and_alteration_guards(self):
        self.assertEqual(len(self.build([OUT,OUT,BACK])['routes']),1)
        for extra in [{'std':'2026-10-26T15:23:00'},{'isCancelled':True},{'affectedByDiversion':True},{'subsequentLocations':[{'crs':'MCV'}]}]:
            self.assertEqual(self.build([{**OUT,**extra}])['routes'],[])
    def test_each_activated_visit_has_distinct_identity_and_reports(self):
        route=timed_route(SCHEDULE,'2026-10-26');planned=route[0][1]['departure'];actual=planned+dt.timedelta(seconds=30)
        report=('0003',{'loc_stanox':'31510','event_type':'DEPARTURE','planned_event_type':'ORIGIN','planned_timestamp':str(int(planned.timestamp()*1000)),'actual_timestamp':str(int(actual.timestamp()*1000))})
        now=dt.datetime(2026,10,26,15,23,tzinfo=UTC)
        out=project_train(SCHEDULE,ACTIVATION,[report],self.db,now,visit_index=0)
        back=project_train(SCHEDULE,ACTIVATION,[report],self.db,now,visit_index=2)
        self.assertNotEqual(out['serviceID'],back['serviceID']);self.assertIsNotNone(out['atd']);self.assertIsNone(back['ata']);self.assertIsNone(back['atd'])
        self.assertEqual(out['trust']['departureDirection'],'West')
    def test_activated_snapshot_retains_both_ecs_visits(self):
        with sqlite3.connect(self.folder/'trust.sqlite3') as raw:
            raw.execute('CREATE TABLE trust_batches(received_at INTEGER,payload_zlib BLOB,parse_error TEXT)')
            raw.execute('INSERT INTO trust_batches VALUES (?,?,NULL)',(int(NOW.timestamp()),zlib.compress(json.dumps([{'header':{'msg_type':'0001'},'body':ACTIVATION}]).encode())))
        result=build_snapshot(self.folder,NOW)
        self.assertEqual(len(result['services']),2);self.assertEqual(len(result['histories']),2)
        self.assertEqual(len({r['serviceID'] for r in result['services']}),2)
    def test_non_ecs_circular_route_stays_withheld(self):
        s=copy.deepcopy(SCHEDULE);s['schedule_segment']['CIF_train_category']='OO';self.save(s)
        self.assertEqual(self.build([{**OUT,'category':'OO','isPassengerService':True}])['routes'],[])
    def test_same_clock_at_two_visits_is_not_guessed(self):
        route=timed_route(SCHEDULE,'2026-10-26');route.append((route[0][0],route[0][1]))
        self.assertIsNone(match_booked_visit(route,OUT))
if __name__=='__main__':unittest.main()
