"""Bounded read-only M3 replay. SMART reporting associations, never track occupancy."""
import json
import sqlite3
import time
import zlib
from pathlib import Path
from td_inspect import unpack
from td_reader import records

# Transcribed from the user's 22 October 2026 Vail Data MNCRVIC SMART screenshots.
# Offsets are reporting adjustments; they do not prove physical arrival.
SOURCE = 'https://vaildata.uk/bplan/tiploc?loc=MNCRVIC'
RULES = []
def add(platform, event, destinations, sources, offsets):
    for target, values in zip(destinations.split(), offsets):
        for source, offset in zip(sources.split(), values):
            RULES.append((str(platform), event, source, target, offset))
for p, berth in [(1,'A861'),(2,'A859')]:
    add(p,'arrival',berth,'0760 0804',[[70,65]])
    add(p,'departure','0757 0805',berth,[[-14],[-14]])
add(3,'arrival','0857','0760 0804 0610 0648 A594',[[64,65,79,74,60]])
add(3,'arrival','0613','0760 0804 0610 0648',[[54,55,89,84]])
add(3,'arrival','X857','A594',[[60]])
add(3,'departure','0659 0615 A594','0613',[[-17],[-17],[-17]])
add(3,'departure','0757 0805','0857',[[-16],[-16]])
add(3,'departure','0615','0581',[[-19]])
add(4,'arrival','0753','0760',[[64]])
add(4,'arrival','0803','0760 0610 0648 A594',[[69,74,70,60]])
add(4,'arrival','0657','0760 0610 0648',[[59,84,89]])
add(4,'departure','0659 0615 A594','0657',[[-19],[-19],[-21]])
add(4,'departure','0757 0805','0803',[[-16],[-16]])
add(5,'arrival','0753','0702 0582 0574 0610 0648',[[59,70,68,79,84]])
add(5,'arrival','0581','0702 0760 0574 0582 0610 0648',[[49,54,78,80,89,94]])
add(5,'departure','0597 0583 0659','0581',[[-19],[-19],[-19]])
add(5,'departure','0757 0805','0753',[[-16],[-16]])
add(6,'arrival','0701','0702 0760 0582 0574',[[64,69,68,67]])
add(6,'arrival','0595','0702 0760 0574 0582',[[54,59,77,78]])
add(6,'departure','0597 0583','0595',[[-19],[-19]])
add(6,'departure','0703 0757 0805','0701',[[-19],[-19],[-19]])
BERTHS = {r[3] if r[1]=='arrival' else r[2] for r in RULES}

def snapshot(folder, now=None):
    now = time.time() if now is None else now
    db = sqlite3.connect((Path(folder)/'td.sqlite3').resolve().as_uri()+'?mode=ro',uri=True,timeout=10)
    try:
        rows = list(db.execute('SELECT received_at,payload_zlib,parse_error FROM td_batches WHERE received_at>=? ORDER BY received_at DESC,rowid DESC LIMIT 10001',(int(now-1200),)))
    finally:
        db.close()
    limited = len(rows)>10000
    rows = rows[:10000]
    events=[]; feed=0
    for received, payload, error in reversed(rows):
        if error: continue
        try: items=records(zlib.decompress(payload))
        except (ValueError,zlib.error): continue
        for item in items:
            kind, body=unpack(item)
            if body.get('area_id')!='M3': continue
            feed=max(feed,received)
            kind=kind.removesuffix('_MSG')
            if kind not in ('CA','CB','CC'):continue
            try: stamp=int(body.get('time'))/1000
            except (ValueError,TypeError):continue
            # Delayed replay must not become a fresh position.
            if not now-1200<=stamp<=min(now+30,received+30):continue
            events.append((stamp,len(events),kind,body))
    states={}; recent=[]
    for stamp, _, kind, body in sorted(events):
        desc=str(body.get('descr') or '').strip().upper()
        start=str(body.get('from') or '');end=str(body.get('to') or '')
        if kind in ('CA','CB') and start in states and states[start]['headcode']==desc:
            del states[start]
        matches=[r for r in RULES if kind=='CA' and r[2:4]==(start,end)]
        if kind in ('CA','CC') and end in BERTHS:
            states.pop(end,None)
            if len(desc)==4 and desc[0].isdigit() and desc[1].isalpha() and desc[2:].isdigit():
                platforms=sorted({r[0] for r in matches if r[1]=='arrival'}) or sorted({r[0] for r in RULES if (r[3] if r[1]=='arrival' else r[2])==end})
                states[end]={'headcode':desc,'berth':end,'from':start,'time':stamp,'platforms':platforms,'event':'arrival' if matches else 'description','offset':matches[0][4] if len(matches)==1 else None}
        if matches and len(desc)==4 and desc[0].isdigit() and desc[1].isalpha() and desc[2:].isdigit():
            recent.append({'headcode':desc,'from':start,'berth':end,'time':stamp,'platforms':sorted({r[0] for r in matches}),'event':matches[0][1],'offset':matches[0][4] if len(matches)==1 else None})
    return {'version':1,'generatedAt':now,'feedAt':feed,'scanLimited':limited,'area':'M3',
            'berths':[v for v in states.values() if now-600<=v['time']<=now+30],
            'events':[v for v in recent[-40:] if now-600<=v['time']<=now+30]}

if __name__=='__main__':
    print(json.dumps(snapshot('/opt/mcv-td-reader'),indent=2))
