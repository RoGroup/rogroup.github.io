"""Capture TD Kafka data before acknowledging it; no geographic inference."""
import argparse
import json
import os
import signal
import sqlite3
import time
import zlib
from pathlib import Path

TOPIC = 'TD_ALL_SIG_AREA'
DEFAULT_FOLDER = Path('/opt/mcv-td-reader')
RETENTION_SECONDS = 6 * 3600
MAX_BATCHES = 100000
MAX_PAYLOAD_BYTES = 512 * 1024 * 1024


def open_database(path):
    db = sqlite3.connect(path, timeout=30)
    db.execute('PRAGMA journal_mode=WAL')
    db.execute('PRAGMA synchronous=FULL')
    db.execute('PRAGMA journal_size_limit=16777216')
    db.execute('''CREATE TABLE IF NOT EXISTS td_batches (
        topic TEXT NOT NULL, partition_id INTEGER NOT NULL, offset_id INTEGER NOT NULL,
        received_at INTEGER NOT NULL, broker_timestamp_ms INTEGER, event_count INTEGER,
        payload_zlib BLOB NOT NULL, parse_error TEXT,
        PRIMARY KEY(topic, partition_id, offset_id))''')
    db.execute('CREATE INDEX IF NOT EXISTS td_received ON td_batches(received_at)')
    db.commit()
    return db


def records(payload):
    value = json.loads(payload)
    if isinstance(value, dict) and value:
        return [value]
    if isinstance(value, list) and all(isinstance(item, dict) and item for item in value):
        return value
    raise ValueError('Unexpected TD envelope')


def persist_batch(db, consumer, message, now=None):
    payload = message.value()
    error, count = None, None
    try:
        count = len(records(payload))
    except (ValueError, UnicodeError, TypeError):
        error = 'unrecognised-json-envelope'
    # Retain malformed/unknown data as well: inspection must not discard it or
    # block the national stream forever. No berth state is derived here.
    stamp = message.timestamp()[1]
    with db:
        db.execute('''INSERT INTO td_batches VALUES (?,?,?,?,?,?,?,?)
            ON CONFLICT(topic,partition_id,offset_id) DO NOTHING''',
            (message.topic(), message.partition(), message.offset(), int(now if now is not None else time.time()),
             stamp if stamp is not None and stamp >= 0 else None, count,
             zlib.compress(payload if payload is not None else b'', 3), error))
    consumer.commit(message=message, asynchronous=False)
    return count or 0, bool(error)


def prune(db, now=None, max_bytes=MAX_PAYLOAD_BYTES, max_batches=MAX_BATCHES):
    cutoff = int(now if now is not None else time.time()) - RETENTION_SECONDS
    with db:
        db.execute('DELETE FROM td_batches WHERE received_at < ?', (cutoff,))
        # Newest first; rowid breaks ties in receipt timestamps deterministically.
        total, keep = 0, []
        for rowid, length in db.execute('SELECT rowid,length(payload_zlib) FROM td_batches ORDER BY received_at DESC,rowid DESC'):
            if len(keep) >= max_batches or total + length > max_bytes:
                break
            total += length
            keep.append(rowid)
        if not keep:
            db.execute('DELETE FROM td_batches')
        else:
            oldest = db.execute('SELECT received_at FROM td_batches WHERE rowid=?', (keep[-1],)).fetchone()[0]
            db.execute('DELETE FROM td_batches WHERE received_at < ? OR (received_at=? AND rowid<?)', (oldest, oldest, keep[-1]))
    return len(keep), total


def configuration(folder):
    config = json.loads((folder / 'td-kafka-config.json').read_text())
    required = ('bootstrap.servers', 'group.id', 'sasl.username', 'sasl.password', 'ssl.ca.location')
    if any(not isinstance(config.get(key), str) or not config[key].strip() for key in required):
        raise ValueError('TD configuration is incomplete; run td_setup.py')
    config.update({'security.protocol':'SASL_SSL', 'sasl.mechanisms':'PLAIN',
                   'enable.auto.commit':False, 'enable.auto.offset.store':False,
                   'auto.offset.reset':'latest', 'allow.auto.create.topics':False,
                   'queued.max.messages.kbytes':4096, 'log_level':3})
    return config


def kafka_error_name(error):
    # Do not put credentials or connection strings into application exceptions.
    try:
        return error.args[0].name()
    except (AttributeError, IndexError):
        return type(error).__name__


def main():
    from confluent_kafka import Consumer, KafkaException
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--folder', type=Path, default=DEFAULT_FOLDER)
    parser.add_argument('--check', action='store_true', help='Check topic metadata without consuming or committing')
    args = parser.parse_args()
    os.umask(0o077)
    consumer = Consumer(configuration(args.folder))
    if args.check:
        try:
            metadata = consumer.list_topics(topic=TOPIC, timeout=20)
            topic = metadata.topics.get(TOPIC)
            if topic is None or not topic.partitions and not topic.error:
                raise SystemExit('TD topic was not returned with partitions; verify the TD subscription credentials')
            if topic.error:
                raise KafkaException(topic.error)
            print(f'TD topic metadata available; {len(topic.partitions)} partitions. Consumption/group access is checked when the reader starts.')
        except Exception as error:
            raise SystemExit('TD topic check failed: '+kafka_error_name(error)) from None
        finally:
            consumer.close()
        return
    db = open_database(args.folder / 'td.sqlite3')
    running = True
    def stop(*_):
        nonlocal running
        running = False
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    batches = events = malformed = 0
    last_report = last_prune = time.monotonic()
    try:
        # Prune old captures immediately after downtime, and once a minute.
        prune(db)
        consumer.subscribe([TOPIC])
        print('TD capture started; initial offset is latest if this group has no saved offset. Raw capture only; no mapped positions yet.', flush=True)
        while running:
            message = consumer.poll(1)
            if message is not None:
                if message.error():
                    raise KafkaException(message.error())
                count, bad = persist_batch(db, consumer, message)
                batches += 1; events += count; malformed += int(bad)
            tick = time.monotonic()
            if tick-last_prune >= 60:
                prune(db); last_prune = tick
            if tick-last_report >= 30:
                print(f'TD saved this run: {batches} batches / {events} events; {malformed} unrecognised envelopes retained', flush=True)
                last_report = tick
    except Exception as error:
        raise SystemExit('TD reader stopped: '+kafka_error_name(error)) from None
    finally:
        try:
            consumer.close()
        finally:
            db.close()


if __name__ == '__main__':
    main()
