"""Normalize delivered Data Thistle snapshots; publish independently of trains.

Schema reference: https://files.datathistle.com/feeds/docs/feedspec.pdf
Performance duration is minutes. Schedule end_ts is NOT a performance finish.
"""
import argparse
import datetime as dt
import hashlib
import json
import math
import os
import re
import tempfile
import urllib.parse
import urllib.request
from html import unescape
from html.parser import HTMLParser
from pathlib import Path

UTC=dt.timezone.utc
DEFAULT_SOURCE=Path('/srv/rdm-upload/incoming/manchester_bi.json')
BASE='https://mcv-rdm-proxy.railstaffhub.uk'
MAX_SOURCE=16*1024*1024
MAX_PAYLOAD=4*1024*1024

class PlainText(HTMLParser):
    def __init__(self):super().__init__();self.parts=[];self.suppressed=0
    def handle_starttag(self,tag,attrs):
        if tag in ('script','style'):self.suppressed+=1
        elif tag in ('br','p','li'):self.parts.append(' ')
    def handle_endtag(self,tag):
        if tag in ('script','style') and self.suppressed:self.suppressed-=1
    def handle_data(self,data):
        if not self.suppressed:self.parts.append(data)

def text(value,limit=4000):
    if value is None:return ''
    if not isinstance(value,str):raise ValueError('Expected text')
    parser=PlainText();parser.feed(value)
    return re.sub(r'\s+',' ',unescape(''.join(parser.parts))).strip()[:limit]

def identifier(value):
    if isinstance(value,bool) or not isinstance(value,(str,int)) or not re.fullmatch(r'[0-9]{1,15}',str(value)):raise ValueError('Invalid event/place identity')
    return str(value)

def number(value,max_value=10000000):
    if value is None or isinstance(value,bool):return None
    try:value=float(value)
    except (ValueError,TypeError):return None
    return value if math.isfinite(value) and 0<value<=max_value else None

def safe_url(value):
    if not isinstance(value,str) or len(value)>3000:return ''
    try:
        url=urllib.parse.urlsplit(value)
        return value if url.scheme in ('https','http') and url.hostname and not url.username and not url.password else ''
    except ValueError:return ''

def timestamp(value):
    if not isinstance(value,str):raise ValueError('Missing performance time')
    if re.fullmatch(r'\d{4}-\d\d-\d\d',value):dt.date.fromisoformat(value);return value
    if not re.fullmatch(r'\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)',value):raise ValueError('Performance time needs an explicit offset')
    parsed=dt.datetime.fromisoformat(value.replace('Z','+00:00'))
    if parsed.tzinfo is None:raise ValueError('Missing time zone')
    return parsed.isoformat()

def normalize(data,received_at=None):
    if not isinstance(data,dict) or not isinstance(data.get('events'),list) or not isinstance(data.get('places'),list):raise ValueError('Expected events and places arrays')
    if len(data['events'])>10000 or len(data['places'])>2000:raise ValueError('Events snapshot too large')
    events={};places={};performances={}
    for place in data['places']:
        pid=identifier(place['place_id'])
        if pid in places:raise ValueError('Duplicate place identity')
        distances=[]
        for entry in place.get('stations',[]):
            if not isinstance(entry,list) or len(entry)!=2:continue
            distance=0 if entry[1]==0 and not isinstance(entry[1],bool) else number(entry[1],1000)
            if re.fullmatch(r'[A-Z]{3}',str(entry[0])) and distance is not None:distances.append((entry[0],distance))
        nearest=min(distances,key=lambda row:row[1])[0] if distances else ''
        places[pid]={'id':pid,'name':text(place.get('name'),180),'address':text(place.get('address'),250),
            'town':text(place.get('town'),100),'postcode':text(place.get('postal_code'),20),
            'website':safe_url(place.get('website')),'nearestStation':nearest,
            'capacity':number(place.get('properties',{}).get('place.capacity.max'))}
    for event in data['events']:
        eid=identifier(event['event_id'])
        if eid in events:raise ValueError('Duplicate event identity')
        descriptions=event.get('descriptions') or []
        description=next((row.get('description') for row in descriptions if row.get('type')=='description.official'),None) or next((row.get('description') for row in descriptions),None) or event.get('description')
        events[eid]={'id':eid,'name':text(event.get('name'),250),'category':text(event.get('category'),80) or 'Other',
            'description':text(description),'tags':[text(tag,80) for tag in event.get('tags',[])[:30]],
            'website':safe_url(event.get('website')),'status':text(event.get('status') or 'live',30)}
        if not events[eid]['name']:raise ValueError('Unnamed event')
        for schedule in event.get('schedules',[]):
            pid=identifier(schedule.get('place_id'))
            if pid not in places:raise ValueError('Performance references an unknown venue')
            for performance in schedule.get('performances',[]):
                start=timestamp(performance.get('ts'));unknown=text(performance.get('time_unknown'),80)
                if len(start)==10:unknown=unknown or 'Time not supplied'
                duration=number(performance.get('duration'),7*24*60)
                end=None
                if not unknown and duration is not None:end=(dt.datetime.fromisoformat(start)+dt.timedelta(minutes=duration)).isoformat()
                properties=performance.get('properties') or {}
                capacity=number(properties.get('capacity.calculated'))
                source='Performance calculation' if capacity is not None else 'Venue maximum' if places[pid]['capacity'] is not None else ''
                booking=next((safe_url(link.get('url')) for link in performance.get('links',[]) if link.get('type')=='booking' and safe_url(link.get('url'))),'')
                row={'eventId':eid,'placeId':pid,'start':start,'end':end,'timeUnknown':unknown,
                    'capacity':capacity if capacity is not None else places[pid]['capacity'],'capacitySource':source,
                    'cancelled':properties.get('performance.cancelled') is True or event.get('status')=='cancelled',
                    'soldOut':properties.get('performance.sold-out') is True,'bookingUrl':booking}
                key=(eid,pid,start)
                if key in performances and performances[key]!=row:raise ValueError('Conflicting duplicate performance')
                performances[key]=row
                if len(performances)>20000:raise ValueError('Too many performances')
    return {'version':1,'source':'Data Thistle · Manchester sample','receivedAt':received_at or dt.datetime.now(UTC).isoformat(),
        'events':list(events.values()),'places':list(places.values()),'performances':sorted(performances.values(),key=lambda row:(row['start'],row['eventId'],row['placeId']))}

