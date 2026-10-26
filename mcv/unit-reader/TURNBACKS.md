# ECS schedules with repeated Victoria visits

The user supplied a concrete daily-timetable example: N03290 / 5P31, Victoria
15:22, Manchester Victoria West Turnback 15:25–15:34, returning Victoria 15:37
on 26 October 2026. Darwin supplied two rows with the same UID/RID/headcode/date:
an outbound departure and a return arrival. This is not a new VSTP-only case.

The projector previously rejected any route with multiple Victoria visits, and
the direct booked-pattern fallback excluded ECS. Staff normalization also removed
a later Victoria point from an already-subsequent list. These independent guards
made a real station–turnback–station working appear to have no booked route.

The booked-pattern projector now selects one visit by the service's provided MCV
booked arrival/departure times, using one consistent public or working pair. A
unique visit is required. Repeated ECS visits can be separate rows; passenger
circular routes retain the existing conservative guard. Exact duplicate visits,
wrong headcodes/times, cancelled/diverted services and supplied Darwin patterns
remain withheld or keep Darwin priority.

Operational patterns preserve non-public timing points, including the siding and
return station call. A terminating return row carries previous timing points and
no invented onward calls. Existing timetable payload routes optionally carry
`operational:true` and `previousCallingPoints`; the updated Worker validates them
and joins by exact visit time as well as UID/headcode/date. It never supplies
Darwin actuals, forecasts or a live platform from booked data.

Activated TRUST projection can also emit each ECS visit with a distinct service
ID. Planned movement timestamps prevent an outbound report being assigned to the
return arrival. Darwin suppresses the matching supplementary visit; it does not
silently suppress another independently timed visit of the same working.

The shared adapter retains the complete subsequent pattern, labels the known
MNCRVRS loop on staff views, and supplies previous booked points on the return.
Arrival-only ECS details show those prior points automatically. Booked routes
expire with their snapshot, and live previous-point details remain usable.

Deploy the updated Worker first, retaining its bindings/secrets. Then run the
existing `install-trust-publisher.sh` with the same full commit SHA. Its staged
tests now include `test_turnback.py`; it previews under the real publisher account
before replacing files and restarts only the publisher. Pages deploys the adapter
and staff renderer automatically. VSTP/TRUST/Gemini readers, credentials and KV
write intervals remain unchanged.

Validation includes six Python turnback tests based on the supplied timings,
the full 60-test Python suite, `test_turnback_worker.mjs` (exact-visit joins,
operational route validation, live precedence, cancellation/expiry, adapter and
supplementary visits), existing TRUST/booked-pattern/UID Worker regressions,
recent archive and TD Worker checks, and syntax checks of staff inline scripts.
Live verification requires server and Worker installation. Booked siding times
are not live movement reports, and onward passenger working associations are not
inferred from the unit/headcode.
