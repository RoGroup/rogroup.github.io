# Manchester events tab

The staff navigation opens `staff.html#events` within the existing page. Switching back preserves the staff board, its selection and filters. Event files use their own importer and KV key; train readers and publishers are not restarted or modified.

## Install

1. Deploy this revision's `worker.mjs` in the existing Cloudflare Worker, retaining `UNIT_ALLOCATIONS` and `UNIT_INGEST_KEY`.
2. Copy the delivered `manchester_bi.json` into `/srv/rdm-upload/incoming/manchester_bi.json` on the existing server. For the initial upload from Windows PowerShell:

   ```powershell
   scp -i "$env:USERPROFILE\Downloads\ssh-key-2026-10-06.key" "$env:USERPROFILE\Downloads\manchester_bi.json" root@46.225.37.70:/srv/rdm-upload/incoming/manchester_bi.json
   ```

3. Run `bash install-events.sh FULL_COMMIT_SHA` as root after downloading the script from the same commit. It tests and validates before installing the independent importer. The existing publisher identity is used; the existing ingest secret remains local. No new Cloudflare binding or credential is needed.
4. The first timer check is after two minutes, then every 30 minutes. Uploads must settle for 120 seconds. Check `journalctl -u mcv-events-import -n 20 --no-pager` for publication. Read caching may take another minute to reflect a replacement.

For daily delivery, use the existing RDM SFTP incoming destination used by the timetable, with filename `manchester_bi.json`. The timer watches the delivered file; it does not log into RDM or download from the subscription. RDM's file-transfer setup is a separate user action.

## Data handling

- Full snapshots replace previous events, including removals. Event/place references, duplicate identities, explicit time zones and bounded sizes are validated. Failed uploads do not acknowledge the local file. Unchanged checksum + modification time produces no KV write.
- Raw uploaded data is not part of this source repository. The importer emits just the fields used by the staff tab into the independent `mcv-staff-events-v1` KV value. Ingestion is authenticated with the existing token. Stored snapshots expire after seven days; files over 48 hours old are visibly marked stale.
- Normal daily delivery adds one write when the file changes. Even if every scheduled check sees a changed file, the 30-minute timer performs at most 48 scheduled writes per day. Manual runs are additional. The existing allocation/archive upload cadences do not change.
- The Events view fetches only on opening, on manual refresh, and at most every ten minutes while visible. It makes no additional train-feed requests. The normal staff board continues its existing refresh while the Events view is selected.
- The file contains events, venues and individual performances. A schedule's start/end bound the group of performances; its end is **not** the finish of each performance. Only an explicitly supplied performance `duration` (minutes) produces an estimated finish. Date-only and `time_unknown` records remain labelled; no midnight start is invented. London dates/times and overnight finishes are preserved.
- `capacity.calculated` is shown as a performance calculation; `place.capacity.max` is a labelled venue-maximum fallback. Neither is attendance or expected rail demand. Capacity is not summed into a passenger forecast.
- Source station-distance entries do not declare a distance unit in the supplied bespoke file/default specification. Only the nearest listed station ordering is displayed; no kilometres/miles or walking time is invented.
- The file has no snapshot publication timestamp. The displayed receipt time comes from the delivered file's modification time, and is labelled accordingly. Event-record modification timestamps are never presented as the freshness of the whole dataset.
- Booking and venue links allow HTTP(S) only. Display text is normalized to plain text and escaped. Cancelled and sold-out performances retain their flags. The sample is not treated as exhaustive Manchester coverage.

Schema reference: [Data Thistle Default Feed Specification](https://files.datathistle.com/feeds/docs/feedspec.pdf).
