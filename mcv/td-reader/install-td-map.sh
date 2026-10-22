#!/usr/bin/env bash
set -euo pipefail
commit=${1:?Supply a full reviewed commit SHA}
[[ $commit =~ ^[0-9a-f]{40}$ && $EUID == 0 ]] || exit 1
folder=/opt/mcv-td-reader
python=/opt/mcv-unit-reader/.venv/bin/python
[[ -f $folder/td.sqlite3 && -f /opt/mcv-unit-reader/unit-ingest-token.txt ]] || { echo 'Existing TD capture and ingestion token required'; exit 1; }
staging=$(mktemp -d)
trap 'rm -rf "$staging"' EXIT
for file in td_map.py td_map_publish.py td_reader.py td_inspect.py test_td_map.py mcv-td-map.service; do
 curl -fsSL "https://raw.githubusercontent.com/RoGroup/rogroup.github.io/$commit/mcv/td-reader/$file" -o "$staging/$file"
done
cd "$staging"
"$python" -m unittest -v test_td_map.py
for file in td_map.py td_map_publish.py; do install -m 644 "$file" "$folder/$file"; done
install -m 644 mcv-td-map.service /etc/systemd/system/mcv-td-map.service
systemctl daemon-reload
systemctl enable --now mcv-td-map
systemctl restart mcv-td-map
echo 'TD map publisher installed. Deploy the updated Worker, then check journalctl -u mcv-td-map -n 10 --no-pager.'
