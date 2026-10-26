#!/usr/bin/env bash
# Update the existing VSTP reader and publisher without changing credentials.
set -euo pipefail
commit=${1:?Usage: bash install-operations.sh FULL_COMMIT_SHA}
[[ $commit =~ ^[0-9a-f]{40}$ && $EUID == 0 ]] || { echo 'Run as root with a full commit SHA'; exit 1; }
folder=/opt/mcv-unit-reader
python="$folder/.venv/bin/python"
[[ -x $python && -f $folder/vstp-kafka-config.json ]] || { echo 'Existing MCV VSTP installation required'; exit 1; }
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
chmod 755 "$staging"
files='operations.py publisher.py vstp_schedules.py vstp_reader.py schedule_import.py trust_snapshot.py recent_services.py test_operations.py test_vstp.py test_vstp_catchup.py test_trust_snapshot.py test_recent_services.py test_turnback.py test_schedule_import.py'
for file in $files; do
 curl -fsSL "https://raw.githubusercontent.com/RoGroup/rogroup.github.io/$commit/mcv/unit-reader/$file" -o "$staging/$file"
 chmod 644 "$staging/$file"
done
cd "$staging"
"$python" -m unittest discover -p 'test_*.py'
publisher_user=$(systemctl show mcv-unit-publisher --property=User --value)
publisher_user=${publisher_user:-root}
preview='import json,sys; from pathlib import Path; from operations import build_operations; data=build_operations(Path(sys.argv[1])); print(json.dumps({"vstp":data["vstp"],"scheduleAt":data["scheduleAt"],"changes":len(data["changes"])},indent=2))'
if [[ $publisher_user == root ]]; then
 "$python" -c "$preview" "$folder"
else
 runuser -u "$publisher_user" -- "$python" -c "$preview" "$folder"
fi
for file in operations.py vstp_schedules.py vstp_reader.py schedule_import.py trust_snapshot.py recent_services.py publisher.py; do
 if [[ -f $folder/$file ]]; then cp -p "$folder/$file" "$folder/$file.before-operations"; fi
 install -m 644 "$file" "$folder/$file"
done
systemctl restart mcv-vstp-reader mcv-unit-publisher
systemctl is-active mcv-vstp-reader mcv-unit-publisher
echo 'Staff operations updated. The next existing publisher upload is after 120 seconds.'
echo 'Deploy the matching worker.mjs in Cloudflare. No credentials, bindings or upload intervals change.'
