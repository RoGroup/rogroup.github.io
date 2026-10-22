"""Inspect captured TD envelopes locally without exposing connection credentials."""
import argparse
import collections
import datetime as dt
import json
import re
import sqlite3
import time
import zlib
from pathlib import Path
from td_reader import DEFAULT_FOLDER, records


def unpack(record):
    # These are observed envelope fields, not a geographic or signal mapping.
    if len(record) == 1:
        kind, body = next(iter(record.items()))
        if isinstance(body, dict):
            return str(body.get('msg_type') or kind), body
    if isinstance(record.get('body'), dict):
        body = record['body'];header = record.get('header') or {}
        return str(header.get('msg_type') or body.get('msg_type') or 'unknown'), body
    return str(record.get('msg_type') or 'unknown'), record


def inspect(folder, minutes=10, area='', headcode='', limit=20, now=None):
    now = now if now is not None else time.time()
    path = (Path(folder)/'td.sqlite3').resolve()
    db = sqlite3.connect(path.as_uri()+'?mode=ro',uri=True,timeout=10)
    types, areas, samples = collections.Counter(), collections.Counter(), []
    scanned = malformed = 0
    try:
        total, latest = db.execute('SELECT count(*),max(received_at) FROM td_batches').fetchone()
        rows = db.execute('SELECT received_at,payload_zlib,parse_error FROM td_batches WHERE received_at>=? ORDER BY received_at DESC,rowid DESC LIMIT 10000', (int(now-minutes*60),))
        for received,payload,error in rows:
            scanned += 1
            if error:
                malformed += 1;continue
            for item in records(zlib.decompress(payload)):
                kind, body = unpack(item)
                types[kind[:32]] += 1
                observed_area = str(body.get('area_id') or '')
                if re.fullmatch(r'[A-Z0-9]{2}',observed_area):areas[observed_area] += 1
                if not (area or headcode) or len(samples)>=limit:
                    continue
                if area and observed_area!=area:continue
                if headcode and str(body.get('descr') or '').strip().upper()!=headcode:continue
                samples.append({'type':kind,'receivedAt':dt.datetime.fromtimestamp(received,dt.timezone.utc).isoformat(),
                                **{key:body[key] for key in ('area_id','descr','from','to','time') if key in body}})
        return {'scope':'Raw national TD discovery; no verified map positions or signal aspects',
                'retainedBatches':total,'lastCaptureAt':dt.datetime.fromtimestamp(latest,dt.timezone.utc).isoformat() if latest else None,
                'lastCaptureAgeSeconds':int(now-latest) if latest else None,'windowMinutes':minutes,
                'scannedBatches':scanned,'scanLimitReached':scanned==10000,'unrecognisedBatches':malformed,
                'messageTypes':dict(types.most_common()),'observedAreas':dict(areas.most_common(30)),'samples':samples}
    finally:
        db.close()


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--folder',type=Path,default=DEFAULT_FOLDER)
    parser.add_argument('--minutes',type=int,default=10)
    parser.add_argument('--area',default='')
    parser.add_argument('--headcode',default='')
    parser.add_argument('--limit',type=int,default=20)
    args=parser.parse_args()
    if not 1<=args.minutes<=360 or not 1<=args.limit<=100:
        parser.error('Use 1–360 minutes and a sample limit of 1–100')
    area=args.area.upper();headcode=args.headcode.upper()
    if area and not re.fullmatch(r'[A-Z0-9]{2}',area):parser.error('Area must be a two-character TD identifier')
    if headcode and not re.fullmatch(r'[A-Z0-9]{4}',headcode):parser.error('Headcode must be four letters/digits')
    if not (args.folder/'td.sqlite3').is_file():raise SystemExit('No TD database yet; check mcv-td-reader service logs')
    print(json.dumps(inspect(args.folder,args.minutes,area,headcode,args.limit),indent=2))


if __name__=='__main__':main()
