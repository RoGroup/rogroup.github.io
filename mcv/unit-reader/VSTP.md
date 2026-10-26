# VSTP schedules for the MCV staff hub

VSTP is a separate Kafka reader and local SQLite overlay. It supplements the
existing daily timetable, TRUST matching and booked-pattern publisher. It never
creates a passenger departure from a schedule alone, supplies live actuals or
changes the existing Gemini/Darwin precedence. ECS still requires matching TRUST
activation. Current board identity, operating date, headcode, MCV booked times,
route destination and live-pattern precedence remain required.

## Inputs and format

The broker provided by the user is
`pkc-z3p1v0.europe-west2.gcp.confluent.cloud:9092`, using SASL_SSL / PLAIN and the
system CA bundle. Copy the **Kafka topic** from the VSTP subscription's Pub/Sub
page; do not infer it from legacy ActiveMQ documentation. Account-specific group,
username and password are entered locally by `vstp_setup.py`, never committed.
Setup refuses to reuse a configured TRUST, Gemini or TD consumer group.

Format reference supplied by the user:
https://wiki.openraildata.com/index.php/VSTP . Network Rail links that wiki for
technical feed formats from its open-data page:
https://www.networkrail.co.uk/who-we-are/transparency-and-ethics/transparency/open-data-feeds/ .

Supported: `VSTPCIFMsgV1`, Create/Update/Delete, complete single-segment routes,
nested `location.tiploc.tiploc_id`, HHMMSS clocks with seconds 00 or 30, public
minute clocks, ordinary letter-plus-five-digit and space-plus-five-digit UIDs.
Space-prefixed UIDs become canonical five-digit strings; they are not padded with
an invented letter. The Worker accepts these exact additional UID shapes and
trims a Darwin UID only for identity comparison. Gemini allocation matching is
unchanged; numeric UIDs are not guessed from LINX identifiers.

The standard daily-CIF STP precedence, applicability and conservative holiday
rules are retained. No current running platform, formation, signal state or speed
is inferred from VSTP. Multi-segment messages and unsupported clocks/envelopes are
quarantined rather than flattened. On an unrecognized schedule change, the reader
stops without acknowledging it and latches a blocked flag, withholding timetable
projection until inspected. This can withhold TRUST/booked supplements but cannot
stop Gemini publication. Do not clear that flag or alter Kafka offsets without
reconciling the saved raw message.

## Storage and consistency

`vstp.sqlite3` stores compressed original messages keyed by topic/partition/offset,
normalized versions keyed by UID/start date/STP, deletion tombstones, a revision,
and a broker catch-up heartbeat. One SQLite FULL/WAL transaction saves the batch
and schedule changes before synchronous Kafka acknowledgement. Replayed offsets
are idempotent. Older event timestamps cannot replace newer changes; conflicting
same-timestamp versions block projection. Keep all relevant identities, including
schedules updated away from MCV and deletions. Only MCV route payloads are retained
in the normalized projection; raw envelopes retain the source data.

A group without saved offsets starts at its available earliest offsets; restarts
resume committed offsets. Lost/out-of-range committed offsets block projection,
rather than silently skipping a gap. Available broker history is not a guaranteed
complete initial timetable: only captured VSTP versions can be used.

The projector attaches that store read-only and builds a temporary combined view;
it never writes to `schedules.sqlite3`. Daily replacement therefore leaves VSTP
intact. A VSTP row replaces the matching daily variant. A Delete removes that
variant and suppresses a same-key daily copy; unrelated permanent variants retain
normal precedence. Cancelled and diverted versions prevent old MCV routes being
selected. Daily extract changes and newly relevant MCV UID membership invalidate the
disposable TRUST movement-history index so newly captured schedules can match
earlier activations/movements. Edits for existing UIDs are resolved against the
current schedule view without rescanning the national archive.

The heartbeat is renewed only after the reader confirms its assigned partition
positions have caught up to broker watermarks. Stale (over three minutes) VSTP
route payloads are withheld, retaining their suppression of superseded base
variants. Timetable freshness still requires a daily extract less than 36 hours
old. VSTP does not replace daily delivery or its location-reference database.

Raw capture is pruned to three days, 20,000 batches and 256 MiB compressed payloads;
SQLite overhead and one pruning interval are additional. Normalized versions and
tombstones expire seven days after their end dates. No web listener is added.

## Deploy on the existing host

1. Deploy the matching `mcv/unit-reader/worker.mjs` to the existing Worker,
   retaining its bindings and secrets. The UID validators now support numeric
   VSTP identities. No new endpoints, KV keys or writes are added.
2. As root on the reader server, use the full reviewed commit:

```sh
mcv_commit=REPLACE_WITH_FULL_COMMIT_SHA
curl -fsSL "https://raw.githubusercontent.com/RoGroup/rogroup.github.io/$mcv_commit/mcv/unit-reader/install-vstp.sh" -o /tmp/install-mcv-vstp.sh
bash /tmp/install-mcv-vstp.sh "$mcv_commit"
```

The installer runs offline tests, prompts for credentials only when absent,
checks Kafka metadata without consuming, then installs the overlay/projector and
starts `mcv-vstp-reader`. It uses the existing publisher service account so config,
SQLite and WAL remain private and accessible to both processes. Source backups
are saved as `.before-vstp`. Only the new VSTP reader and existing publisher are
restarted. Gemini/TRUST capture, daily refresh, disabled TD/map services, frontend
files, Worker deployment, bindings and secrets are not changed by this script.

Publisher interval stays 120 seconds; the recent archive stays 600 seconds.
VSTP adds no KV writes. There are no additional browser polling requests.

Inspect:

```sh
journalctl -u mcv-vstp-reader -n 15 --no-pager
journalctl -u mcv-unit-publisher -n 20 --no-pager
```

Expect `caught_up=True` after the available replay. Zero schedule matches is
normal until a captured VSTP concerns a currently displayed service. A fresh daily
file and TRUST feed are independently required by existing projection rules.
Actual Kafka envelope and permissions still need verification on the server.

To pause: `systemctl disable --now mcv-vstp-reader`. Its known affected schedules
will expire from the usable projection after the freshness deadline; they do not
silently fall back to older base versions. Full rollback needs the previous
`trust_snapshot.py` and `recent_services.py` backups plus a publisher restart;
retain the VSTP database for inspection.

Tests: `python -m unittest -v test_vstp.py test_trust_snapshot.py test_schedule_import.py test_recent_services.py`.
Also run `node test_trust_worker.mjs`, `node test_recent_worker.mjs`, and
`node test_td_worker.mjs`. Tests use synthetic fixtures; no credentials/network.
