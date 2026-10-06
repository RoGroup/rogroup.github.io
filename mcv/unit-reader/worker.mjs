const PUBLIC_DETAILS_URL =
  'https://api1.raildata.org.uk/1010-live-departure-board-dep1_2/LDBWS/api/20220120/GetDepBoardWithDetails/MCV';
const STAFF_DEPARTURES_URL =
  'https://api1.raildata.org.uk/1010-live-departure-board---staff-version1_0/LDBSVWS/api/20220120/GetDepartureBoardByCRS/MCV';
const STAFF_ARRDEP_BASE =
  'https://api1.raildata.org.uk/1010-live-arrival-and-departure-boards---staff-version1_0/LDBSVWS/api/20220120/GetArrivalDepartureBoardByCRS/MCV';
const STAFF_ARRDEP_DETAILS_BASE =
  'https://api1.raildata.org.uk/1010-live-arrival-and-departure-boards---staff-version1_0/LDBSVWS/api/20220120/GetArrDepBoardWithDetails/MCV';
const MAX_SERVICES = 30;
const STAFF_MAX_SERVICES = 120;
const CACHE_SECONDS = 20;
const ALLOWED_ORIGINS = new Set([
  'https://rogroup.github.io',
  'https://railstaffhub.uk',
  'https://www.railstaffhub.uk'
]);
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const origin = request.headers.get('Origin') || '';
    if (!isAllowedOrigin(origin)) {
      return jsonResponse({ error: 'Origin not allowed' }, 403, origin);
    }
    if (url.pathname === '/unit-ingest') {
      return ingestUnits(request, env, origin);
    }
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(origin)
      });
    }
    if (request.method !== 'GET') {
      return jsonResponse({ error: 'Method not allowed' }, 405, origin);
    }
    try {
      if (url.pathname === '/departures') {
        return await cachedJson(
          request,
          ctx,
          '/__cache/mcv-departures-headcodes-v11',
          origin,
          () => buildPublicDepartures(env)
        );
      }
      if (url.pathname === '/staff-departures') {
        return await cachedJson(
          request,
          ctx,
          '/__cache/mcv-staff-movements-units-v12',
          origin,
          () => buildStaffMovements(env)
        );
      }
      if (url.pathname === '/units') {
        const snapshot = await readUnitSnapshot(env);
        return jsonResponse(snapshot || { version: 1, available: false, services: [] }, 200, origin);
      }
      if (url.pathname === '/staff-details') {
        const at = url.searchParams.get('at');
        if (!at) {
          return jsonResponse(
            { error: 'Missing at parameter' },
            400,
            origin
          );
        }
        const board = await buildStaffDetails(env, at);
        return jsonResponse(board, 200, origin);
      }
      if (url.pathname === '/' || url.pathname === '/health') {
        return jsonResponse(
          {
            ok: true,
            service: 'Manchester Victoria RDM proxy',
            endpoints: [
              '/departures',
              '/staff-departures',
              '/staff-details',
              '/units'
            ],
            staffMode: 'arrival+departure+on-demand-details'
          },
          200,
          origin
        );
      }
      return jsonResponse({ error: 'Not found' }, 404, origin);
    } catch (error) {
      console.error(error);
      return jsonResponse(
        {
          error:
            error instanceof Error
              ? error.message
              : String(error)
        },
        502,
        origin
      );
    }
  }
};
function isAllowedOrigin(origin) {
  return !origin || ALLOWED_ORIGINS.has(origin);
}
function corsHeaders(origin) {
  const headers = {
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
    Vary: 'Origin'
  };
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }
  return headers;
}
function jsonResponse(value, status = 200, origin = '') {
  const headers = corsHeaders(origin);
  headers['Content-Type'] =
    'application/json; charset=utf-8';
  return new Response(
    JSON.stringify(value),
    {
      status,
      headers
    }
  );
}
async function cachedJson(
  request,
  ctx,
  cachePath,
  origin,
  builder
) {
  const cache = caches.default;
  const cacheUrl = new URL(request.url);
  cacheUrl.pathname = cachePath;
  cacheUrl.search = '';
  const cacheKey = new Request(
    cacheUrl.toString(),
    { method: 'GET' }
  );
  const cached = await cache.match(cacheKey);
  if (cached) {
    return jsonResponse(
      await cached.json(),
      200,
      origin
    );
  }
  const payload = await builder();
  const cacheResponse = new Response(
    JSON.stringify(payload),
    {
      status: 200,
      headers: {
        'Content-Type':
          'application/json; charset=utf-8',
        'Cache-Control':
          `public, max-age=${CACHE_SECONDS}`
      }
    }
  );
  ctx.waitUntil(
    cache.put(
      cacheKey,
      cacheResponse
    )
  );
  return jsonResponse(
    payload,
    200,
    origin
  );
}
async function buildPublicDepartures(env) {
  if (!env.RDM_API_KEY) {
    throw new Error(
      'Missing RDM_API_KEY Worker secret'
    );
  }
  const [first, later, staff] =
    await Promise.all([
      fetchPublicDetailed(
        env.RDM_API_KEY,
        0
      ),
      fetchPublicDetailed(
        env.RDM_API_KEY,
        119
      ),
      fetchStaffForHeadcodes(env)
        .catch(error => {
          console.warn(
            'Staff headcode enrichment unavailable:',
            error
          );
          return null;
        })
    ]);
  const board =
    mergeDetailedBoards(
      first,
      later
    );
  const services =
    Array.isArray(board.trainServices)
      ? board.trainServices
      : [];
  let matched = 0;
  let unmatched = 0;
  const methods = {
    serviceID: 0,
    rsid: 0,
    exact: 0,
    loose: 0,
    minuteFallback: 0
  };
  if (
    staff &&
    Array.isArray(staff.trainServices)
  ) {
    for (const service of services) {
      const match =
        findStaffMatch(
          service,
          staff.trainServices
        );
      if (!match) {
        unmatched++;
        continue;
      }
      matched++;
      methods[match.method]++;
      addStaffIdentifiers(
        service,
        match.service
      );
    }
  }
  board.trainServices =
    services
      .sort(compareByDepartureThenArrival)
      .slice(0, MAX_SERVICES);
  board._mcv = {
    ...(board._mcv || {}),
    staffHeadcodesAvailable:
      Boolean(
        staff &&
        Array.isArray(staff.trainServices)
      ),
    staffHeadcodesMatched: matched,
    staffHeadcodesUnmatched: unmatched,
    staffServicesReceived:
      staff &&
      Array.isArray(staff.trainServices)
        ? staff.trainServices.length
        : 0,
    staffMatchMethods: methods
  };
  return board;
}
async function buildStaffMovements(env) {
  if (!env.RDM_ARRDEP_STAFF_API_KEY) {
    throw new Error(
      'Missing RDM_ARRDEP_STAFF_API_KEY Worker secret'
    );
  }
  const [staffBoard, detailed] =
    await Promise.all([
      fetchStaffArrivalDeparture(
        env.RDM_ARRDEP_STAFF_API_KEY
      ),
      env.RDM_API_KEY
        ? fetchPublicDetailed(
            env.RDM_API_KEY,
            0
          ).catch(error => {
            console.warn(
              'Detailed passenger enrichment unavailable:',
              error
            );
            return null;
          })
        : Promise.resolve(null)
    ]);
  const staffServices =
    Array.isArray(
      staffBoard.trainServices
    )
      ? staffBoard.trainServices
      : [];
  const detailServices =
    detailed &&
    Array.isArray(
      detailed.trainServices
    )
      ? detailed.trainServices
      : [];
  const merged =
    staffServices.map(staff => {
      const detailMatch =
        findDetailedMatch(
          staff,
          detailServices
        );
      if (!detailMatch) {
        return staff;
      }
      const detail =
        detailMatch.service;
      return {
        ...detail,
        ...staff,
        trainid:
          staff.trainid ||
          detail.trainid,
        uid:
          staff.uid ||
          detail.uid,
        rid:
          staff.rid ||
          detail.rid,
        rsid:
          staff.rsid ||
          detail.rsid,
        serviceID:
          staff.serviceID ||
          detail.serviceID,
        sdd:
          staff.sdd ||
          detail.sdd,
        category:
          staff.category ||
          detail.category,
        activities:
          staff.activities ||
          detail.activities,
        length:
          staff.length ??
          detail.length,
        isReverseFormation:
          staff.isReverseFormation ??
          detail.isReverseFormation,
        subsequentCallingPoints:
          detail.subsequentCallingPoints ||
          staff.subsequentCallingPoints,
        delayReason:
          staff.delayReason ||
          detail.delayReason,
        cancelReason:
          staff.cancelReason ||
          detail.cancelReason
      };
    });
  staffBoard.trainServices =
    merged.slice(
      0,
      STAFF_MAX_SERVICES
    );
  staffBoard._mcv = {
    ...(staffBoard._mcv || {}),
    source:
      'RDM Live Arrival and Departure Boards - Staff Version',
    mode:
      'arrival+departure',
    servicesReturned:
      staffBoard.trainServices.length,
    detailedPassengerEnrichment:
      Boolean(detailed)
  };
  await enrichUnits(staffBoard, env);
  return staffBoard;
}
async function buildStaffDetails(
  env,
  at
) {
  if (!env.RDM_ARRDEP_STAFF_API_KEY) {
    throw new Error(
      'Missing RDM_ARRDEP_STAFF_API_KEY Worker secret'
    );
  }
  const target =
    new Date(at);
  if (!Number.isFinite(
    target.getTime()
  )) {
    throw new Error(
      'Invalid at parameter'
    );
  }
  const board =
    await fetchStaffArrivalDepartureDetails(
      env.RDM_ARRDEP_STAFF_API_KEY,
      target
    );
  board._mcv = {
    ...(board._mcv || {}),
    source:
      'RDM Live Arrival and Departure Boards - Staff Version',
    mode:
      'arrival+departure-details',
    target:
      target.toISOString()
  };
  await enrichUnits(board, env);
  return board;
}
async function fetchPublicDetailed(
  apiKey,
  timeOffset
) {
  const url =
    new URL(
      PUBLIC_DETAILS_URL
    );
  url.searchParams.set(
    'numRows',
    '40'
  );
  url.searchParams.set(
    'timeWindow',
    '120'
  );
  url.searchParams.set(
    'timeOffset',
    String(timeOffset)
  );
  return fetchRdmJson(
    url,
    apiKey,
    'RDM departures'
  );
}
async function fetchStaffForHeadcodes(
  env
) {
  if (
    env.RDM_ARRDEP_STAFF_API_KEY
  ) {
    return fetchStaffArrivalDeparture(
      env.RDM_ARRDEP_STAFF_API_KEY
    );
  }
  if (!env.RDM_STAFF_API_KEY) {
    throw new Error(
      'No staff API key configured'
    );
  }
  const url =
    new URL(
      STAFF_DEPARTURES_URL
    );
  url.searchParams.set(
    'numRows',
    '149'
  );
  url.searchParams.set(
    'timeWindow',
    '240'
  );
  url.searchParams.set(
    'services',
    'P'
  );
  url.searchParams.set(
    'getNonPassengerServices',
    'true'
  );
  return fetchRdmJson(
    url,
    env.RDM_STAFF_API_KEY,
    'RDM staff departures'
  );
}
async function fetchStaffArrivalDeparture(
  apiKey
) {
  const url =
    new URL(
      `${STAFF_ARRDEP_BASE}/${londonDateTimePath(new Date())}`
    );
  url.searchParams.set(
    'numRows',
    '149'
  );
  url.searchParams.set(
    'timeWindow',
    '240'
  );
  url.searchParams.set(
    'services',
    'P'
  );
  url.searchParams.set(
    'getNonPassengerServices',
    'true'
  );
  return fetchRdmJson(
    url,
    apiKey,
    'RDM staff arrival/departure board'
  );
}
async function fetchStaffArrivalDepartureDetails(
  apiKey,
  target
) {
  const start =
    new Date(
      target.getTime() -
      2 * 60 * 1000
    );
  const url =
    new URL(
      `${STAFF_ARRDEP_DETAILS_BASE}/${londonDateTimePath(start)}`
    );
  url.searchParams.set(
    'numRows',
    '9'
  );
  url.searchParams.set(
    'timeWindow',
    '20'
  );
  url.searchParams.set(
    'services',
    'P'
  );
  url.searchParams.set(
    'getNonPassengerServices',
    'true'
  );
  return fetchRdmJson(
    url,
    apiKey,
    'RDM staff arrival/departure details'
  );
}
async function fetchRdmJson(
  url,
  apiKey,
  label
) {
  const response =
    await fetch(
      url.toString(),
      {
        method: 'GET',
        headers: {
          Accept:
            'application/json',
          'x-apikey':
            apiKey
        }
      }
    );
  if (!response.ok) {
    const body =
      await response.text();
    throw new Error(
      `${label} returned ` +
      `${response.status} ` +
      `${response.statusText}: ` +
      body.slice(0, 500)
    );
  }
  return response.json();
}
function londonDateTimePath(
  date = new Date()
) {
  const parts =
    new Intl.DateTimeFormat(
      'en-GB',
      {
        timeZone:
          'Europe/London',
        year:
          'numeric',
        month:
          '2-digit',
        day:
          '2-digit',
        hour:
          '2-digit',
        minute:
          '2-digit',
        second:
          '2-digit',
        hour12:
          false,
        hourCycle:
          'h23'
      }
    ).formatToParts(date);
  const get =
    type =>
      parts.find(
        part =>
          part.type === type
      )?.value || '00';
  return (
    get('year') +
    get('month') +
    get('day') +
    'T' +
    get('hour') +
    get('minute') +
    get('second')
  );
}
function mergeDetailedBoards(
  ...boards
) {
  const valid =
    boards.filter(
      board =>
        board &&
        typeof board === 'object'
    );
  const base = {
    ...(valid[0] || {})
  };
  const seen =
    new Set();
  const trainServices = [];
  for (const board of valid) {
    for (
      const service
      of board.trainServices || []
    ) {
      const key =
        serviceKey(service);
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      trainServices.push(service);
    }
  }
  base.trainServices =
    trainServices.sort(
      compareByDepartureThenArrival
    );
  return base;
}
function addStaffIdentifiers(
  target,
  staff
) {
  if (!target || !staff) {
    return;
  }
  if (staff.trainid) {
    target.trainid =
      staff.trainid;
  }
  if (staff.uid) {
    target.uid =
      staff.uid;
  }
  if (staff.rid) {
    target.rid =
      staff.rid;
  }
  if (staff.rsid) {
    target.rsid =
      staff.rsid;
  }
  if (staff.sdd) {
    target.sdd =
      staff.sdd;
  }
  if (staff.category) {
    target.category =
      staff.category;
  }
  if (staff.activities) {
    target.activities =
      staff.activities;
  }
  if (staff.length != null) {
    target.length =
      staff.length;
  }
  if (
    typeof staff.isReverseFormation
      === 'boolean'
  ) {
    target.isReverseFormation =
      staff.isReverseFormation;
  }
  if (
    typeof staff.isPassengerService
      === 'boolean'
  ) {
    target.isPassengerService =
      staff.isPassengerService;
  }
  if (
    typeof staff.isCharter
      === 'boolean'
  ) {
    target.isCharter =
      staff.isCharter;
  }
}
function findStaffMatch(
  service,
  staffServices
) {
  return findBestMatch(
    service,
    staffServices
  );
}
function findDetailedMatch(
  service,
  detailedServices
) {
  return findBestMatch(
    service,
    detailedServices
  );
}
function findBestMatch(
  service,
  candidates
) {
  const serviceID =
    text(service.serviceID);
  if (serviceID) {
    const exact =
      candidates.find(
        item =>
          text(item.serviceID) ===
          serviceID
      );
    if (exact) {
      return {
        service: exact,
        method: 'serviceID'
      };
    }
  }
  const rsid =
    text(service.rsid);
  if (rsid) {
    const exact =
      candidates.find(
        item =>
          text(item.rsid) ===
          rsid
      );
    if (exact) {
      return {
        service: exact,
        method: 'rsid'
      };
    }
  }
  const exactCandidates =
    candidates.filter(
      item =>
        operatorKey(item) ===
          operatorKey(service) &&
        bookedKey(item) ===
          bookedKey(service) &&
        endpointKey(
          item,
          'origin'
        ) ===
          endpointKey(
            service,
            'origin'
          ) &&
        endpointKey(
          item,
          'destination'
        ) ===
          endpointKey(
            service,
            'destination'
          )
    );
  if (
    exactCandidates.length === 1
  ) {
    return {
      service:
        exactCandidates[0],
      method:
        'exact'
    };
  }
  const looseCandidates =
    candidates.filter(
      item =>
        operatorKey(item) ===
          operatorKey(service) &&
        bookedKey(item) ===
          bookedKey(service) &&
        endpointKey(
          item,
          'destination'
        ) ===
          endpointKey(
            service,
            'destination'
          )
    );
  if (
    looseCandidates.length === 1
  ) {
    return {
      service:
        looseCandidates[0],
      method:
        'loose'
    };
  }
  const serviceMinute =
    bookedMinute(service);
  if (
    serviceMinute != null
  ) {
    const minuteCandidates =
      candidates.filter(
        item => {
          const candidateMinute =
            bookedMinute(item);
          return (
            candidateMinute != null &&
            Math.abs(
              candidateMinute -
              serviceMinute
            ) <= 1 &&
            operatorKey(item) ===
              operatorKey(service) &&
            endpointKey(
              item,
              'destination'
            ) ===
              endpointKey(
                service,
                'destination'
              )
          );
        }
      );
    if (
      minuteCandidates.length === 1
    ) {
      return {
        service:
          minuteCandidates[0],
        method:
          'minuteFallback'
      };
    }
  }
  return null;
}
function serviceKey(
  service
) {
  return [
    text(service.serviceID),
    text(service.rid),
    text(service.rsid),
    bookedKey(service),
    operatorKey(service),
    endpointKey(
      service,
      'origin'
    ),
    endpointKey(
      service,
      'destination'
    )
  ].join('|');
}
function operatorKey(
  service
) {
  return text(
    service.operatorCode ||
    service.operator
  ).toUpperCase();
}
function bookedKey(
  service
) {
  return normalizeClock(
    service.std ||
    service.sta ||
    service.sdd ||
    ''
  );
}
function bookedMinute(
  service
) {
  const clock =
    bookedKey(service);
  const match =
    /^(\d{2}):(\d{2})$/.exec(
      clock
    );
  if (!match) {
    return null;
  }
  return (
    Number(match[1]) * 60 +
    Number(match[2])
  );
}
function endpointKey(
  service,
  field
) {
  const raw =
    service[field];
  const entry =
    Array.isArray(raw)
      ? raw[0]
      : raw;
  if (!entry) {
    return '';
  }
  return text(
    entry.crs ||
    entry.locationName ||
    entry.name
  ).toUpperCase();
}
function normalizeClock(
  value
) {
  const raw =
    text(value);
  if (!raw) {
    return '';
  }
  const iso =
    /T(\d{2}):(\d{2})/.exec(
      raw
    );
  if (iso) {
    return (
      iso[1] +
      ':' +
      iso[2]
    );
  }
  const hhmm =
    /^(\d{2}):(\d{2})/.exec(
      raw
    );
  if (hhmm) {
    return (
      hhmm[1] +
      ':' +
      hhmm[2]
    );
  }
  const compact =
    /^(\d{2})(\d{2})/.exec(
      raw
    );
  if (compact) {
    return (
      compact[1] +
      ':' +
      compact[2]
    );
  }
  return raw;
}
function compareByDepartureThenArrival(
  a,
  b
) {
  return (
    clockSortValue(
      a.std || a.sta
    ) -
    clockSortValue(
      b.std || b.sta
    )
  );
}
function clockSortValue(
  value
) {
  const clock =
    normalizeClock(value);
  const match =
    /^(\d{2}):(\d{2})$/.exec(
      clock
    );
  if (!match) {
    return Number.MAX_SAFE_INTEGER;
  }
  return (
    Number(match[1]) * 60 +
    Number(match[2])
  );
}
function text(value) {
  return value == null
    ? ''
    : String(value).trim();
}

