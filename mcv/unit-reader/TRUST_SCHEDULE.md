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

The original `trust-projection.sqlite3` indexes lifecycle messages and MCV movements from
the existing raw archive incrementally. It commits its cursor with the index,
so restarts can retry safely. Index events expire after 48 hours. If the raw
archive is replaced and its row IDs reset, the projector fails closed; stop
the publisher and rebuild its disposable projection index before restarting.

## Victoria movement reports on Darwin services

The same snapshot now includes a separate `movements` array for stopping
services with a validated arrival or departure report at MCV, including
passenger services. It uses the existing activation, timetable, lifecycle and
clock checks. It does not add standalone passenger rows or another consumer.

The Worker attaches `trustMovement` only when UID, headcode, origin operating
date and all supplied MCV booked minutes agree with exactly one Darwin row.
Duplicate report identities or duplicate Darwin identities are withheld.
These are WTT reports; services whose public booked times differ may remain
unmatched. Existing projection windows still apply, including five-minute
retention after a reported departure or terminating arrival.

The staff board, operational details and staff platform display label the
supplement separately as `TRUST at Victoria`, showing arrival/departure and
the platform supplied by the report. Darwin's status, forecasts, actuals,
cancellation flags and current platform are preserved. Reports disappear when
the shared snapshot/feed freshness deadline expires, even during fetch errors.
This reports a recorded event, not continuous platform occupancy.

For activation, install this commit's publisher using the installer above and
deploy the same commit's `worker.mjs` in the existing Worker. The installer
previews both ECS rows and the movement report array. No new secrets, bindings
or database rebuilds are needed. Old publishers omit the optional array; old
Workers ignore it, so components can be updated independently. Confirm
`TRUST Victoria movement reports: N` in the publisher log and
`_mcv.trustMovementsMatched` on `/staff-departures`. A zero count is valid if
no recent reports satisfy the match checks.

## Booked calling points when Darwin omits the pattern

The snapshot also carries optional `routes` for activated, unambiguously
matched stopping services in the existing projection window. The route uses
the applicable imported Network Rail timetable, not a forecast from TRUST.
Passenger calls require a nonzero public arrival/departure time and a station CRS;
passing locations and operational-only stops are excluded. ECS uses booked
operational stops. Only stops after MCV are supplied by this fallback.

The Worker matches the same unique UID/headcode/operating date and MCV booked
minutes as movement reports, and requires its last call to match Darwin's sole
destination. It supplies `trustCallingPoints` only if Darwin supplies no onward
calling points or subsequent locations at all. Partial live patterns, cancelled
calls, cancelled trains, diversions, future cancellations and trains without a
booked MCV departure do not receive fallback calls. Lifecycle changes and
ambiguous timetable variants remain withheld by the existing projector.

Both staff displays label the result `TRUST timetable · booked stops`. The
staff details show booked public times without invented forecasts; CSV exports
identify the calling-point source. Darwin data is left intact and takes over
on the next update that supplies a pattern. Fallback calls expire with the
shared TRUST freshness deadline, including retained departed rows.

Update the publisher with the same installer and deploy the matching Worker.
The publisher logs `TRUST booked calling patterns: N`; the staff endpoint
reports `_mcv.trustCallingPatternsMatched`. No extra reader, KV binding or
database import is needed. No activation or no suitable timetable means the
existing missing-pattern message remains. Optional routes are dropped first
if the combined upload reaches its size budget. Public endpoints are unchanged.

## Last report, captured journey history and completed dwell

`histories` is an optional part of the same publisher snapshot. The publisher
prioritises services on the current staff board. Projection requires a unique
activation identity, an applicable timetable and one stopping visit to MCV
within six hours past/two hours ahead. The Worker again requires the exact
UID, headcode, operating date and all supplied MCV booked minutes; ambiguous
identities are withheld. Histories are also attached to standalone TRUST ECS.

The new disposable index is `trust-history-projection.sqlite3`, separate from
the old MCV-only index so previewing an upgrade does not change the old
publisher's interpretation of movements. It scans retained lifecycle messages
first, then retains movement reports for train IDs activated against MCV UIDs.
It uses the existing raw archive, not another consumer. The first replay may
take several minutes; timetable refreshes replay movement matching against the
new schedule set. Raw capture and index retention remain 48 hours. Missing
activation, capture started mid-journey, very late activation or missing reports
can leave gaps: the UI does not describe this as a complete journey record.
If the raw archive is replaced and row IDs reset, rebuild the disposable
`trust-history-projection.sqlite3` with the publisher stopped before restarting.

Reports are matched to an unambiguous location and planned event in the
applicable route, with the existing BST/winter and actual-minus-planned clock
checks. Unknown, future, off-route, failed-stop and corrected events are not
presented as movement evidence. Corrections withdraw the corresponding
location/event type. After an origin/identity/location change the history shows
the lifecycle message but withholds subsequent movement interpretation until
route reconciliation is implemented. Earlier reports remain explicitly dated.

Staff service details show the last matched movement's location, report time,
age, reported platform and lateness relative to the working timetable. This
is a last report, not a continuously tracked position. The timeline includes
arrivals, departures and passes, plus activation, cancellation, reinstatement
and origin/identity/location changes. Lifecycle timestamps are receipt times,
labelled `Received`, rather than guessed conversions of their event clocks.
Darwin's current status, platform and forecasts remain authoritative in the
existing display. A cancellation/reinstatement entry is historical evidence.

Completed dwell at Victoria is calculated in the Worker only when exactly one
matched arrival and departure report survive validation, departure is not before
arrival, and the interval is at most 12 hours. It does not show an accumulating
occupancy timer from an arrival alone. Corrections or missing reports can make
dwell unavailable. History is bounded to 48 movement events (preserving Victoria
reports) and 12 lifecycle messages, and expires with TRUST snapshot freshness,
including when the board falls back to cached data. Oversized uploads compact
histories to Victoria/lifecycle/latest reports, then drop optional histories.

Update the server using this commit's `install-trust-publisher.sh`, and deploy
the same commit's `worker.mjs`. The installer previews counts under the service
account before replacing files, retaining the old publisher backup. No reader,
secret or KV binding changes are needed. Verify `TRUST journey histories: N`
in publisher logs and `_mcv.trustHistoriesMatched` on `/staff-departures`.

## Checks

```bash
python -m unittest -v test_trust_snapshot.py
node test_trust_worker.mjs
```

Checks cover real 3D32 BST timing, winter/midnight clocks, transition ambiguity,
wrong/future/off-route reports, lifecycle suppression and reinstatement,
departure expiry, incremental replay, stale input, Worker input sanitisation,
Darwin deduplication, public isolation and shared-adapter dates/statuses.

