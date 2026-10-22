"""Capture TRUST Kafka batches durably before acknowledging their offsets."""
import json
import os
import signal
import sqlite3
import time
import zlib
from pathlib import Path

TOPIC = "TRAIN_MVT_ALL_TOC"
RETENTION_SECONDS = 2 * 86400


def open_database(path):
    db = sqlite3.connect(path, timeout=30)
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("PRAGMA synchronous=FULL")
    db.execute("""CREATE TABLE IF NOT EXISTS trust_batches (
        topic TEXT NOT NULL, partition_id INTEGER NOT NULL,
        offset_id INTEGER NOT NULL, received_at INTEGER NOT NULL,
        broker_timestamp_ms INTEGER, event_count INTEGER,
        payload_zlib BLOB NOT NULL, parse_error TEXT,
        PRIMARY KEY(topic, partition_id, offset_id))""")
    db.execute("CREATE INDEX IF NOT EXISTS trust_received ON trust_batches(received_at)")
    db.commit()
    return db


def persist_batch(db, consumer, message):
    payload = message.value()
    error = None
    count = None
    try:
        if payload is None:
            raise ValueError("Unexpected tombstone")
        records = json.loads(payload)
        if not isinstance(records, list) or any(
            not isinstance(item, dict)
            or not isinstance(item.get("header"), dict)
            or not isinstance(item.get("body"), dict)
            for item in records
        ):
            raise ValueError("Expected a JSON array of header/body objects")
        count = len(records)
    except (ValueError, UnicodeError, TypeError) as exc:
        error = type(exc).__name__ + ": invalid TRUST envelope"
    broker_time = message.timestamp()[1]
    with db:
        db.execute("""INSERT INTO trust_batches VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(topic, partition_id, offset_id) DO NOTHING""",
            (message.topic(), message.partition(), message.offset(), int(time.time()),
             broker_time if broker_time is not None and broker_time >= 0 else None,
             count, zlib.compress(payload or b"", 6), error))
    if error:
        raise ValueError("Invalid TRUST batch saved for inspection; offset not committed")
    # This must follow the SQLite commit. Replays are safe because the key is unique.
    consumer.commit(message=message, asynchronous=False)
    return count


def main():
    from confluent_kafka import Consumer

    os.umask(0o077)
    folder = Path(__file__).resolve().parent
    config = json.loads((folder / "trust-kafka-config.json").read_text())
    config.update({
        "enable.auto.commit": False, "enable.auto.offset.store": False,
        "auto.offset.reset": "earliest", "allow.auto.create.topics": False,
        "queued.max.messages.kbytes": 4096, "log_level": 4,
    })
    db = open_database(folder / "trust.sqlite3")
    consumer = Consumer(config)
    running = True

    def stop(*_):
        nonlocal running
        running = False

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    batches = events = 0
    last_report = last_cleanup = time.monotonic()
    try:
        consumer.subscribe([TOPIC])
        print("TRUST capture started; raw timestamps preserved; retention 48 hours", flush=True)
        while running:
            message = consumer.poll(1)
            if message is not None:
                if message.error():
                    raise RuntimeError(str(message.error()))
                events += persist_batch(db, consumer, message)
                batches += 1
            now = time.monotonic()
            if now - last_cleanup >= 3600:
                with db:
                    db.execute("DELETE FROM trust_batches WHERE received_at < ?",
                               (int(time.time()) - RETENTION_SECONDS,))
                last_cleanup = now
            if now - last_report >= 30:
                print(f"TRUST: saved {batches} batches / {events} events this run", flush=True)
                last_report = now
    finally:
        try:
            consumer.close()
        finally:
            db.close()


if __name__ == "__main__":
    main()
