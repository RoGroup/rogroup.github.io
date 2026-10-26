"""Normalize VSTP schedules and overlay a separate durable store on daily CIF.

Format reference: Network Rail VSTPCIFMsgV1 example linked by the user at
https://wiki.openraildata.com/index.php/VSTP . Kafka transport is configured locally.
"""
import datetime as dt
import json
import re
import sqlite3
import time
import zlib
from pathlib import Path

UID_PATTERN = r'(?:[A-Z]\d{5}|\d{5})'

def uid(value):
    result = str(value or '').strip()
    if not re.fullmatch(UID_PATTERN, result):
        raise ValueError('Invalid schedule UID')
    return result


def clock(value, public=False):
    value = str(value or '').strip()
    if not value or (public and value == '000000'):
        return None
    if not re.fullmatch(r'(?:[01]\d|2[0-3])[0-5]\d(?:00|30)', value):
        raise ValueError('Unsupported VSTP time')
    # Existing route logic supports half minutes for working times only.
    if public and value[-2:] != '00':
        raise ValueError('Non-minute public time')
    return value[:4] + ('H' if value[-2:] == '30' else '')


def normalize(envelope):
    if not isinstance(envelope, dict) or set(envelope) != {'VSTPCIFMsgV1'}:
        raise ValueError('Unknown VSTP envelope')
    body = envelope['VSTPCIFMsgV1']
    stamp = int(body['timestamp'])
    if stamp < 1000000000000:
        raise ValueError('Expected millisecond VSTP timestamp')
    schedule = body['schedule']
    identity = (uid(schedule['CIF_train_uid']), schedule['schedule_start_date'], schedule['CIF_stp_indicator'])
    dt.date.fromisoformat(identity[1])
    if identity[2] not in ('C','N','O','P'):
        raise ValueError('Invalid STP indicator')
    action = schedule['transaction_type']
    if action not in ('Create','Update','Delete'):
        raise ValueError('Unknown VSTP transaction')
    if action == 'Delete':
        return identity, stamp, None
    if schedule.get('applicable_timetable') not in ('Y','N'):
        raise ValueError('Missing applicability flag')
    end = schedule['schedule_end_date']
    if dt.date.fromisoformat(end) < dt.date.fromisoformat(identity[1]):
        raise ValueError('Reversed VSTP dates')
    days = schedule['schedule_days_runs']
    if not isinstance(days,str) or not re.fullmatch(r'[01]{7}',days):
        raise ValueError('Invalid running days')
    segments = schedule.get('schedule_segment') or []
    if identity[2]=='C' and segments==[]:segments=[{}]
    if not isinstance(segments,list) or len(segments) != 1:
        # A multi-segment train needs a verified conversion; never concatenate blindly.
        raise ValueError('Unsupported VSTP segment count')
    segment = segments[0]
    points = segment.get('schedule_location') or []
    if identity[2] != 'C' and (not isinstance(points,list) or not 2 <= len(points) <= 500):
        raise ValueError('Incomplete VSTP route')
    converted = []
    for i, point in enumerate(points):
        tiploc = point['location']['tiploc']['tiploc_id'].strip()
        if not re.fullmatch(r'[A-Z0-9]{1,7}',tiploc):
            raise ValueError('Invalid TIPLOC')
        row = {'tiploc_code':tiploc, 'record_identity':'LO' if i==0 else 'LT' if i==len(points)-1 else 'LI',
               'platform':str(point.get('CIF_platform') or '').strip(),
               'activities':str(point.get('CIF_activity') or '').strip()}
        for source,target in [('scheduled_arrival_time','arrival'),('scheduled_departure_time','departure'),('scheduled_pass_time','pass'),('public_arrival_time','public_arrival'),('public_departure_time','public_departure')]:
            row[target] = clock(point.get(source),target.startswith('public_'))
        if not any(row.get(key) for key in ('arrival','departure','pass')):
            raise ValueError('Untimed VSTP location')
        converted.append(row)
    result = {key:schedule.get(key) for key in ('schedule_start_date','schedule_end_date','schedule_days_runs','CIF_bank_holiday_running','applicable_timetable','CIF_stp_indicator','train_status')}
    result.update({'CIF_train_uid':identity[0], 'transaction_type':'Create', 'atoc_code':str(segment.get('atoc_code') or '').strip(),
                   'schedule_segment':{key:str(segment.get(key) or '').strip() for key in ('signalling_id','CIF_train_category','CIF_headcode')}})
    result['schedule_segment']['schedule_location'] = converted
    return identity, stamp, result


