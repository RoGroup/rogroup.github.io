# Victoria platform map preview

`/mcv/map.html` is independent of the staff board and its Traksy iframe. The original
track schematic displays SMART arrival observations and a recent movement log,
not exact train positions, occupied track, signals or points. Shared berth IDs go
in a separate lane unless a complete observed step resolves the association.
Headcodes open a local evidence dialog; the staff-board link opens the board, not
a claimed unique service match. Native scrolling and zoom buttons support mobile.

## Reference and limits

Rules in `td_map.py` were transcribed from the MNCRVIC SMART rows in the user's
four screenshots dated 22 October 2026, obtained from
https://vaildata.uk/bplan/tiploc?loc=MNCRVIC (Network Rail SMART via Vail Data).
They preserve Up-arrival / Down-departure reporting offsets. The collapsed rows
are reference associations, not a fully validated current signalling layout.
No S-class interpretation, track connectivity or platform occupancy is inferred.
In particular `0702 → 0581` associates an arrival with platform 5, while `0610 →
0803` associates one with platform 4. Offsets are shown as evidence, never used
as physical arrival countdowns. No live service identity is inferred from a
headcode alone.

The publisher reads existing capture in SQLite read-only mode. Every 65 seconds
it replays at most the newest 10,000 batches from 20 minutes, in message timestamp
order, selecting M3 CA/CB/CC only for derived state. M3 receipt freshness also uses
other M3 messages. Matching cancellations and departures clear the source berth;
interposes replace the destination. Descriptions expire after ten minutes, so
empty lanes do not prove a platform clear. Restart reconstructs this bounded
window; it cannot restore descriptions predating it. The feed has no initial
full berth image here. A truncation flag warns when the replay is limited.

`/td-ingest` accepts a maximum 32 KB authenticated snapshot into the existing
UNIT_ALLOCATIONS binding under a separate key; it uses UNIT_INGEST_KEY. No new
secrets or KV bindings. `/td-map` is read-only, uses the existing origin policy,
and marks capture or publication older than three minutes stale. KV expires in
ten minutes. The browser hides descriptions on stale data or failed retrieval.
KV distribution/cache may add delay; this is not a subsecond TD display.

## Deploy

1. Deploy `mcv/unit-reader/worker.mjs` to the existing Cloudflare Worker, retaining
   its bindings and secrets.
2. On the reader server, use the full commit containing these files:

```sh
mcv_commit=REPLACE_WITH_FULL_COMMIT_SHA
curl -fsSL "https://raw.githubusercontent.com/RoGroup/rogroup.github.io/$mcv_commit/mcv/td-reader/install-td-map.sh" -o /tmp/install-mcv-td-map.sh
bash /tmp/install-mcv-td-map.sh "$mcv_commit"
journalctl -u mcv-td-map -n 10 --no-pager
```

This installs only the independent map publisher, not the Kafka reader or existing
board publisher. It reads the existing ingestion token locally and exposes no
server listener. The browser page can deploy on Pages before the backend and
will explicitly show it is awaiting the publisher.

Verification: `python -m unittest -v test_td_map.py test_td_reader.py` in this
folder; `node mcv/unit-reader/test_td_worker.mjs` from the repository root.
Pause with `systemctl disable --now mcv-td-map`; TD capture continues.

## Station-layout redraw

The 22 October 2026 user-supplied Traksy screenshot is used as a visual reference
for geographic arrangement only. SVG paths are independently drawn; no Traksy
assets, source code, signal colours or live data are copied. Salford Central is
to the left, Victoria platforms 6 to 1 run top to bottom, and the turnback siding
and Ordsall Chord are below. Piccadilly is a direction label beyond the chord,
not a mapped second station. Approach tracks and junction geometry are schematic
context and have no live state. Victoria associations continue to use the existing
TD snapshot. Shared associations remain outside the track diagram. Mobile opens
centred on Victoria; zoom operates on the minimum-width diagram as well as desktop.
This redraw requires only Pages deployment; no Worker or server update.
