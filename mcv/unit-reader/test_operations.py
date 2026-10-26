import copy
import datetime as dt
import json
import sqlite3
import tempfile
import unittest
import zlib
from pathlib import Path
from operations import build_operations
from vstp_schedules import apply_event,open_store
from test_vstp import event,NOW,STAMP

class OperationsTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.folder=Path(self.tmp.name)
        self.store=open_store(self.folder/'vstp.sqlite3');self.addCleanup(self.store.close)
        self.daily=sqlite3.connect(self.folder/'schedules.sqlite3');self.addCleanup(self.daily.close)
        self.daily.executescript('CREATE TABLE metadata(name TEXT,value TEXT); CREATE TABLE schedules(uid TEXT,start_date TEXT,stp TEXT,end_date TEXT,days TEXT,applicable TEXT,bank_holiday TEXT,payload_zlib BLOB);')
        self.daily.execute('INSERT INTO metadata VALUES (?,?)',('header',json.dumps({'timestamp':STAMP})));self.daily.commit()
        with self.store:self.store.execute("INSERT OR REPLACE INTO metadata VALUES ('heartbeat',?)",(str(STAMP),))
    def add(self,e):
        with self.store:apply_event(self.store,e,STAMP+10)
    def result(self,now=NOW):return build_operations(self.folder,now)
    def test_new_amend_divert_and_withdraw(self):
        self.add(event());r=self.result();self.assertTrue(r['vstp']['available']);self.assertEqual(r['changes'][0]['status'],'new')
        amended=event(action='Update',stamp=(STAMP+1)*1000);amended['VSTPCIFMsgV1']['schedule']['schedule_segment'][0]['schedule_location'][1]['scheduled_departure_time']='110500'
        self.add(amended);r=self.result()['changes'][0];self.assertEqual(r['status'],'amended');self.assertEqual(r['previousVictoria'][0]['departure'],'1100');self.assertEqual(r['victoria'][0]['departure'],'1105')
        self.add(event(action='Update',stamp=(STAMP+2)*1000,mcv=False));r=self.result()['changes'][0];self.assertEqual(r['status'],'removed-from-victoria');self.assertEqual(r['previousVictoria'][0]['departure'],'1105')
        self.add(event(action='Delete',stamp=(STAMP+3)*1000));r=self.result()['changes'][0];self.assertEqual(r['status'],'withdrawn');self.assertEqual(r['victoria'],[])
    def test_national_and_expired_changes_not_listed(self):
        self.add(event(mcv=False));self.assertEqual(self.result()['changes'],[])
        self.add(event(uid='X12345'));self.assertEqual(len(self.result()['changes']),1)
        self.assertEqual(self.result(NOW+dt.timedelta(days=3))['changes'],[])
    def test_stale_and_blocked_health_preserves_last_capture(self):
        self.add(event());self.assertFalse(self.result(NOW+dt.timedelta(minutes=4))['vstp']['available'])
        with self.store:self.store.execute("UPDATE metadata SET value='1' WHERE name='blocked'")
        r=self.result();self.assertTrue(r['vstp']['blocked']);self.assertFalse(r['vstp']['available']);self.assertEqual(len(r['changes']),1)
    def test_daily_cancellation_is_included_without_vstp_route(self):
        from vstp_schedules import normalize
        _,_,base=normalize(event(uid='X12345',stp='P'))
        self.daily.execute('INSERT INTO schedules VALUES (?,?,?,?,?,?,?,?)',('X12345','2026-10-26','P','2026-10-26','1000000','Y','',zlib.compress(json.dumps(base).encode())));self.daily.commit()
        cancel=event(uid='X12345',stp='C');cancel['VSTPCIFMsgV1']['schedule']['schedule_segment']=[]
        self.add(cancel);r=self.result()['changes'][0];self.assertEqual(r['status'],'cancelled');self.assertEqual(r['comparison'],'daily timetable');self.assertTrue(r['previousVictoria'])
    def test_old_store_without_audit_can_be_read(self):
        self.add(event())
        with self.store:self.store.execute('DROP TABLE vstp_changes')
        self.assertEqual(self.result()['changes'][0]['action'],'Captured')
    def test_log_is_idempotent_and_old_events_do_not_replace_it(self):
        self.add(event());self.add(event());self.add(event(stamp=(STAMP-10)*1000,action='Delete'))
        self.assertEqual(self.store.execute('SELECT count(*) FROM vstp_changes').fetchone()[0],1)
        self.assertEqual(self.store.execute('SELECT action FROM vstp_changes').fetchone()[0],'Create')

    def test_summary_is_bounded_and_log_is_transactional(self):
        for i in range(35):self.add(event(uid=f'X{i:05d}'))
        self.assertEqual(len(self.result()['changes']),30)
        with self.assertRaises(RuntimeError):
            with self.store:
                apply_event(self.store,event(uid='Y12345'),STAMP)
                raise RuntimeError('Interrupted batch')
        self.assertIsNone(self.store.execute("SELECT uid FROM vstp_changes WHERE uid='Y12345'").fetchone())
        self.assertIsNone(self.store.execute("SELECT uid FROM vstp_schedules WHERE uid='Y12345'").fetchone())

if __name__=='__main__':unittest.main()