def open_store(path):
    db=sqlite3.connect(path,timeout=30)
    db.execute('PRAGMA journal_mode=WAL');db.execute('PRAGMA synchronous=FULL')
    db.executescript('''
      CREATE TABLE IF NOT EXISTS metadata(name TEXT PRIMARY KEY,value TEXT NOT NULL);
      INSERT OR IGNORE INTO metadata VALUES ('revision','0');
      INSERT OR IGNORE INTO metadata VALUES ('blocked','0');
      CREATE TABLE IF NOT EXISTS vstp_schedules(
        uid TEXT,start_date TEXT,stp TEXT,end_date TEXT,days TEXT,applicable TEXT,bank_holiday TEXT,
        payload_zlib BLOB,deleted INTEGER NOT NULL,stamp INTEGER NOT NULL,digest TEXT NOT NULL,
        PRIMARY KEY(uid,start_date,stp));
      CREATE TABLE IF NOT EXISTS vstp_batches(
        topic TEXT,partition_id INTEGER,offset_id INTEGER,received_at INTEGER,
        payload_zlib BLOB,error TEXT,PRIMARY KEY(topic,partition_id,offset_id));
    ''');db.commit()
    return db


def apply_event(db,envelope,received):
    import hashlib
    identity,stamp,schedule=normalize(envelope)
    if stamp > (received+300)*1000:
        raise ValueError('Future VSTP timestamp')
    # Retain all identities, including updates diverted away from MCV and deletions.
    encoded=json.dumps(schedule,sort_keys=True,separators=(',',':')).encode()
    digest=hashlib.sha256(encoded).hexdigest()
    old=db.execute('SELECT stamp,digest FROM vstp_schedules WHERE uid=? AND start_date=? AND stp=?',identity).fetchone()
    if old and stamp<old[0]:return False
    if old and stamp==old[0]:
        if digest!=old[1]:raise ValueError('Conflicting simultaneous VSTP updates')
        return False
    end=schedule['schedule_end_date'] if schedule else identity[1]
    days=schedule['schedule_days_runs'] if schedule else '1111111'
    payload=zlib.compress(encoded) if schedule and any(p['tiploc_code']=='MNCRVIC' for p in schedule['schedule_segment']['schedule_location']) else None
    db.execute('INSERT OR REPLACE INTO vstp_schedules VALUES (?,?,?,?,?,?,?,?,?,?,?)',(*identity,end,days,schedule.get('applicable_timetable') if schedule else 'Y',schedule.get('CIF_bank_holiday_running') if schedule else '',payload,int(schedule is None),stamp,digest))
    db.execute("UPDATE metadata SET value=CAST(value AS INTEGER)+1 WHERE name='revision'")
    return True


def prepare_view(db,folder,now):
    """Build one consistent read snapshot. Main daily database is never modified."""
    path=(Path(folder)/'vstp.sqlite3').resolve()
    if not path.exists():return 0
    db.execute('ATTACH DATABASE ? AS vstp',(path.as_uri()+'?mode=ro',))
    db.execute('BEGIN')
    metadata=dict(db.execute('SELECT name,value FROM vstp.metadata'))
    if metadata.get('blocked')=='1':
        raise ValueError('VSTP capture needs inspection; withholding timetable projection')
    heartbeat=float(metadata.get('heartbeat','0'))
    fresh=0 <= now.timestamp()-heartbeat <= 180
    # Unknown/stale VSTP routes suppress affected base variants, never fall back
    # silently to an obsolete route. A cancellation/deletion remains a tombstone.
    db.execute('''CREATE TEMP VIEW schedules AS
        SELECT trim(b.uid) uid,b.start_date,b.stp,b.end_date,b.days,b.applicable,b.bank_holiday,b.payload_zlib
        FROM main.schedules b WHERE NOT EXISTS
        (SELECT 1 FROM vstp.vstp_schedules v WHERE v.uid=trim(b.uid) AND v.start_date=b.start_date AND v.stp=b.stp)
        UNION ALL SELECT uid,start_date,stp,end_date,days,applicable,bank_holiday,
        CASE WHEN '''+('1' if fresh else '0')+''' THEN payload_zlib ELSE NULL END
        FROM vstp.vstp_schedules WHERE deleted=0''')
    return int(metadata.get('revision','0'))*2+int(fresh)
