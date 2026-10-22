# TRUST timetable and staff ECS integration

The Hetzner host captures `TRAIN_MVT_ALL_TOC` batches durably in
`/opt/mcv-unit-reader/trust.sqlite3`. `schedule_import.py` separately imports a
full Network Rail JSON timetable into `schedules.sqlite3`. No additional Kafka
consumer is started for the integration.

## Timetable import

Download **CIF_ALL_FULL_DAILY_toc-full.json.gz** from RDM NWR Schedule. Keep it
compressed. On the server:

```bash
cd /opt/mcv-unit-reader
.venv/bin/python -u schedule_import.py CIF_ALL_FULL_DAILY_toc-full.json.gz --check-uid P28858 --date 2026-10-22
```

The importer streams a full file, checks its EOF and database integrity, and
atomically replaces the previous database. Failed imports leave it intact.
Keep space for the source file, temporary full metadata index and old database.
Daily incremental update files are not accepted. Each lookup process must
reopen the database after a replacement.

Every variant of a UID with an MCV schedule is retained, including cancellations
and diverted overlays without MCV. Complete route payloads are stored for MCV
variants; other variants retain their applicability metadata. The lookup uses
the origin operating date and weekday, then STP precedence C, N, O, P.
Ambiguous same-precedence schedules and bank-holiday restrictions are withheld.
Timetable associations and VSTP are not imported. Refresh the full file daily.
Automatic RDM delivery is not configured by this code; it requires the user's
RDM File transfers configuration. A timetable older than 36 hours is withheld.

The 22 October 2026 extract includes P28858/3D32, Newton Heath depot to Chester,
calling at MCV 04:37–04:48, booked platform 4. MCV's STANOX mapping, 31510, comes
from the same extract's TiplocV1 records.

## Publisher and Worker activation

Run `install-trust-publisher.sh COMMIT_SHA` as root on the Hetzner host. It
downloads the publisher, projector, importer dependency and Python tests into
a temporary folder; tests and previews under the publisher's service account
before installing the projector and publisher. Existing files receive a
`.before-trust` backup. It restarts **mcv-unit-publisher**, not either reader.
If the service account cannot access TRUST databases, installation stops before
replacing the existing publisher. Fix the account permissions before retrying.

Deploy the **same commit's worker.mjs** manually in the existing Cloudflare
Worker. Reuse UNIT_ALLOCATIONS and UNIT_INGEST_KEY; no new secrets or KV binding
are required. Frontend files deploy through GitHub Pages. Updating GitHub alone
does not deploy the Worker or server files.

The publisher includes TRUST inside its existing `/unit-ingest` snapshot every
120 seconds. This uses one existing KV write per upload, rather than a second
write stream. TRUST preparation errors do not stop allocation publication.
Inspect logs after the initial 120-second wait:

```bash
journalctl -u mcv-unit-publisher -n 12 --no-pager
```

`/staff-departures` and `/staff-details` merge valid TRUST-only rows and expose
`_mcv.trustAvailable`, `trustSnapshotAt`, and `trustServicesAdded`. Darwin wins
UID/date and same-headcode/date conflicts. `/departures` does not read or merge
TRUST, so public displays receive no additional non-passenger rows. Frontend
staff views label TRUST, distinguish booked/reported platforms, and expire
TRUST rows using the supplied deadline, including after a feed update failure.

## Scope and time interpretation

The first integration adds **activated EE-category ECS stopping at MCV**. It
does not add unactivated timetable entries, passing trains, light engines,
freight or passenger services. No future arrival/departure forecasts are
invented. Calling times and routes remain booked data. The display window is
two hours ahead and 30 minutes past booked time; a recent arrival can retain a
late row for up to 30 minutes after that report. Departures and terminating
arrivals remain available for five minutes, then expire. This is not a
continuous physical-occupancy tracker.

Movement reports must agree with their planned MCV event in the matched
schedule. Both local-clock-encoded and ordinary Unix planned timestamps are
recognised, and the actual time is derived from the actual-minus-planned
delta. An inconsistent, off-route or future report does not confirm arrival.
Daylight-saving transition ambiguity is withheld rather than guessed.
`auto_expected` indicates whether an automatic report is expected at the
location; it does not make an ARRIVAL message a future forecast.

TRUST message 0002 suppresses a row until a later 0005 reinstatement. Routes
with 0006/0007/0008 changes, MCV corrections, failed stops, or early termination
reports are withheld pending complete reconciliation. A reinstatement does
not override a timetable C record. Missing activation, unresolved identity or
multiple MCV visits also withhold the row. Feed capture must be less than three
minutes old when projected. Allowing for the two-minute upload interval and
KV caching, the Worker expires feed timestamps after five minutes and snapshots
after six minutes. Booked route direction is
only inferred from recognised immediate onward TIPLOCs, not UP/DOWN.

`trust-projection.sqlite3` indexes lifecycle messages and MCV movements from
the existing raw archive incrementally. It commits its cursor with the index,
so restarts can retry safely. Index events expire after 48 hours. If the raw
archive is replaced and its row IDs reset, the projector fails closed; stop
the publisher and rebuild its disposable projection index before restarting.

## Checks

```bash
python -m unittest -v test_trust_snapshot.py
node test_trust_worker.mjs
```

Checks cover real 3D32 BST timing, winter/midnight clocks, transition ambiguity,
wrong/future/off-route reports, lifecycle suppression and reinstatement,
departure expiry, incremental replay, stale input, Worker input sanitisation,
Darwin deduplication, public isolation and shared-adapter dates/statuses.
