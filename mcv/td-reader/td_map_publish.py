"""Publish the bounded Victoria TD snapshot using the existing ingestion key."""
import json
import time
import urllib.request
from pathlib import Path
from td_map import snapshot

BASE='https://mcv-rdm-proxy.railstaffhub.uk'
def publish():
    token=Path('/opt/mcv-unit-reader/unit-ingest-token.txt').read_text().strip()
    payload=json.dumps(snapshot('/opt/mcv-td-reader')).encode()
    request=urllib.request.Request(BASE+'/td-ingest',data=payload,headers={'Content-Type':'application/json','Authorization':'Bearer '+token},method='POST')
    with urllib.request.urlopen(request,timeout=25) as response:
        if response.status!=200:raise RuntimeError('Snapshot rejected')
    print('Victoria TD snapshot published',flush=True)

if __name__=='__main__':
    while True:
        try:publish()
        except Exception as error:print('TD map publication failed: '+type(error).__name__,flush=True)
        time.sleep(65)
