# MCV unit allocation integration

The Oracle reader stores complete, latest LINX train snapshots in SQLite. The publisher looks up the services currently listed by the staff Worker, selects unit allocations covering their booked MCV arrival/departure, and uploads one small snapshot every 120 seconds over HTTPS. The Worker joins by exact service ID, UID, headcode, operating date and booked movement times. The browser treats numbers as allocations and hides snapshots older than six minutes.

One KV upload per two minutes is approximately 720 writes per day. This integration also uses Workers requests and KV reads; those share the account's free quotas. KV propagation and the existing board cache add delay. This is not a guarantee of the stock physically present at the platform. Existing carriage-count and reverse-formation information continues to come from the staff board.

## Cloudflare configuration

1. Create a Workers KV namespace named `mcv-unit-allocations`.
2. On the existing MCV proxy Worker, add a KV binding called `UNIT_ALLOCATIONS`, pointing to that namespace.
3. Generate an upload token on Oracle:

```bash
/opt/mcv-unit-reader/.venv/bin/python -c 'import os,secrets; from pathlib import Path; os.umask(0o077); token=secrets.token_urlsafe(32); path=Path("/opt/mcv-unit-reader/unit-ingest-token.txt"); path.write_text(token); path.chmod(0o600); print(token)'
```

Copy the printed token into a new Worker secret named `UNIT_INGEST_KEY`. The existing RDM secrets remain in place. The token stays on Oracle and in Cloudflare; do not put it in the repository or staff page.

4. Replace the existing Worker's code with `worker.mjs` and deploy it. Before a snapshot arrives the departures routes still work, with unit information unavailable.

## Oracle publisher

Download `publisher.py` and `mcv-unit-publisher.service` into Windows Downloads. Upload them from a local PowerShell tab:

```powershell
scp -i "$env:USERPROFILE\Downloads\ssh-key-2026-10-06.key" "$env:USERPROFILE\Downloads\publisher.py" "$env:USERPROFILE\Downloads\mcv-unit-publisher.service" opc@144.21.58.146:/opt/mcv-unit-reader/
```

In the connected Oracle terminal:

```bash
sudo restorecon -RF /opt/mcv-unit-reader
sudo cp /opt/mcv-unit-reader/mcv-unit-publisher.service /etc/systemd/system/
sudo restorecon /etc/systemd/system/mcv-unit-publisher.service
sudo systemctl daemon-reload
sudo systemctl enable --now mcv-unit-publisher
sudo systemctl status mcv-unit-publisher --no-pager
```

The first upload happens after two minutes. Check processing and publication with:

```bash
sudo journalctl -u mcv-unit-reader -n 8 --no-pager
sudo journalctl -u mcv-unit-publisher -n 8 --no-pager
```

Inspect `https://mcv-rdm-proxy.railstaffhub.uk/units` for `available: true`, then check `unitAllocation` on `/staff-departures`. Refresh `/mcv/staff.html` to see allocations below formation and in operational details. Entries without an unambiguous matching snapshot or valid journey segment remain unavailable. A service arriving with different units from its departing formation is displayed separately in arrival and departure views and in CSV exports.

## Assumptions and limits

- The observed LINX Core contains the four-character headcode followed by the six-character CIF UID. A UID/date/headcode match is required; no headcode-only fallback is used.
- Route TIPLOCs must agree when supplied by the board. Multiple matching train variants are left unmatched rather than guessed.
- Only message status `1` and six-digit resource groups of type `U` are displayed. Other statuses/types remain unavailable until their semantics are confirmed.
- Allocations are evaluated at booked, not delayed, movement times, so a late train does not accidentally switch to another journey segment.
- Stored snapshots older than three days are pruned hourly by the reader. Kafka offsets are committed only after SQLite has stored the snapshot.
- The reader reports service activity; this is not a separate guarantee of Kafka broker freshness. The UI displays the allocation message timestamp for review.

## Validation performed

Sample XML parsing and rejection of older updates; publisher UID/date/headcode/route checks and different units either side of a segment boundary; Worker authenticated ingestion, stale-snapshot rejection, exact service matching and preservation of departures without KV configured; shared-data unit propagation and frontend JavaScript syntax. Full live verification requires the KV binding, secret and publisher service to be configured.
