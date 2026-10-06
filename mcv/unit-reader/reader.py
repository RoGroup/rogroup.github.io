"""Persist the latest LINX train snapshots before committing Kafka offsets."""
import json
import os
import sqlite3
import time
import xml.etree.ElementTree as ET
from pathlib import Path

TOPIC = "prod-1033-Passenger-Train-Allocation-and-Consist-1_0"


def parse(data):
    root = ET.fromstring(data)
    for node in root.iter():
        node.tag = node.tag.split("}")[-1]
    identity = root.find(".//TransportOperationalIdentifiers")
    if identity is None:
        raise ValueError("Message has no operational identifier")
    core = identity.findtext("Core")
    date = identity.findtext("StartDate")
    stamp = root.findtext("MessageHeader/MessageReference/MessageDateTime")
    if not core or not date or not stamp:
        raise ValueError("Message lacks core, start date or timestamp")
    key = json.dumps([core, date, identity.findtext("Variant"),
                      identity.findtext("TimetableYear")])
    return key, core, date, stamp, root.findtext(".//OperationalTrainNumber"), data


def save(db, record):
    db.execute("""INSERT INTO trains VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(train_key) DO UPDATE SET
        core=excluded.core, start_date=excluded.start_date,
        message_time=excluded.message_time, headcode=excluded.headcode,
        xml=excluded.xml
        WHERE excluded.message_time >= trains.message_time""", record)


def main():
    from confluent_kafka import Consumer
    os.umask(0o077)
    folder = Path(__file__).resolve().parent
    config = json.loads((folder / "kafka-config.json").read_text())
    config.update({"enable.auto.commit": False,
                   "enable.auto.offset.store": False,
                   "auto.offset.reset": "earliest",
                   "allow.auto.create.topics": False,
                   "queued.max.messages.kbytes": 1024,
                   "fetch.message.max.bytes": 1048576,
                   "log_level": 4})
    db = sqlite3.connect(folder / "allocations.sqlite3")
    db.execute("PRAGMA journal_mode=WAL")
    db.execute("""CREATE TABLE IF NOT EXISTS trains (
        train_key TEXT PRIMARY KEY, core TEXT, start_date TEXT,
        message_time TEXT, headcode TEXT, xml BLOB)""")
    db.commit()
    consumer = Consumer(config)
    consumer.subscribe([TOPIC])
    count = 0
    last_report = last_cleanup = time.monotonic()
    print("Allocation reader started", flush=True)
    try:
        while True:
            message = consumer.poll(1)
            if message is not None:
                if message.error():
                    raise RuntimeError(str(message.error()))
                if message.value() is None:
                    raise ValueError("Unexpected tombstone; stopped for inspection")
                record = parse(message.value())
                with db:
                    save(db, record)
                consumer.commit(message=message, asynchronous=False)
                count += 1
            now = time.monotonic()
            if now - last_cleanup >= 3600:
                with db:
                    db.execute("DELETE FROM trains WHERE start_date < date('now', '-3 days')")
                last_cleanup = now
            if now - last_report >= 30:
                total = db.execute("SELECT COUNT(*) FROM trains").fetchone()[0]
                print(f"Processed {count} messages; stored {total} train snapshots", flush=True)
                last_report = now
    finally:
        consumer.close()
        db.close()


if __name__ == "__main__":
    main()
