"""Enter subscription credentials locally; never place them in the repository."""
import argparse
import getpass
import json
import os
import re
import ssl
import tempfile
from pathlib import Path

BROKER = 'pkc-z3p1v0.europe-west2.gcp.confluent.cloud:9092'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--folder', type=Path, default=Path('/opt/mcv-td-reader'))
    args = parser.parse_args()
    os.umask(0o077)
    args.folder.mkdir(mode=0o750, parents=True, exist_ok=True)
    group = input('TD consumer group (copy from the TD subscription): ').strip()
    username = input('TD consumer username: ').strip()
    password = getpass.getpass('TD consumer password/API secret (hidden): ')
    if not re.fullmatch(r'[A-Za-z0-9._:-]{1,200}', group) or not username or not password:
        raise SystemExit('Group, username and password must be supplied')
    # Avoid rebalancing existing feed readers by mistakenly copying their group.
    for name in ('trust-kafka-config.json','kafka-config.json'):
        existing = Path('/opt/mcv-unit-reader') / name
        if existing.exists() and json.loads(existing.read_text()).get('group.id') == group:
            raise SystemExit('That group is already used by another MCV reader. Copy the TD subscription group.')
    ca = ssl.get_default_verify_paths().cafile
    if not ca or not Path(ca).is_file():
        raise SystemExit('A system CA certificate bundle is required')
    config = {'bootstrap.servers':BROKER,'group.id':group,'security.protocol':'SASL_SSL',
              'sasl.mechanisms':'PLAIN','sasl.username':username,'sasl.password':password,'ssl.ca.location':ca}
    fd, temp = tempfile.mkstemp(prefix='.td-config-', dir=args.folder)
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(config, stream, indent=2);stream.write('\n')
            stream.flush();os.fsync(stream.fileno())
        os.chmod(temp, 0o600)
        os.replace(temp,args.folder/'td-kafka-config.json')
    finally:
        if os.path.exists(temp):os.unlink(temp)
    print('TD configuration saved locally with restricted permissions.')


if __name__ == '__main__':
    main()
