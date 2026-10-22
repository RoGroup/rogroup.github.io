#!/usr/bin/env bash
# Run locally on the reader server; credentials are never passed to GitHub.
set -euo pipefail
commit=${1:?Usage: bash install-td-reader.sh COMMIT_SHA}
[[ $commit =~ ^[0-9a-f]{40}$ ]] || { echo 'Expected a full Git commit SHA'; exit 1; }
[[ $EUID == 0 ]] || { echo 'Run this installer as root on the reader server'; exit 1; }
folder=/opt/mcv-td-reader
python=/opt/mcv-unit-reader/.venv/bin/python
[[ -x $python ]] || { echo 'Existing MCV Python environment not found'; exit 1; }
"$python" -c 'import confluent_kafka, ssl'
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
for file in td_reader.py td_setup.py td_inspect.py test_td_reader.py mcv-td-reader.service; do
    curl -fsSL "https://raw.githubusercontent.com/RoGroup/rogroup.github.io/$commit/mcv/td-reader/$file" -o "$staging/$file"
done
cd "$staging"
"$python" -m unittest -v test_td_reader.py
install -d -m 750 "$folder"
if [[ ! -f $folder/td-kafka-config.json ]]; then
    echo 'Copy the group, username and hidden password from the TD subscription.'
    "$python" td_setup.py --folder "$folder"
fi
chmod 600 "$folder/td-kafka-config.json"
# Metadata-only preflight: no topic messages or offsets are consumed.
"$python" td_reader.py --folder "$folder" --check
# Update only this capture service; other MCV readers remain running.
for file in td_reader.py td_setup.py td_inspect.py; do
    if [[ -f $folder/$file ]]; then cp -p "$folder/$file" "$folder/$file.before-update"; fi
    install -m 644 "$file" "$folder/$file"
done
install -m 644 mcv-td-reader.service /etc/systemd/system/mcv-td-reader.service
systemctl daemon-reload
systemctl enable mcv-td-reader
systemctl restart mcv-td-reader
systemctl is-active mcv-td-reader
echo 'TD reader installed. Wait 30–60 seconds, then inspect its log and capture summary.'
echo 'journalctl -u mcv-td-reader -n 20 --no-pager'
echo '/opt/mcv-unit-reader/.venv/bin/python /opt/mcv-td-reader/td_inspect.py'
