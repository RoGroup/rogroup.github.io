#!/usr/bin/env bash
# Run on the existing reader host; secrets remain local.
set -euo pipefail
commit=${1:?Usage: bash install-vstp.sh FULL_COMMIT_SHA}
[[ $commit =~ ^[0-9a-f]{40}$ && $EUID == 0 ]] || { echo 'Run as root with a full commit SHA'; exit 1; }
folder=/opt/mcv-unit-reader
python="$folder/.venv/bin/python"
[[ -x $python && -f $folder/schedules.sqlite3 ]] || { echo 'Existing MCV environment and daily timetable required'; exit 1; }
"$python" -c 'import confluent_kafka,ssl'
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
chmod 755 "$staging"
files='vstp_schedules.py vstp_reader.py vstp_setup.py trust_snapshot.py recent_services.py schedule_import.py test_vstp.py test_trust_snapshot.py test_recent_services.py test_schedule_import.py mcv-vstp-reader.service'
for file in $files; do
 curl -fsSL "https://raw.githubusercontent.com/RoGroup/rogroup.github.io/$commit/mcv/unit-reader/$file" -o "$staging/$file"
 chmod 644 "$staging/$file"
done
cd "$staging"
"$python" -m unittest -v test_vstp.py test_trust_snapshot.py test_recent_services.py test_schedule_import.py
if [[ ! -f $folder/vstp-kafka-config.json ]]; then
 echo 'Enter values from your VSTP Pub/Sub subscription. Topic is not inferred from the old STOMP documentation.'
 "$python" vstp_setup.py --folder "$folder"
fi
chmod 600 "$folder/vstp-kafka-config.json"
# Topic metadata preflight does not consume messages or change offsets.
"$python" vstp_reader.py --folder "$folder" --check
publisher_user=$(systemctl show mcv-unit-publisher --property=User --value)
publisher_user=${publisher_user:-root}
if [[ $publisher_user != root ]]; then
 runuser -u "$publisher_user" -- test -w "$folder"
fi
for file in vstp_schedules.py vstp_reader.py vstp_setup.py trust_snapshot.py recent_services.py; do
 if [[ -f $folder/$file ]]; then cp -p "$folder/$file" "$folder/$file.before-vstp"; fi
 install -m 644 "$file" "$folder/$file"
done
# Reader and projector run under the same existing account, keeping SQLite/WAL
# permissions compatible without making the subscription credentials public.
chown "$publisher_user" "$folder/vstp-kafka-config.json"
if [[ -f $folder/vstp.sqlite3 ]]; then chown "$publisher_user" "$folder/vstp.sqlite3"*; fi
sed "/^\[Service\]/a User=$publisher_user" mcv-vstp-reader.service > "$staging/installed.service"
install -m 644 "$staging/installed.service" /etc/systemd/system/mcv-vstp-reader.service
systemctl daemon-reload
systemctl enable mcv-vstp-reader
systemctl restart mcv-vstp-reader
systemctl restart mcv-unit-publisher
systemctl is-active mcv-vstp-reader mcv-unit-publisher
echo 'VSTP installed. Deploy the matching worker.mjs to accept numeric VSTP UIDs.'
echo 'First replay must catch up before VSTP routes become usable; publication still runs every 120 seconds.'
echo 'journalctl -u mcv-vstp-reader -n 15 --no-pager'
echo 'journalctl -u mcv-unit-publisher -n 20 --no-pager'
