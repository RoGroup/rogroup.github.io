"""Enter RDM VSTP credentials locally. No account-specific values in source."""
import argparse
import getpass
import json
import os
import re
import ssl
import tempfile
from pathlib import Path

FOLDER=Path(__file__).resolve().parent
BROKER='pkc-z3p1v0.europe-west2.gcp.confluent.cloud:9092'

def main():
    global FOLDER
    parser=argparse.ArgumentParser();parser.add_argument("--folder",type=Path,default=FOLDER);FOLDER=parser.parse_args().folder
    os.umask(0o077)
    topic=input('VSTP Kafka topic (copy from RDM Pub/Sub): ').strip()
    group=input('VSTP consumer group: ').strip()
    user=input('VSTP consumer username: ').strip()
    secret=getpass.getpass('VSTP password/API secret (hidden): ')
    if not re.fullmatch(r'[A-Za-z0-9._-]{1,249}',topic) or not re.fullmatch(r'[A-Za-z0-9._:-]{1,200}',group) or not user or not secret:
        raise SystemExit('Topic, group, username and password are required')
    for path in [FOLDER/'trust-kafka-config.json',FOLDER/'kafka-config.json',Path('/opt/mcv-td-reader/td-kafka-config.json')]:
        if path.exists() and json.loads(path.read_text()).get('group.id')==group:
            raise SystemExit('This group is used by another reader; copy the VSTP subscription group')
    ca=ssl.get_default_verify_paths().cafile
    if not ca or not Path(ca).is_file():raise SystemExit('System CA bundle missing')
    config={'topic':topic,'bootstrap.servers':BROKER,'group.id':group,'security.protocol':'SASL_SSL','sasl.mechanisms':'PLAIN',
            'sasl.username':user,'sasl.password':secret,'ssl.ca.location':ca}
    descriptor,path=tempfile.mkstemp(prefix='.vstp-config-',dir=FOLDER)
    try:
        with os.fdopen(descriptor,'w') as stream:
            json.dump(config,stream,indent=2);stream.write('\n');stream.flush();os.fsync(stream.fileno())
        os.replace(path,FOLDER/'vstp-kafka-config.json')
    finally:Path(path).unlink(missing_ok=True)
    print('VSTP config saved locally with mode 0600')

if __name__=='__main__':main()
