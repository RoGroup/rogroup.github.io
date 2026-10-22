# TRUST timetable preparation

The TRUST capture service stores movement and activation messages in
`/opt/mcv-unit-reader/trust.sqlite3`. The timetable importer is a separate,
manual preparation step. It does not modify the capture database, consume Kafka
messages, upload anything to Cloudflare, or add rows to the live staff board.

Download the latest **full JSON** timetable from the RDM NWR Schedule product:
`CIF_ALL_FULL_DAILY_toc-full.json.gz`. Keep it compressed. Daily update files are
not accepted by this importer. The full extract also contains TIPLOC, STANOX
and CRS mappings in its `TiplocV1` records.

On the server, with the downloaded file in `/opt/mcv-unit-reader/`:

```bash
cd /opt/mcv-unit-reader
.venv/bin/python -m unittest -v test_schedule_import.py
.venv/bin/python -u schedule_import.py CIF_ALL_FULL_DAILY_toc-full.json.gz --check-uid P28858 --date 2026-10-22
```

The importer streams the gzip file, builds a new database beside
`schedules.sqlite3`, and replaces it only after reaching the timetable EOF and
passing an integrity check. A failed import leaves the previous database in
place. Keep enough free space for the source file, temporary index of the full
extract, and old database during replacement. Rerunning a full import replaces
the snapshot; it does not apply updates incrementally. Query processes must
reopen the database after replacement to see the new snapshot.

Only UIDs with at least one MCV schedule are kept in the final database. Every
variant for those UIDs is retained, including cancellations and overlays which
do not visit MCV. This prevents a cancelled or diverted permanent schedule
appearing accidentally. Complete route payloads are stored for MCV variants;
other variants retain the identity and applicability information needed to
suppress the permanent schedule. Timetable associations are not imported yet.

The lookup uses the origin operating date and weekday, then STP precedence
`C`, `N`, `O`, `P`. Same-precedence ambiguity and bank-holiday restrictions are
reported as unresolved. The timetable's `applicable_timetable` must be `Y`.
There is no headcode-only matching. This lookup does not reconcile a later
TRUST reinstatement with a timetable cancellation.

The 22 October 2026 extract contains the permanent P28858/3D32 schedule from
Newton Heath depot to Chester: MCV arrival 04:37, departure 04:48, platform 4.
These are booked times/platform, not proof of current physical position.

Before a live board integration, add activation/date matching, TRUST lifecycle
handling (including corrections, cancellation and identity changes), timestamp
normalisation, freshness/retention rules, and deduplication against Darwin.
TRUST `direction_ind` is not by itself an east/west route instruction. Keep
TRUST-only non-passenger services on staff screens. Refresh the full timetable
daily; very short term schedules require the separate VSTP feed.
