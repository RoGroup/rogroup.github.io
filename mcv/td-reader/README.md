# MCV Train Describer capture — map groundwork

This is the first server-side stage of the MCV signalling map. It captures the
RDM **NWR Train Describer** subscription independently of TRUST and Gemini.
It does not yet draw a map, identify Victoria berths, infer occupied track,
interpret signal bits or confirm that a headcode uniquely identifies a service.
The existing Traksy map remains in place.

## Connection

The non-secret connection details supplied from the TD subscription are:

- Topic: `TD_ALL_SIG_AREA`
- Bootstrap broker: `pkc-z3p1v0.europe-west2.gcp.confluent.cloud:9092`
- Transport: `SASL_SSL`, mechanism `PLAIN`, verified system CA bundle

The TD consumer group, username and password/API secret are entered interactively
**on the server** by `td_setup.py`; none belongs in this repository. The file is
installed atomically at `/opt/mcv-td-reader/td-kafka-config.json` with mode `0600`.
Use the group from the TD subscription, rather than a TRUST/Gemini group.

## Install on the existing reader server

Use a reviewed full commit SHA from this repository:

```sh
mcv_commit=REPLACE_WITH_FULL_COMMIT_SHA
curl -fsSL "https://raw.githubusercontent.com/RoGroup/rogroup.github.io/$mcv_commit/mcv/td-reader/install-td-reader.sh" -o /tmp/install-mcv-td.sh
bash /tmp/install-mcv-td.sh "$mcv_commit"
```

The installer checks the existing `/opt/mcv-unit-reader/.venv/bin/python`
Confluent Kafka dependency, downloads and runs the capture tests, prompts for
credentials only if no TD config exists, and performs a metadata-only topic
check. That check does **not** consume messages or change offsets. Actual
consumer-group access is established when the service starts. It then installs
and starts only `mcv-td-reader.service`; it does not restart existing readers or
change the publisher, Worker, Pages or timetable refresh.

The new service runs as root with no listening port, a read-only filesystem outside its
own working directory, restricted address families, memory/CPU bounds and a
restrictive umask. Source files are public; only local config/raw captures are
private. No credentials or account-specific group/user defaults are committed.

After 30–60 seconds:

```sh
journalctl -u mcv-td-reader -n 20 --no-pager
/opt/mcv-unit-reader/.venv/bin/python /opt/mcv-td-reader/td_inspect.py
```

Look for increasing saved batch/event totals and a recent `lastCaptureAt`.
`is-active` alone is not evidence of received data. The inspection summary lists
observed message envelope types and TD area IDs. Those area IDs are not yet
mapped to Victoria or labelled geographically.

To find observed berth messages for a headcode currently near Victoria:

```sh
/opt/mcv-unit-reader/.venv/bin/python /opt/mcv-td-reader/td_inspect.py --headcode 2N01 --minutes 10
```

Replace the sample headcode with a current one. `--area XX` filters an **observed**
area ID; `XX` is a placeholder, not a claim about Victoria. Samples show only
observed area, description, from/to berths and original message timestamp plus
receipt timestamp. No inferred platform, track position or signal aspect is
published. A headcode can appear in multiple locations or refer to non-train
text; sample matches do not establish unique service identity.

## Persistence and bounded capture

`td.sqlite3` stores original compressed payload bytes under a unique
(topic, partition, offset) key. SQLite WAL with synchronous FULL commits first;
only then is that Kafka message acknowledged synchronously. Broker commit
failure can replay safely; duplicate offsets do not overwrite original receipt
times. Malformed/unknown envelopes are retained for inspection and acknowledged
only after durable storage, so one unexpected record does not block the feed.

For a consumer group with no saved offsets, start at **latest**, avoiding a
national historical replay. Subsequent restarts resume its committed offsets.
There is no derived berth state to restore or clear at this stage. Gaps during
downtime or after broker retention expires remain possible.

Retention is up to six hours, capped at 100,000 batches and 512 MiB of compressed
payloads. Prune on startup and once per minute; the oldest rows go first. SQLite
file/index/WAL overhead and one pruning interval can exceed the payload bound;
freed pages are reused rather than guaranteeing immediate file shrinkage. This
national discovery capture will be narrowed after the relevant areas are
verified. Inspection scans at most 10,000 batches inside its requested window and
reports if that limit is reached. The report is a bounded sample, not a complete
national statistics service.

## Reconfigure or stop

```sh
systemctl stop mcv-td-reader
/opt/mcv-unit-reader/.venv/bin/python /opt/mcv-td-reader/td_setup.py
/opt/mcv-unit-reader/.venv/bin/python /opt/mcv-td-reader/td_reader.py --check
systemctl reset-failed mcv-td-reader
systemctl start mcv-td-reader
```

Do not delete `td.sqlite3` to troubleshoot authentication. Its capture is
independent of all existing board data. To pause this stage:

```sh
systemctl disable --now mcv-td-reader
```

## Next stage

Collect real C-class berth-step/interpose/cancel examples around several known
Victoria services; identify area/berth IDs using released reference documents
and observed transitions. Verify the track diagram and mapping before creating
an SVG layout and browser endpoint. Live train description updates will be
separate from any future verified S-class signal/occupancy interpretation.

Network Rail describes TD as signal-berth-level train positioning data in its
[Data Feeds Developer Pack, section 4.2](https://odmcr.files.wordpress.com/2012/06/developer-pack-for-network-rail-data-feeds.pdf).
The historical pack's transport instructions are not used here; the Kafka
connection is taken from the user's current RDM subscription details.

Tests: `python -m unittest -v test_td_reader.py` (no Kafka connection required).
