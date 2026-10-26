#!/usr/bin/env bash
# Install the independent file importer; existing readers remain running.
set -euo pipefail
commit=${1:?Usage: bash install-events.sh FULL_COMMIT_SHA}
[[ $commit =~ ^[0-9a-f]{40}$ && $EUID == 0 ]] || { echo 'Run as root with a full commit SHA'; exit 1; }
folder=/opt/mcv-unit-reader
python="$folder/.venv/bin/python"
[[ -x $python && -f $folder/unit-ingest-token.txt ]] || { echo 'Existing MCV publisher installation required'; exit 1; }
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
chmod 755 "$staging"
for file in events_import.py test_events_import.py mcv-events-import.service mcv-events-import.timer; do
 curl -fsSL "https://raw.githubusercontent.com/RoGroup/rogroup.github.io/$commit/mcv/unit-reader/$file" -o "$staging/$file"
 chmod 644 "$staging/$file"
done
cd "$staging"
"$python" -m unittest -v test_events_import.py
publisher_user=$(systemctl show mcv-unit-publisher --property=User --value)
publisher_user=${publisher_user:-root}
# Validate the delivered file before installing, under the service identity.
if [[ $publisher_user == root ]]; then
 "$python" events_import.py --folder "$folder" --check
else
 runuser -u "$publisher_user" -- "$python" events_import.py --folder "$folder" --check
fi
if [[ -f $folder/events_import.py ]]; then cp -p "$folder/events_import.py" "$folder/events_import.py.before-events"; fi
install -m 644 events_import.py "$folder/events_import.py"
sed "/^\[Service\]/a User=$publisher_user" mcv-events-import.service > "$staging/installed.service"
install -m 644 "$staging/installed.service" /etc/systemd/system/mcv-events-import.service
install -m 644 mcv-events-import.timer /etc/systemd/system/mcv-events-import.timer
systemctl daemon-reload
systemctl enable --now mcv-events-import.timer
systemctl start mcv-events-import.service
systemctl is-active mcv-events-import.timer
journalctl -u mcv-events-import -n 8 --no-pager
echo 'Events importer installed. Upload manchester_bi.json to /srv/rdm-upload/incoming/.'
echo 'Files settle for 120 seconds; the timer checks again after two minutes, then every 30 minutes.'
echo 'Deploy the matching worker.mjs in Cloudflare. No new bindings or credentials are required.'
