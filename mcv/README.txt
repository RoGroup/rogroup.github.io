Manchester Victoria display update

Live MCV departure data source:
https://mcv-rdm-proxy.baileykendall432.workers.dev/departures

Updated to RDM Worker:
- platform.html
- platform1.html through platform6.html
- platform12.html and platform45.html
- nexttrain1.html through nexttrain6.html
- staff.html
- assist.html
- assist-desktop.html
- control.html
- index.html live departures panel

Logo removed from every HTML file in this package. Northern visual system retained: Bunday Clean, #262262 navy, #0698d6 blue, existing accessible colour hierarchy and layouts.

journey.html keeps its existing Traini station-search/journey engine because the RDM Live Departure Board product does not supply the arbitrary station search / journey-planning interface that page uses. Its Northern logo has still been removed.

Keep your existing bunday-clean-regular.woff, bunday-clean-bold.woff, static-notices.js, platform-alterations.js and notices.json files in the GitHub Pages repository.

SHARED DATA LAYER
-----------------
mcv-data.js is the shared Manchester Victoria RDM data layer.
Include it before a page's own JavaScript:
  <script src="mcv-data.js"></script>

It centralises the Cloudflare Worker URL, RDM parsing, platform filters,
formation handling, TPE Coach E rule, front-carriage notices, station-name
corrections, delayed-service ordering, and last-good/stale-data fallback.

Pages have not yet been refactored to depend on it in this package; this file
is intentionally added first so each screen can be migrated and tested safely.
