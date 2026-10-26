import copy
import datetime as dt
import json
import sqlite3
import tempfile
import types
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch
from vstp_reader import persist, prune
from vstp_schedules import normalize, open_store, apply_event, prepare_view
from schedule_import import lookup
from trust_snapshot import build_booked_patterns, build_snapshot

NOW=dt.datetime(2026,10,26,10,tzinfo=dt.timezone.utc)
STAMP=int(NOW.timestamp())
def event(uid=' 43876',stamp=STAMP*1000,stp='N',action='Create',mcv=True):
    return {'VSTPCIFMsgV1':{'timestamp':str(stamp),'schedule':{
      'CIF_train_uid':uid,'CIF_stp_indicator':stp,'transaction_type':action,
      'schedule_start_date':'2026-10-26','schedule_end_date':'2026-10-26','schedule_days_runs':'1000000','applicable_timetable':'Y','CIF_bank_holiday_running':'',
      'schedule_segment':[{'signalling_id':'2N01','atoc_code':'NT','CIF_train_category':'OO','schedule_location':[
       {'location':{'tiploc':{'tiploc_id':'ORIGIN'}},'scheduled_departure_time':'100000','public_departure_time':'100000'},
       {'location':{'tiploc':{'tiploc_id':'MNCRVIC' if mcv else 'DIVERT'}},'scheduled_arrival_time':'105830','scheduled_departure_time':'110000','public_arrival_time':'105900','public_departure_time':'110000','CIF_platform':'5'},
       {'location':{'tiploc':{'tiploc_id':'CHST'}},'scheduled_arrival_time':'120000','public_arrival_time':'120000'}]}]}}}
class Message:
    def __init__(self,body,offset=1):self.body=body;self.off=offset
    def topic(self):return 'VSTP_TEST'
    def partition(self):return 0
    def offset(self):return self.off
    def value(self):return json.dumps(self.body).encode()

class VSTPTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup);self.folder=Path(self.temp.name)
        self.store=open_store(self.folder/'vstp.sqlite3');self.addCleanup(self.store.close)
        self.db=sqlite3.connect(self.folder/'schedules.sqlite3');self.addCleanup(self.db.close)
        self.db.executescript('''CREATE TABLE metadata(name TEXT,value TEXT);
          CREATE TABLE schedules(uid TEXT,start_date TEXT,stp TEXT,end_date TEXT,days TEXT,applicable TEXT,bank_holiday TEXT,payload_zlib BLOB);
          CREATE TABLE locations(tiploc TEXT,stanox TEXT,crs TEXT,description TEXT);''')
        self.db.execute('INSERT INTO metadata VALUES (\'header\',?)',(json.dumps({'timestamp':STAMP}),))
        self.db.executemany('INSERT INTO locations VALUES (?,?,?,?)',[('MNCRVIC','31510','MCV','Manchester Victoria'),('CHST','40000','CTR','Chester'),('ORIGIN','31500','ORG','Origin')]);self.db.commit()
        self.consumer=types.SimpleNamespace(commit=self.commit)
        self.commits=0
    def commit(self,message,asynchronous):
        self.assertFalse(asynchronous)
        with sqlite3.connect(self.folder/'vstp.sqlite3') as db:
            self.assertEqual(db.execute('SELECT count(*) FROM vstp_batches WHERE offset_id=?',(message.offset(),)).fetchone()[0],1)
        self.commits+=1
    def add(self,e=None,offset=1):
        persist(self.store,self.consumer,Message(e or event(),offset),STAMP)
        with self.store:self.store.execute("INSERT OR REPLACE INTO metadata VALUES ('heartbeat',?)",(str(STAMP),))
    def view(self):
        db=sqlite3.connect((self.folder/'schedules.sqlite3').as_uri()+'?mode=ro',uri=True);self.addCleanup(db.close)
        prepare_view(db,self.folder,NOW);return db
    def test_normalizes_nested_route_numeric_uid_and_half_minute(self):
        key,_,s=normalize(event());self.assertEqual(key,('43876','2026-10-26','N'))
        self.assertEqual(s['schedule_segment']['schedule_location'][1]['arrival'],'1058H')
        self.assertEqual(s['schedule_segment']['schedule_location'][1]['public_arrival'],'1059')
    def test_durable_and_duplicate_replay(self):
        self.add();persist(self.store,self.consumer,Message(event()),STAMP+1)
        self.assertEqual(self.commits,2);self.assertEqual(self.store.execute("SELECT value FROM metadata WHERE name='revision'").fetchone()[0],'1')
    def test_commit_failure_replay_is_idempotent(self):
        bad=types.SimpleNamespace(commit=lambda **kw:(_ for _ in ()).throw(RuntimeError()))
        with self.assertRaises(RuntimeError):persist(self.store,bad,Message(event()),STAMP)
        persist(self.store,self.consumer,Message(event()),STAMP)
        self.assertEqual(self.store.execute('SELECT count(*) FROM vstp_schedules').fetchone()[0],1)
    def test_database_failure_does_not_ack(self):
        with self.store:self.store.execute('DROP TABLE vstp_schedules')
        with self.assertRaises(sqlite3.OperationalError):persist(self.store,self.consumer,Message(event()),STAMP)
        self.assertEqual(self.commits,0)
    def test_unknown_message_quarantines_and_does_not_ack(self):
        with self.assertRaises(ValueError):self.add({'unexpected':True})
        self.assertEqual(self.commits,0)
        with self.assertRaises(ValueError):self.view()
        self.assertIsNotNone(self.store.execute('SELECT error FROM vstp_batches').fetchone()[0])
    def test_batch_is_atomic_when_later_event_invalid(self):
        with self.assertRaises(ValueError):self.add([event(),{'bad':True}])
        self.assertEqual(self.store.execute('SELECT count(*) FROM vstp_schedules').fetchone()[0],0)
    def test_newer_update_wins_and_old_delivery_cannot_resurrect(self):
        self.add();self.add(event(stamp=STAMP*1000+1,action='Update',mcv=False),2)
        self.add(event(stamp=STAMP*1000-1),3)
        self.assertEqual(lookup(self.view(),'43876','2026-10-26')['status'],'does-not-visit-mcv')
    def test_delete_tombstone_blocks_replayed_create(self):
        self.add();self.add(event(stamp=STAMP*1000+1,action='Delete'),2);self.add(event(),3)
        self.assertEqual(lookup(self.view(),'43876','2026-10-26')['status'],'not-found')
    def test_same_timestamp_conflict_blocks_projection(self):
        self.add()
        with self.assertRaises(ValueError):self.add(event(mcv=False),2)
        with self.assertRaises(ValueError):self.view()
    def test_multisegment_is_quarantined_instead_of_concatenated(self):
        e=event();e['VSTPCIFMsgV1']['schedule']['schedule_segment']*=2
        with self.assertRaises(ValueError):self.add(e)
    def test_overlay_cancellation_diversion_and_daily_database_untouched(self):
        _,_,s=normalize(event(uid='P12345'))
        self.db.execute('INSERT INTO schedules VALUES (?,?,?,?,?,?,?,?)',('P12345','2026-10-01','P','2026-12-01','1111111','Y','',zlib.compress(json.dumps(s).encode())));self.db.commit()
        original=(self.folder/'schedules.sqlite3').read_bytes()
        self.add(event(uid='P12345',stp='O',mcv=False))
        self.assertEqual(lookup(self.view(),'P12345','2026-10-26')['status'],'does-not-visit-mcv')
        cancellation=event(uid='P12345',stp='C');cancellation['VSTPCIFMsgV1']['schedule']['schedule_segment']=[]
        self.add(cancellation,2);self.assertEqual(lookup(self.view(),'P12345','2026-10-26')['status'],'cancelled')
        self.assertEqual(original,(self.folder/'schedules.sqlite3').read_bytes())
    def test_stale_vstp_does_not_restore_superseded_base(self):
        self.add()
        with self.store:self.store.execute("UPDATE metadata SET value=? WHERE name='heartbeat'",(str(STAMP-181),))
        self.assertEqual(lookup(self.view(),'43876','2026-10-26')['status'],'does-not-visit-mcv')
    def test_daily_replacement_does_not_remove_vstp(self):
        self.add();self.db.close();replacement=self.folder/'replacement.sqlite3'
        with sqlite3.connect(replacement) as db:db.execute('CREATE TABLE schedules(uid,start_date,stp,end_date,days,applicable,bank_holiday,payload_zlib)')
        replacement.replace(self.folder/'schedules.sqlite3')
        self.assertEqual(lookup(self.view(),'43876','2026-10-26')['status'],'scheduled')
    def test_booked_pattern_matches_numeric_uid_public_pair_and_no_trust(self):
        self.add();service={'uid':' 43876','trainid':'2N01','sdd':'2026-10-26','sta':'2026-10-26T10:59:00+00:00','std':'2026-10-26T11:00:00+00:00'}
        result=build_booked_patterns(self.folder,[service],NOW)
        self.assertEqual(result['routes'][0]['uid'],'43876');self.assertEqual(result['routes'][0]['callingPoints'][0]['crs'],'CTR')
        self.assertEqual(build_booked_patterns(self.folder,[{**service,'std':'2026-10-26T11:01:00+00:00'}],NOW)['routes'],[])
    def test_activated_numeric_uid_routes_and_deletion_invalidate_history(self):
        self.add()
        with sqlite3.connect(self.folder/'trust.sqlite3') as db:
            db.execute('CREATE TABLE trust_batches(received_at INTEGER,payload_zlib BLOB,parse_error TEXT)')
            activation={'header':{'msg_type':'0001'},'body':{'train_id':'312N01M426','train_uid':' 43876','tp_origin_timestamp':'2026-10-26','schedule_source':'V'}}
            db.execute('INSERT INTO trust_batches VALUES (?,?,NULL)',(STAMP,zlib.compress(json.dumps([activation]).encode())))
        result=build_snapshot(self.folder,NOW)
        self.assertTrue(result['available']);self.assertEqual(result['routes'][0]['uid'],'43876')
        self.add(event(stamp=STAMP*1000+1,action='Delete'),2)
        removed=build_snapshot(self.folder,NOW)
        self.assertEqual(removed['routes'],[]);self.assertEqual(removed['histories'],[])

    def test_revision_changes_on_update_for_history_reindex(self):
        self.add();a=self.view();first=dict(a.execute('SELECT name,value FROM vstp.metadata'))['revision'];a.close()
        self.add(event(stamp=STAMP*1000+1,action='Delete'),2)
        b=self.view();self.assertNotEqual(first,dict(b.execute('SELECT name,value FROM vstp.metadata'))['revision'])
    def test_raw_retention_is_bounded(self):
        self.add();prune(self.store,STAMP+4*86400)
        self.assertEqual(self.store.execute('SELECT count(*) FROM vstp_batches').fetchone()[0],0)
    def config(self):
        (self.folder/'vstp-kafka-config.json').write_text(json.dumps({'topic':'VSTP_TEST','group.id':'example-vstp','sasl.username':'example','sasl.password':'example-test'}))

    def test_metadata_preflight_does_not_consume_or_commit(self):
        from unittest.mock import Mock
        from vstp_reader import main
        self.config();consumer=Mock()
        consumer.list_topics.return_value=types.SimpleNamespace(topics={'VSTP_TEST':types.SimpleNamespace(error=None,partitions={0:object()})})
        fake=types.SimpleNamespace(Consumer=Mock(return_value=consumer))
        with patch.dict('sys.modules',{'confluent_kafka':fake}),patch('sys.argv',['vstp_reader','--check','--folder',str(self.folder)]):main()
        consumer.subscribe.assert_not_called();consumer.poll.assert_not_called();consumer.commit.assert_not_called();consumer.close.assert_called_once()

    def test_expired_offsets_block_instead_of_silently_skipping(self):
        from unittest.mock import Mock
        from vstp_reader import main
        self.config();consumer=Mock()
        consumer.committed.return_value=[types.SimpleNamespace(topic='VSTP_TEST',partition=0,offset=50)]
        consumer.get_watermark_offsets.return_value=(100,200)
        consumer.subscribe.side_effect=lambda topics,on_assign:on_assign(consumer,[])
        fake=types.SimpleNamespace(Consumer=Mock(return_value=consumer),TopicPartition=lambda *args:args)
        with patch.dict('sys.modules',{'confluent_kafka':fake}),patch('signal.signal'),patch('sys.argv',['vstp_reader','--folder',str(self.folder)]):
            with self.assertRaisesRegex(SystemExit,'offset expired'):main()
        consumer.poll.assert_not_called();consumer.commit.assert_not_called()
        self.assertEqual(self.store.execute("SELECT value FROM metadata WHERE name='blocked'").fetchone()[0],'1')

    def test_invalid_seconds_and_future_data_do_not_become_routes(self):
        e=event();e['VSTPCIFMsgV1']['schedule']['schedule_segment'][0]['schedule_location'][0]['scheduled_departure_time']='100015'
        with self.assertRaises(ValueError):normalize(e)
        with self.assertRaises(ValueError):self.add(event(stamp=(STAMP+301)*1000))

if __name__=='__main__':unittest.main()
