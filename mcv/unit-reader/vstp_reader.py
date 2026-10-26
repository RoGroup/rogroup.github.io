"""Durable VSTP Kafka capture and projection, independent of existing readers."""
import argparse
import json
import os
import signal
import time
import zlib
from pathlib import Path
from vstp_schedules import apply_event, open_store

FOLDER=Path(__file__).resolve().parent

def persist(db,consumer,message,now=None):
    now=int(time.time() if now is None else now)
    key=(message.topic(),message.partition(),message.offset())
    existing=db.execute('SELECT error FROM vstp_batches WHERE topic=? AND partition_id=? AND offset_id=?',key).fetchone()
    if existing:
        if existing[0]:raise ValueError('Quarantined VSTP message requires inspection')
        consumer.commit(message=message,asynchronous=False);return 0
    payload=message.value() or b''
    error=None;count=0
    try:
        if len(payload)>2000000:raise ValueError('Oversized VSTP batch')
        decoded=json.loads(payload)
        events=decoded if isinstance(decoded,list) else [decoded]
        if not events or len(events)>1000:raise ValueError('Invalid VSTP batch')
        with db:
            for event in events:count+=int(apply_event(db,event,now))
            db.execute('INSERT INTO vstp_batches VALUES (?,?,?,?,?,NULL)',(*key,now,zlib.compress(payload)))
    except (ValueError,KeyError,TypeError,AttributeError) as exc:
        error=type(exc).__name__+': unsupported VSTP message'
        with db:
            db.execute('INSERT OR IGNORE INTO vstp_batches VALUES (?,?,?,?,?,?)',(*key,now,zlib.compress(payload),error))
            db.execute("UPDATE metadata SET value='1' WHERE name='blocked'")
        # Do not acknowledge an unprojected schedule change or continue with old data.
        raise ValueError(error) from None
    consumer.commit(message=message,asynchronous=False)
    return count


def prune(db,now):
    cutoff=int(now)-3*86400
    with db:
        db.execute('DELETE FROM vstp_batches WHERE received_at<? AND error IS NULL',(cutoff,))
        # Bound raw storage as well as time. Keep the newest 20,000 batches and
        # 256 MiB compressed; quarantine rows are retained within the same cap.
        total=0;keep=[]
        for rowid,size in db.execute('SELECT rowid,length(payload_zlib) FROM vstp_batches ORDER BY rowid DESC'):
            if len(keep)>=20000 or total+size>256*1024*1024:break
            keep.append(rowid);total+=size
        if keep:db.execute('DELETE FROM vstp_batches WHERE rowid<?',(keep[-1],))
        db.execute('DELETE FROM vstp_schedules WHERE end_date<? AND start_date<?',
                   (time.strftime('%Y-%m-%d',time.gmtime(now-7*86400)),)*2)


def main():
    global FOLDER
    from confluent_kafka import Consumer
    os.umask(0o077)
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--check',action='store_true');parser.add_argument('--folder',type=Path,default=FOLDER);args=parser.parse_args();FOLDER=args.folder
    config=json.loads((FOLDER/'vstp-kafka-config.json').read_text());topic=config.pop('topic')
    config.update({'enable.auto.commit':False,'enable.auto.offset.store':False,'auto.offset.reset':'error',
                   'allow.auto.create.topics':False,'queued.max.messages.kbytes':4096,'log_level':3})
    consumer=Consumer(config)
    if args.check:
        try:
            entry=consumer.list_topics(topic=topic,timeout=20).topics.get(topic)
            if entry is None or entry.error or not entry.partitions:raise ValueError('Topic metadata unavailable')
            print('VSTP topic metadata available; no messages consumed or offsets committed')
        finally:consumer.close()
        return
    db=open_store(FOLDER/'vstp.sqlite3');running=True
    def stop(*_):
        nonlocal running
        running=False
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    # Heartbeat requires successful assigned-partition EOF/watermark catch-up.
    # Unavailable broker, initial replay or offset loss must not look current.
    last_report=last_prune=time.monotonic();batches=changes=0
    def assign(consumer,partitions):
        from confluent_kafka import TopicPartition
        committed=consumer.committed(partitions,timeout=15)
        selected=[]
        for partition in committed:
            low,high=consumer.get_watermark_offsets(partition,timeout=10,cached=False)
            if partition.offset>=0 and not low<=partition.offset<=high:
                with db:db.execute("UPDATE metadata SET value='1' WHERE name='blocked'")
                raise ValueError('VSTP offset expired; projection reconciliation required')
            selected.append(TopicPartition(partition.topic,partition.partition,low if partition.offset<0 else partition.offset))
        consumer.assign(selected)
    try:
        if db.execute("SELECT value FROM metadata WHERE name='blocked'").fetchone()[0]=='1':
            raise ValueError('VSTP store blocked; inspect quarantined capture')
        with db:db.execute("INSERT OR REPLACE INTO metadata VALUES ('heartbeat','0')")
        prune(db,time.time());consumer.subscribe([topic],on_assign=assign)
        print('VSTP capture started; new group replays available history, then resumes offsets',flush=True)
        while running:
            message=consumer.poll(1)
            if message is not None:
                if message.error():raise ValueError('Kafka VSTP delivery error')
                changes+=persist(db,consumer,message);batches+=1
            tick=time.monotonic()
            if tick-last_prune>=60:prune(db,time.time());last_prune=tick
            if tick-last_report>=30:
                assigned=consumer.assignment();positions=consumer.position(assigned) if assigned else []
                caught_up=bool(positions)
                for position in positions:
                    low,high=consumer.get_watermark_offsets(position,timeout=5,cached=False)
                    if position.offset<low or position.offset<high:caught_up=False
                if caught_up:
                    with db:db.execute("INSERT OR REPLACE INTO metadata VALUES ('heartbeat',?)",(str(int(time.time())),))
                print(f'VSTP: saved {batches} batches; {changes} schedule changes; caught_up={caught_up}',flush=True)
                last_report=tick
    except Exception as exc:
        raise SystemExit('VSTP reader stopped: '+(str(exc) if isinstance(exc,ValueError) else type(exc).__name__)) from None
    finally:
        consumer.close();db.close()

if __name__=='__main__':main()