// One compact snapshot is uploaded by Oracle every two minutes.
const UNIT_SNAPSHOT_KEY = 'mcv-current-units-v1';
const UNIT_MAX_AGE_MS = 6 * 60 * 1000;
function unitSignature(service) {
  return JSON.stringify(['serviceID','uid','trainid','sdd','sta','std'].map(key => String(service[key] || '')));
}
async function secureTokenEqual(actual, expected) {
  const encode = value => new TextEncoder().encode(value);
  const [a, b] = await Promise.all([actual, expected].map(value => crypto.subtle.digest('SHA-256', encode(value))));
  const aa = new Uint8Array(a), bb = new Uint8Array(b);
  let difference = 0;
  for (let i=0; i<aa.length; i++) difference |= aa[i] ^ bb[i];
  return difference === 0;
}
async function ingestUnits(request, env, origin) {
  if (request.method !== 'POST') return jsonResponse({error:'Method not allowed'},405,origin);
  if (!env.UNIT_ALLOCATIONS || !env.UNIT_INGEST_KEY) return jsonResponse({error:'Unit storage not configured'},503,origin);
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer /,'');
  if (!token || !await secureTokenEqual(token, env.UNIT_INGEST_KEY)) return jsonResponse({error:'Unauthorized'},401,origin);
  try {
    if (Number(request.headers.get('Content-Length')) > 262144) return jsonResponse({error:'Snapshot too large'},413,origin);
    const body = await request.text();
    if (new TextEncoder().encode(body).length > 262144) return jsonResponse({error:'Snapshot too large'},413,origin);
    const snapshot = JSON.parse(body);
    if (snapshot.version !== 1 || typeof snapshot.readerRunning !== 'boolean' || !Array.isArray(snapshot.services) || snapshot.services.length > 200) throw new Error('Invalid snapshot');
    for (const service of snapshot.services) {
      if (typeof service.serviceID !== 'string' || !['allocated','unallocated','not-supplied'].includes(service.status)) throw new Error('Invalid service');
      for (const field of ['arrivalUnitClasses','departureUnitClasses']) {
        const classes=service[field];
        if(classes!=null && (typeof classes!=='object'||Array.isArray(classes)||Object.keys(classes).length>20||
          !Object.entries(classes).every(([unit,fleet])=>/^\d{6}$/.test(unit)&&typeof fleet==='string'&&/^\d{3}(?:\/\d{1,3})?$/.test(fleet)))) throw new Error('Invalid unit classes');
      }
      for (const field of ['arrivalCarriages','departureCarriages']) {
        if (service[field] != null && (!Number.isInteger(service[field]) || service[field] < 1 || service[field] > 100)) throw new Error('Invalid carriage count');
      }
      for (const field of ['arrivalUnits','departureUnits']) {
        if (!Array.isArray(service[field]) || service[field].length > 20 || !service[field].every(unit => typeof unit === 'string' && /^\d{6}$/.test(unit))) throw new Error('Invalid units');
      }
    }
    snapshot.updatedAt = new Date().toISOString();
    await env.UNIT_ALLOCATIONS.put(UNIT_SNAPSHOT_KEY, JSON.stringify(snapshot), {expirationTtl:900});
    return jsonResponse({ok:true, services:snapshot.services.length},200,origin);
  } catch (error) {
    console.error('Unit ingestion failed:', error);
    return jsonResponse({error:'Unable to save unit snapshot'},502,origin);
  }
}
async function readUnitSnapshot(env) {
  if (!env.UNIT_ALLOCATIONS) return null;
  const snapshot = await env.UNIT_ALLOCATIONS.get(UNIT_SNAPSHOT_KEY, {type:'json', cacheTtl:60});
  if (!snapshot || snapshot.version !== 1 || !Array.isArray(snapshot.services)) return null;
  const age = Date.now() - Date.parse(snapshot.updatedAt);
  return {...snapshot, available:snapshot.readerRunning === true && Number.isFinite(age) && age >= 0 && age <= UNIT_MAX_AGE_MS};
}
async function enrichUnits(board, env) {
  try {
    const snapshot = await readUnitSnapshot(env);
    board._mcv = {...(board._mcv || {}), unitAllocationsAvailable:Boolean(snapshot?.available), unitSnapshotAt:snapshot?.updatedAt || null};
    if (!snapshot?.available) return;
    const index = new Map(snapshot.services.map(service => [unitSignature(service), service]));
    for (const service of board.trainServices || []) {
      const match = index.get(unitSignature(service));
      if (match) service.unitAllocation = {
        status:match.status, arrivalUnits:match.arrivalUnits, departureUnits:match.departureUnits,
        arrivalCarriages:match.arrivalCarriages || null, departureCarriages:match.departureCarriages || null,
        arrivalUnitClasses:match.arrivalUnitClasses || {}, departureUnitClasses:match.departureUnitClasses || {},
        messageTime:match.messageTime || null, syncedAt:snapshot.updatedAt,
        source:'RDM Passenger Train Allocation and Consist'
      };
    }
  } catch (error) {
    console.warn('Unit enrichment unavailable:', error);
    board._mcv = {...(board._mcv || {}), unitAllocationsAvailable:false};
  }
}