def publish(source,folder,check=False):
    source=Path(source);folder=Path(folder)
    if not source.exists():print('Waiting for delivered manchester_bi.json',flush=True);return
    if source.is_symlink() or not source.is_file():raise ValueError('Events source must be a regular file')
    before=source.stat()
    if before.st_size>MAX_SOURCE:raise ValueError('Events file exceeds size limit')
    if not check and dt.datetime.now(UTC).timestamp()-before.st_mtime<120:print('Waiting for events upload to settle',flush=True);return
    raw=source.read_bytes();after=source.stat()
    if (before.st_ino,before.st_size,before.st_mtime_ns,before.st_ctime_ns)!=(after.st_ino,after.st_size,after.st_mtime_ns,after.st_ctime_ns):raise ValueError('Events upload changed while reading')
    digest=hashlib.sha256(raw).hexdigest();state_path=folder/'events-published.json'
    marker={'sha256':digest,'mtimeNs':after.st_mtime_ns}
    if not check and state_path.exists() and json.loads(state_path.read_text())==marker:print('Events file unchanged; no KV write',flush=True);return
    received=dt.datetime.fromtimestamp(after.st_mtime,UTC).isoformat()
    data=normalize(json.loads(raw),received)
    encoded=json.dumps(data,separators=(',',':'),ensure_ascii=False).encode()
    if len(encoded)>MAX_PAYLOAD:raise ValueError('Normalized events snapshot exceeds size limit')
    print(f"Events validated: {len(data['events'])} events / {len(data['places'])} venues / {len(data['performances'])} performances; {len(encoded)} bytes",flush=True)
    if check:return
    token=(folder/'unit-ingest-token.txt').read_text().strip()
    if not re.fullmatch(r'[A-Za-z0-9_-]{32,128}',token):raise ValueError('Invalid local ingest token')
    request=urllib.request.Request(BASE+'/events-ingest',data=encoded,headers={'Content-Type':'application/json','Authorization':'Bearer '+token},method='POST')
    with urllib.request.urlopen(request,timeout=45) as response:
        if response.status!=200:raise ValueError('Events publication failed')
    fd,temp=tempfile.mkstemp(prefix='events-published-',dir=folder)
    try:
        with os.fdopen(fd,'w') as stream:json.dump(marker,stream);stream.flush();os.fsync(stream.fileno())
        os.replace(temp,state_path)
    finally:Path(temp).unlink(missing_ok=True)
    print('Events snapshot published; existing train publishers unchanged',flush=True)

if __name__=='__main__':
    os.umask(0o077)
    parser=argparse.ArgumentParser(description=__doc__);parser.add_argument('--source',type=Path,default=DEFAULT_SOURCE);parser.add_argument('--folder',type=Path,default=Path(__file__).resolve().parent);parser.add_argument('--check',action='store_true');args=parser.parse_args()
    publish(args.source,args.folder,args.check)
