#!/usr/bin/env bash
# Run on the Hetzner reader host as root, with a reviewed Git commit SHA.
set -euo pipefail
commit=${1:?Usage: bash install-trust-publisher.sh COMMIT_SHA}
[[ $commit =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected a full Git commit SHA'; exit 1; }
folder=/opt/mcv-unit-reader
python="$folder/.venv/bin/python"
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
chmod 755 "$staging"
for file in vstp_schedules.py publisher.py trust_snapshot.py schedule_import.py test_trust_snapshot.py recent_services.py test_recent_services.py test_turnback.py; do
    curl -fsSL "https://raw.githubusercontent.com/RoGroup/rogroup.github.io/$commit/mcv/unit-reader/$file" -o "$staging/$file"
    chmod 644 "$staging/$file"
done
cd "$staging"
"$python" -m unittest -v test_trust_snapshot.py test_recent_services.py test_turnback.py
publisher_user=$(systemctl show mcv-unit-publisher --property=User --value)
publisher_user=${publisher_user:-root}
preview='import json,sys; from pathlib import Path; from trust_snapshot import build_snapshot; s=build_snapshot(Path(sys.argv[1])); print(json.dumps({"available":s["available"],"reason":s.get("reason"),"ecs":len(s["services"]),"movements":len(s.get("movements",[])),"callingPatterns":len(s.get("routes",[])),"journeyHistories":len(s.get("histories",[]))},indent=2))'
echo 'Previewing TRUST data. The first journey-history replay may take a few minutes.'
# Preview under the actual service account, so permissions are checked before
# replacing the currently working publisher. No messages are consumed or sent.
if [[ $publisher_user == root ]]; then
    "$python" -u -c "$preview" "$folder"
else
    runuser -u "$publisher_user" -- "$python" -u -c "$preview" "$folder"
fi
for file in publisher.py trust_snapshot.py test_trust_snapshot.py recent_services.py; do
    if [[ -e "$folder/$file" ]]; then
        cp -p "$folder/$file" "$folder/$file.before-trust"
    fi
done
# Dependencies are installed first; publisher.py is switched last.
install -m 644 vstp_schedules.py "$folder/vstp_schedules.py"
install -m 644 trust_snapshot.py "$folder/trust_snapshot.py"
install -m 644 test_trust_snapshot.py "$folder/test_trust_snapshot.py"
install -m 644 recent_services.py "$folder/recent_services.py"
install -m 644 publisher.py "$folder/publisher.py"
systemctl restart mcv-unit-publisher
systemctl is-active mcv-unit-publisher
echo 'Publisher updated. First upload is after 120 seconds. Deploy the matching worker.mjs in Cloudflare.'
