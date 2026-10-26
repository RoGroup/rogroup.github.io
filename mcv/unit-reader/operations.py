"""Bounded, read-only staff summaries; never create live board services."""
import datetime as dt
import json
import sqlite3
import zlib
from contextlib import closing
from pathlib import Path
from zoneinfo import ZoneInfo
from schedule_import import lookup

UTC=dt.timezone.utc
LONDON=ZoneInfo('Europe/London')

def decode(blob):
    return json.loads(zlib.decompress(blob)) if blob else None

def route(schedule):
    return (schedule or {}).get('schedule_segment',{}).get('schedule_location',[])

def visits(schedule):
    return [{key:str(point.get(key) or '') for key in ('arrival','departure','pass','platform')}
            for point in route(schedule) if point.get('tiploc_code')=='MNCRVIC'][:20]

def build_operations(folder,now=None):
    now=now or dt.datetime.now(UTC);folder=Path(folder)
    result={'version':1,'updatedAt':now.isoformat(),'scheduleAt':None,
            'vstp':{'configured':False,'available':False,'blocked':False,'feedAt':None},'changes':[]}
    daily=None
    try:
        daily=sqlite3.connect((folder/'schedules.sqlite3').resolve().as_uri()+'?mode=ro',uri=True)
        header=daily.execute("SELECT value FROM metadata WHERE name='header'").fetchone()
        result['scheduleAt']=dt.datetime.fromtimestamp(int(json.loads(header[0])['timestamp']),UTC).isoformat()
    except (sqlite3.Error,ValueError,TypeError,KeyError):
        if daily:daily.close()
        daily=None
    try:
        path=folder/'vstp.sqlite3'
        if not path.exists():return result
        with closing(sqlite3.connect(path.resolve().as_uri()+'?mode=ro',uri=True)) as db:
            db.execute('BEGIN')
            meta=dict(db.execute('SELECT name,value FROM metadata'))
            heartbeat=float(meta.get('heartbeat','0'));blocked=meta.get('blocked')=='1'
            result['vstp']={'configured':True,'available':not blocked and 0<=now.timestamp()-heartbeat<=180,
                            'blocked':blocked,'feedAt':dt.datetime.fromtimestamp(heartbeat,UTC).isoformat() if heartbeat>0 else None}
            has_log=db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='vstp_changes'").fetchone()
            # Current state, not a complete event history. Include cancellations and
            # withdrawn/diverted variants whose previous or daily route visits MCV.
            base_uids={row[0].strip() for row in daily.execute('SELECT DISTINCT uid FROM schedules')} if daily else set()
            today=now.astimezone(LONDON).date()
            for uid,start,stp,end,days,payload,deleted,stamp in db.execute('SELECT uid,start_date,stp,end_date,days,payload_zlib,deleted,stamp FROM vstp_schedules WHERE stamp>=? ORDER BY stamp DESC',(int((now.timestamp()-48*3600)*1000),)):
                current=decode(payload)
                audit=db.execute('SELECT action,previous_zlib FROM vstp_changes WHERE uid=? AND start_date=? AND stp=?',(uid,start,stp)).fetchone() if has_log else None
                previous=decode(audit[1]) if audit else None
                if not current and not previous and uid not in base_uids:continue
                baseline=None;operating=[]
                for date in (today,today+dt.timedelta(days=1)):
                    date_text=date.isoformat()
                    candidate=None
                    if daily and uid in base_uids:
                        found=lookup(daily,uid,date_text)
                        if found['status']=='scheduled':candidate=found['schedule']
                    # Delete envelopes omit the old end/running days; recover them.
                    applicability=(previous or candidate) if deleted else None
                    last=(applicability or {}).get('schedule_end_date',end)
                    runs=(applicability or {}).get('schedule_days_runs',days)
                    if start<=date_text<=last and len(runs)==7 and runs[date.weekday()]=='1':
                        operating.append(date_text)
                        baseline=baseline or candidate
                prior=previous or baseline
                if not operating or not (visits(current) or visits(prior)):continue
                points=route(current) or route(prior)
                status='withdrawn' if deleted else 'cancelled' if stp=='C' else 'removed-from-victoria' if not visits(current) else 'amended' if prior else 'new' if audit and audit[0]=='Create' else 'captured'
                headcode=(current or prior or {}).get('schedule_segment',{}).get('signalling_id','')
                if not headcode or len(headcode)>8:headcode=''
                result['changes'].append({'uid':uid,'headcode':headcode,'startDate':start,'endDate':end,
                    'operatingDates':operating,'at':dt.datetime.fromtimestamp(stamp/1000,UTC).isoformat(),
                    'action':audit[0] if audit else 'Captured','status':status,
                    'origin':points[0]['tiploc_code'] if points else '',
                    'destination':points[-1]['tiploc_code'] if points else '',
                    'victoria':visits(current),'previousVictoria':visits(prior),
                    'comparison':'previous capture' if previous else 'daily timetable' if baseline else '',
                    'routeChanged':bool(current and prior and [p['tiploc_code'] for p in route(current)]!=[p['tiploc_code'] for p in route(prior)])})
                if len(result['changes'])>=30:break
        return result
    finally:
        if daily:daily.close()
