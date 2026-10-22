import contextlib
import io
import json
import os
import sqlite3
import tempfile
import types
import unittest
import zlib
from pathlib import Path
from unittest.mock import patch, Mock

from td_reader import open_database, persist_batch, prune, records, configuration, main as reader_main
from td_inspect import inspect
from td_setup import main as setup

NOW = 1792697400
PAYLOAD = json.dumps([{'CA_MSG':{'area_id':'ZZ','descr':'2N01','from':'0001','to':'0002','time':'1792697400000'}}]).encode()


class Message:
    def __init__(self, value=PAYLOAD, offset=1, partition=0):
        self.payload, self.offset_id, self.partition_id = value, offset, partition
    def value(self):return self.payload
    def offset(self):return self.offset_id
    def partition(self):return self.partition_id
    def topic(self):return 'TD_ALL_SIG_AREA'
    def timestamp(self):return 1, NOW*1000


class Consumer:
    def __init__(self, folder, fail=False):self.folder,self.fail,self.commits=folder,fail,0
    def commit(self, message, asynchronous):
        assert not asynchronous
        # A separate connection must see the data before broker acknowledgement.
        with sqlite3.connect(self.folder/'td.sqlite3') as other:
            assert other.execute('SELECT count(*) FROM td_batches WHERE offset_id=? AND partition_id=?',(message.offset(),message.partition())).fetchone()[0] == 1
        self.commits += 1
        if self.fail:raise RuntimeError('Commit failed')


class TDTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.folder=Path(self.temp.name);self.db=open_database(self.folder/'td.sqlite3');self.addCleanup(self.db.close)
        self.consumer=Consumer(self.folder)

    def test_durable_commit_and_duplicate_delivery(self):
        self.assertEqual(persist_batch(self.db,self.consumer,Message(),NOW),(1,False))
        persist_batch(self.db,self.consumer,Message(),NOW+1)
        row=self.db.execute('SELECT received_at,payload_zlib FROM td_batches').fetchone()
        self.assertEqual(row[0],NOW);self.assertEqual(zlib.decompress(row[1]),PAYLOAD)
        self.assertEqual(self.db.execute('SELECT count(*) FROM td_batches').fetchone()[0],1)
        self.assertEqual(self.consumer.commits,2)
        persist_batch(self.db,self.consumer,Message(partition=1),NOW)
        self.assertEqual(self.db.execute('SELECT count(*) FROM td_batches').fetchone()[0],2)

    def test_commit_failure_replays_the_persisted_batch(self):
        with self.assertRaises(RuntimeError):persist_batch(self.db,Consumer(self.folder,True),Message(),NOW)
        persist_batch(self.db,self.consumer,Message(),NOW)
        self.assertEqual(self.db.execute('SELECT count(*) FROM td_batches').fetchone()[0],1)

    def test_database_failure_never_commits(self):
        with self.db:self.db.execute('DROP TABLE td_batches')
        with self.assertRaises(sqlite3.OperationalError):persist_batch(self.db,self.consumer,Message(),NOW)
        self.assertEqual(self.consumer.commits,0)

    def test_unknown_and_malformed_envelopes_remain_inspectable(self):
        for offset,payload in enumerate((b'invalid',None,b'[123]',b'{}'),1):
            self.assertEqual(persist_batch(self.db,self.consumer,Message(payload,offset),NOW),(0,True))
        self.assertEqual(self.db.execute('SELECT count(*) FROM td_batches WHERE parse_error IS NOT NULL').fetchone()[0],4)
        self.assertEqual(self.consumer.commits,4)
        self.assertEqual(records(b'[]'),[])
        self.assertEqual(len(records(b'{"NEW_MSG":{"unknown":true}}')),1)

    def test_retention_count_and_payload_bounds(self):
        for i in range(6):persist_batch(self.db,self.consumer,Message(offset=i),NOW+i)
        self.assertEqual(prune(self.db,now=NOW+5,max_batches=2)[0],2)
        self.assertEqual([r[0] for r in self.db.execute('SELECT offset_id FROM td_batches ORDER BY offset_id')],[4,5])
        self.assertEqual(prune(self.db,now=NOW+5,max_bytes=0)[0],0)
        persist_batch(self.db,self.consumer,Message(),NOW)
        self.assertEqual(prune(self.db,now=NOW+21601)[0],0)

    def test_inspection_summarises_observed_fields_without_mapping(self):
        persist_batch(self.db,self.consumer,Message(),NOW)
        result=inspect(self.folder,headcode='2N01',now=NOW+10)
        self.assertEqual(result['messageTypes'],{'CA_MSG':1})
        self.assertEqual(result['observedAreas'],{'ZZ':1})
        self.assertEqual(result['samples'][0]['to'],'0002')
        self.assertEqual(result['lastCaptureAgeSeconds'],10)
        self.assertEqual(inspect(self.folder,area='YY',now=NOW+10)['samples'],[])
        self.assertNotIn('platform',result['samples'][0])
        self.assertNotIn('signalAspect',result['samples'][0])
        self.assertEqual(inspect(self.folder,now=NOW+10)['samples'],[])

    def test_topic_preflight_does_not_consume_or_commit(self):
        consumer=Mock()
        consumer.list_topics.return_value=types.SimpleNamespace(topics={'TD_ALL_SIG_AREA':types.SimpleNamespace(error=None,partitions={0:object()})})
        fake=types.SimpleNamespace(Consumer=Mock(return_value=consumer),KafkaException=Exception)
        with patch.dict('sys.modules',{'confluent_kafka':fake}),patch('td_reader.configuration',return_value={}),patch('sys.argv',['td_reader.py','--folder',str(self.folder),'--check']),contextlib.redirect_stdout(io.StringIO()):
            reader_main()
        consumer.list_topics.assert_called_once_with(topic='TD_ALL_SIG_AREA',timeout=20)
        consumer.subscribe.assert_not_called();consumer.poll.assert_not_called();consumer.commit.assert_not_called();consumer.close.assert_called_once()

    def test_setup_keeps_subscription_secrets_local(self):
        ca=self.folder/'ca.pem';ca.write_text('test CA')
        old_mask=os.umask(0o077)
        self.addCleanup(os.umask,old_mask)
        with patch('sys.argv',['td_setup.py','--folder',str(self.folder)]),patch('builtins.input',side_effect=['SC-example-group','example-user']),patch('getpass.getpass',return_value='example-secret'),patch('ssl.get_default_verify_paths') as paths,contextlib.redirect_stdout(io.StringIO()) as output:
            paths.return_value.cafile=str(ca);setup()
        target=self.folder/'td-kafka-config.json'
        self.assertEqual(target.stat().st_mode & 0o777,0o600)
        self.assertNotIn('example-secret',output.getvalue())
        config=configuration(self.folder)
        self.assertEqual(config['sasl.password'],'example-secret')
        self.assertEqual(config['auto.offset.reset'],'latest')
        self.assertFalse(config['enable.auto.commit'])
        self.assertFalse(config['enable.auto.offset.store'])
        self.assertEqual(config['security.protocol'],'SASL_SSL')


if __name__=='__main__':unittest.main()
