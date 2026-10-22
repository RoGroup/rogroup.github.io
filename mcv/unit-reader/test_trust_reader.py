import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
import zlib

from trust_reader import open_database, persist_batch


class Message:
    def __init__(self, payload):
        self.payload = payload

    def value(self): return self.payload
    def topic(self): return "TRAIN_MVT_ALL_TOC"
    def partition(self): return 1
    def offset(self): return 42
    def timestamp(self): return (1, 1792650574447)


class Consumer:
    def __init__(self, path, fail=False):
        self.path, self.fail, self.commits = path, fail, 0

    def commit(self, message, asynchronous):
        assert not asynchronous
        with sqlite3.connect(self.path) as observer:
            assert observer.execute("SELECT COUNT(*) FROM trust_batches").fetchone()[0] == 1
        self.commits += 1
        if self.fail:
            raise RuntimeError("Simulated offset commit failure")


class CaptureTests(unittest.TestCase):
    def test_persist_before_offset_commit_and_idempotent_replay(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "trust.sqlite3"
            db = open_database(path)
            raw = json.dumps([{"header": {"msg_type": "0003"}, "body": {
                "actual_timestamp": "1792650574000", "train_id": "203D321A22"}}]).encode()
            message = Message(raw)
            consumer = Consumer(path, fail=True)
            with self.assertRaises(RuntimeError):
                persist_batch(db, consumer, message)
            consumer.fail = False
            self.assertEqual(persist_batch(db, consumer, message), 1)
            row = db.execute("SELECT event_count, payload_zlib FROM trust_batches").fetchall()
            self.assertEqual(len(row), 1)
            self.assertEqual(row[0][0], 1)
            self.assertEqual(zlib.decompress(row[0][1]), raw)
            db.close()

    def test_invalid_batch_is_preserved_without_offset_commit(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "trust.sqlite3"
            db = open_database(path)
            consumer = Consumer(path)
            with self.assertRaises(ValueError):
                persist_batch(db, consumer, Message(b"not json"))
            self.assertEqual(consumer.commits, 0)
            row = db.execute("SELECT payload_zlib, parse_error FROM trust_batches").fetchone()
            self.assertEqual(zlib.decompress(row[0]), b"not json")
            self.assertIsNotNone(row[1])
            db.close()

    def test_empty_array_is_valid(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "trust.sqlite3"
            db = open_database(path)
            consumer = Consumer(path)
            self.assertEqual(persist_batch(db, consumer, Message(b"[]")), 0)
            self.assertEqual(consumer.commits, 1)
            db.close()


if __name__ == "__main__":
    unittest.main()
