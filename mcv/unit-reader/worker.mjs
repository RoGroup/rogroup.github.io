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
let reasonReference = {data:null, expires:0, retryAt:0, pending:null};
function descriptiveReason(value, depth=0) {
  if(value==null||depth>4)return '';
  if(typeof value==='string'){
    const text=value.trim();
    return text&&!/^\d+$/.test(text)&&text!=='[object Object]'?text:'';
  }
  if(Array.isArray(value))return value.map(v=>descriptiveReason(v,depth+1)).filter(Boolean).join('; ');
  if(typeof value==='object'){
    for(const key of ['reasonText','reasonDescription','description','message','text','lateReason','cancReason','reason','value','Value','_','#text']){
      const text=descriptiveReason(value[key],depth+1);if(text)return text;
    }
  }
  return '';
}
function numericReasonCode(value,depth=0){
  if(value==null||depth>4)return '';
  if(typeof value==='string'||typeof value==='number'){
    const code=String(value).trim();return /^\d+$/.test(code)&&Number(code)>0?code:'';
  }
  if(typeof value==='object')for(const key of ['code','reasonCode','Value','value','_','#text']){
    const code=numericReasonCode(value[key],depth+1);if(code)return code;
  }
  return '';
}
function preferReason(staff,passenger){
  return descriptiveReason(staff)||descriptiveReason(passenger)||staff||passenger;
}
// The documented staff reference operation may be restricted by the RDM product.
// Keep board updates working if reference access is unavailable, and retry later.
async function getReasonReference(env){
  if(reasonReference.data&&Date.now()<reasonReference.expires)return reasonReference.data;
  if(reasonReference.pending)return reasonReference.pending;
  if(Date.now()<reasonReference.retryAt||!env.RDM_STAFF_API_KEY)return reasonReference.data;
  reasonReference.pending=(async()=>{
    const controller=new AbortController();
    const timeout=setTimeout(()=>controller.abort(),3000);
    try{
      const url=STAFF_DEPARTURES_URL.replace(/GetDepartureBoardByCRS\/MCV$/, 'GetReasonCodeList');
      const response=await fetch(url,{headers:{Accept:'application/json','x-apikey':env.RDM_STAFF_API_KEY},signal:controller.signal});
      if(!response.ok)throw new Error('Reason reference HTTP '+response.status);
      const raw=await response.json();
      const rows=Array.isArray(raw)?raw:raw.reasonCodeList||raw.reasonCodes||raw.ReasonDescription||raw.reasonDescription;
      if(!Array.isArray(rows)||rows.length>10000)throw new Error('Unexpected reason reference');
      const data=new Map();
      for(const row of rows){
        const code=numericReasonCode(row.code);
        const late=descriptiveReason(row.lateReason),cancel=descriptiveReason(row.cancReason);
        if(code&&(late||cancel))data.set(code,{late,cancel});
      }
      if(!data.size)throw new Error('Empty reason reference');
      reasonReference.data=data;reasonReference.expires=Date.now()+24*60*60*1000;
      return data;
    }catch(error){
      reasonReference.retryAt=Date.now()+15*60*1000;
      console.warn('Darwin reason reference unavailable:',error.message);
      return reasonReference.data;
    }finally{clearTimeout(timeout);reasonReference.pending=null;}
  })();
  return reasonReference.pending;
}
async function resolveBoardReasons(services,env){
  const fields=[['delayReason','late'],['cancelReason','cancel']];
  const nodes=[];
  for(const service of services){
    nodes.push(service);
    for(const groupName of ['previousCallingPoints','subsequentCallingPoints']){
      for(const group of service[groupName]||[])for(const point of group.callingPoint||[])nodes.push(point);
    }
  }
  if(!nodes.some(node=>fields.some(([field])=>!descriptiveReason(node[field])&&numericReasonCode(node[field]))))return;
  const reference=await getReasonReference(env);if(!reference)return;
  for(const node of nodes)for(const [field,kind] of fields){
    if(descriptiveReason(node[field]))continue;
    const code=numericReasonCode(node[field]);const description=reference.get(code)?.[kind];
    if(description&&!/\{[^}]*\}/.test(description)){
      node[field+'Code']=code;
      const original=node[field];
      node[field]=original&&typeof original==='object'&&!Array.isArray(original)?{...original,description}:description;
    }
  }
}
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
          '/__cache/mcv-staff-movements-trust-v18',
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
          preferReason(staff.delayReason, detail.delayReason),
        cancelReason:
          preferReason(staff.cancelReason, detail.cancelReason)
      };
    });
  await resolveBoardReasons(merged, env);
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
  const snapshot = await readUnitSnapshot(env).catch(() => null);
  mergeTrustServices(staffBoard, snapshot);
  await enrichUnits(staffBoard, env, snapshot);
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
  const snapshot = await readUnitSnapshot(env).catch(() => null);
  mergeTrustServices(board, snapshot);
  await enrichUnits(board, env, snapshot);
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
      for(const prefix of ['arrival','departure']){
        if(service[prefix+'OrderKnown']!=null && typeof service[prefix+'OrderKnown']!=='boolean')throw new Error('Invalid order flag');
        const first=service[prefix+'FirstClassCarriages'];
        if(first!=null && (!Array.isArray(first)||first.length>20||!first.every(x=>Number.isInteger(x)&&x>0&&x<=100)))throw new Error('Invalid first-class positions');
      }
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
    if (snapshot.trust != null) snapshot.trust = validateTrustSnapshot(snapshot.trust);
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
async function enrichUnits(board, env, suppliedSnapshot) {
  try {
    const snapshot = suppliedSnapshot === undefined ? await readUnitSnapshot(env) : suppliedSnapshot;
    board._mcv = {...(board._mcv || {}), unitAllocationsAvailable:Boolean(snapshot?.available), unitReaderRunning:snapshot?.readerRunning ?? null, unitSnapshotAt:snapshot?.updatedAt || null};
    if (!snapshot?.available) return;
    const index = new Map(snapshot.services.map(service => [unitSignature(service), service]));
    for (const service of board.trainServices || []) {
      const match = index.get(unitSignature(service));
      if (match) service.unitAllocation = {
        status:match.status, arrivalUnits:match.arrivalUnits, departureUnits:match.departureUnits,
        arrivalCarriages:match.arrivalCarriages || null, departureCarriages:match.departureCarriages || null,
        arrivalUnitClasses:match.arrivalUnitClasses || {}, departureUnitClasses:match.departureUnitClasses || {},
        arrivalOrderKnown:match.arrivalOrderKnown===true, departureOrderKnown:match.departureOrderKnown===true,
        arrivalFirstClassCarriages:match.arrivalFirstClassCarriages || null, departureFirstClassCarriages:match.departureFirstClassCarriages || null,
        messageTime:match.messageTime || null, syncedAt:snapshot.updatedAt,
        source:'RDM Passenger Train Allocation and Consist'
      };
    }
  } catch (error) {
    console.warn('Unit enrichment unavailable:', error);
    board._mcv = {...(board._mcv || {}), unitAllocationsAvailable:false};
  }
}


// TRUST-only ECS rows share the allocation snapshot upload and KV write.
function validateTrustSnapshot(input) {
  if (!input || input.version !== 1 || typeof input.available !== 'boolean' || !Array.isArray(input.services) || input.services.length > 100) throw new Error('Invalid TRUST snapshot');
  if (!input.available) return {version:1, available:false, services:[]};
  for (const field of ['updatedAt','feedAt','scheduleAt']) {
    if (typeof input[field] !== 'string' || !Number.isFinite(Date.parse(input[field]))) throw new Error('Invalid TRUST timestamp');
  }
  const iso = value => value == null || (typeof value === 'string' && /^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) && Number.isFinite(Date.parse(value)));
  function places(points, max) {
    if (!Array.isArray(points) || points.length > max) throw new Error('Invalid TRUST places');
    return points.map(point => {
      for (const key of ['locationName','crs','tiploc']) {
        if (typeof point[key] !== 'string' || point[key].length > 120) throw new Error('Invalid TRUST place');
      }
      if (point.st != null && !iso(point.st)) throw new Error('Invalid TRUST calling time');
      return {locationName:point.locationName, crs:point.crs, tiploc:point.tiploc, ...(point.st ? {st:point.st} : {})};
    });
  }
  const services = input.services.map(service => {
    if (!service || service.mcvSource !== 'TRUST' || service.category !== 'EE' || service.isPassengerService !== false || service.serviceType !== 'train' ||
        !/^[A-Z]\d{5}$/.test(service.uid) || !/^[0-9][A-Z]\d{2}$/.test(service.trainid) ||
        !/^\d{4}-\d\d-\d\d$/.test(service.sdd) || !/^trust:[\w:-]{1,80}$/.test(service.serviceID)) throw new Error('Invalid TRUST identity');
    for (const field of ['sta','std','ata','atd']) if (!iso(service[field])) throw new Error('Invalid TRUST movement');
    if (!(service.sta || service.std)) throw new Error('Missing TRUST booked movement');
    if (!service.trust || !['reported','booked'].includes(service.trust.platformSource) ||
        !['','East','West'].includes(service.trust.departureDirection) || !iso(service.trust.lastReportAt)) throw new Error('Invalid TRUST provenance');
    for (const field of ['operator','operatorCode','platform']) if (typeof service[field] !== 'string' || service[field].length > 120) throw new Error('Invalid TRUST service label');
    const clean = {mcvSource:'TRUST', category:'EE', isPassengerService:false, serviceType:'train'};
    for (const field of ['serviceID','uid','trainid','sdd','sta','std','ata','atd','operator','operatorCode','platform']) clean[field] = service[field] ?? null;
    clean.origin = places(service.origin, 1);
    clean.destination = places(service.destination, 1);
    for (const property of ['previousCallingPoints','subsequentCallingPoints']) {
      if (!Array.isArray(service[property]) || service[property].length > 1) throw new Error('Invalid TRUST route');
      clean[property] = service[property].map(group => ({callingPoint:places(group.callingPoint,100)}));
    }
    clean.trust = {platformSource:service.trust.platformSource, lastReportAt:service.trust.lastReportAt || null,
      departureDirection:service.trust.departureDirection, directionPoint:String(service.trust.directionPoint || '').slice(0,20),
      trainId:String(service.trust.trainId || '').slice(0,20)};
    return clean;
  });
  const movements = input.movements ?? [];
  if (!Array.isArray(movements) || movements.length > 200) throw new Error('Invalid TRUST movements');
  const cleanMovements = movements.map(row => {
    if (!row || !/^[A-Z]\d{5}$/.test(row.uid) || !/^[0-9][A-Z]\d{2}$/.test(row.trainid) ||
        !/^\d{4}-\d\d-\d\d$/.test(row.sdd)) throw new Error('Invalid TRUST movement identity');
    for (const field of ['sta','std','ata','atd','lastReportAt']) if (!iso(row[field])) throw new Error('Invalid TRUST report time');
    if (!(row.sta || row.std) || !(row.ata || row.atd) || !row.lastReportAt ||
        (row.ata && !row.sta) || (row.atd && !row.std) ||
        (row.ata && row.atd && Date.parse(row.ata) > Date.parse(row.atd)) ||
        Math.max(Date.parse(row.ata) || 0, Date.parse(row.atd) || 0) !== Date.parse(row.lastReportAt) ||
        Date.parse(row.lastReportAt) > Date.now()+90000) throw new Error('Inconsistent TRUST report');
    if (typeof row.reportedPlatform !== 'string' || !/^(?:[1-6](?:[AB])?)?$/.test(row.reportedPlatform)) throw new Error('Invalid TRUST reported platform');
    return Object.fromEntries(['uid','trainid','sdd','sta','std','ata','atd','lastReportAt','reportedPlatform'].map(key=>[key,row[key] ?? null]));
  });
  const routes = input.routes ?? [];
  if (!Array.isArray(routes) || routes.length > 200) throw new Error('Invalid TRUST calling patterns');
  const cleanRoutes = routes.map(row => {
    if (!row || !/^[A-Z]\d{5}$/.test(row.uid) || !/^[0-9][A-Z]\d{2}$/.test(row.trainid) ||
        !/^\d{4}-\d\d-\d\d$/.test(row.sdd) || !iso(row.sta) || !iso(row.std) || !(row.sta || row.std)) throw new Error('Invalid TRUST calling pattern identity');
    const callingPoints = places(row.callingPoints,100);
    if (!callingPoints.length || callingPoints.some(point=>!point.st || !point.crs || !point.tiploc)) throw new Error('Invalid TRUST booked call');
    return {uid:row.uid,trainid:row.trainid,sdd:row.sdd,sta:row.sta ?? null,std:row.std ?? null,callingPoints};
  });
  const histories = input.histories ?? [];
  if (!Array.isArray(histories) || histories.length > 200) throw new Error('Invalid TRUST histories');
  const movementKinds = new Set(['arrival','departure','pass']);
  const lifecycleKinds = new Set(['activation','cancellation','reinstatement','origin-change','identity-change','location-change']);
  const cleanHistories = histories.map(row => {
    if (!row || !/^[A-Z]\d{5}$/.test(row.uid) || !/^[0-9][A-Z]\d{2}$/.test(row.trainid) ||
        !/^\d{4}-\d\d-\d\d$/.test(row.sdd) || !iso(row.sta) || !iso(row.std) || !(row.sta || row.std) ||
        typeof row.reconciliationRequired !== 'boolean' || !Array.isArray(row.events) || row.events.length < 1 || row.events.length > 60) throw new Error('Invalid TRUST history identity');
    const events = row.events.map(event => {
      if (!event || !(movementKinds.has(event.kind) || lifecycleKinds.has(event.kind)) || !event.at || !iso(event.at) || Date.parse(event.at) > Date.now()+90000 ||
          event.timeBasis !== (movementKinds.has(event.kind) ? 'actual' : 'received')) throw new Error('Invalid TRUST history event');
      for (const key of ['locationName','crs','tiploc','platform']) if (typeof event[key] !== 'string' || event[key].length > 120) throw new Error('Invalid TRUST history label');
      if (movementKinds.has(event.kind) && (!event.tiploc || !event.locationName || !Number.isInteger(event.delaySeconds) || Math.abs(event.delaySeconds)>43200)) throw new Error('Invalid TRUST movement evidence');
      if (lifecycleKinds.has(event.kind) && event.delaySeconds != null) throw new Error('Invalid TRUST lifecycle evidence');
      return Object.fromEntries(['kind','at','timeBasis','locationName','crs','tiploc','platform','delaySeconds'].map(key=>[key,event[key] ?? null]));
    }).sort((a,b)=>Date.parse(a.at)-Date.parse(b.at));
    return {uid:row.uid,trainid:row.trainid,sdd:row.sdd,sta:row.sta ?? null,std:row.std ?? null,events,reconciliationRequired:row.reconciliationRequired};
  });
  return {version:1, available:true, services, movements:cleanMovements, routes:cleanRoutes, histories:cleanHistories, updatedAt:input.updatedAt, feedAt:input.feedAt, scheduleAt:input.scheduleAt};
}
function mergeTrustServices(board, snapshot) {
  const trust = snapshot?.trust;
  const now = Date.now();
  const fresh = (stamp, max) => Number.isFinite(Date.parse(stamp)) && now-Date.parse(stamp) >= -30000 && now-Date.parse(stamp) <= max;
  const available = Boolean(trust?.available && fresh(trust.updatedAt,360000) && fresh(trust.feedAt,300000) && fresh(trust.scheduleAt,36*3600000));
  board._mcv = {...(board._mcv || {}), trustAvailable:available, trustSnapshotAt:trust?.updatedAt || null, trustServicesAdded:0, trustMovementsMatched:0, trustCallingPatternsMatched:0, trustHistoriesMatched:0};
  for (const service of board.trainServices || []) {delete service.trustMovement;delete service.trustCallingPoints;delete service.trustHistory;}
  if (!available) return;
  const original = Array.isArray(board.trainServices) ? board.trainServices : [];
  const output = [...original];
  const seen = new Set();
  const expiresAt = new Date(Math.min(Date.parse(trust.updatedAt)+360000, Date.parse(trust.feedAt)+300000, Date.parse(trust.scheduleAt)+36*3600000)).toISOString();
  // Supplement Darwin with separately labelled reports. Never replace its
  // forecast, cancellation, actual timings or current platform allocation.
  const identity = row => [row.uid,row.trainid,row.sdd].join('|');
  const reports = new Map();
  for (const row of trust.movements || []) {
    const key = identity(row);
    reports.set(key, reports.has(key) ? null : row);
  }
  const routes = new Map();
  for (const row of trust.routes || []) {
    const key = identity(row);
    routes.set(key, routes.has(key) ? null : row);
  }
  const clock = new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const londonMinute = new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  const sameBookedMinute = (darwin, planned) => {
    if (!darwin || !planned) return false;
    if (/^\d\d:\d\d(?::\d\d)?$/.test(String(darwin))) return String(darwin).slice(0,5) === clock.format(new Date(planned));
    // Staff Darwin timestamps without an offset are London wall clocks.
    // Date.parse would interpret these in the Worker's UTC runtime.
    if (/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d+)?)?$/.test(String(darwin))) {
      const parts = Object.fromEntries(londonMinute.formatToParts(new Date(planned)).map(part=>[part.type,part.value]));
      return String(darwin).slice(0,16) === `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
    }
    const a = Date.parse(darwin), b = Date.parse(planned);
    return Number.isFinite(a) && Math.floor(a/60000) === Math.floor(b/60000);
  };
  const matches = (service,row) => {
    if (!row || service.mcvSource === 'TRUST' || original.filter(item=>identity(item)===identity(service)).length !== 1) return false;
    const fields = ['sta','std'].filter(field=>service[field]);
    return fields.length > 0 && fields.every(field=>sameBookedMinute(service[field],row[field]));
  };
  for (const service of original) {
    const row = reports.get(identity(service));
    if (matches(service,row)) {
      service.trustMovement = {...row, source:'TRUST', location:'Manchester Victoria', expiresAt};
      board._mcv.trustMovementsMatched++;
    }
    const route = routes.get(identity(service));
    if (!matches(service,route) || !service.std || service.isCancelled || service.futureCancellation || service.diversion || service.affectedByDiversion) continue;
    // Any supplied Darwin pattern, including cancelled or operational calls,
    // takes precedence. Never append booked calls to a partial live pattern.
    if ((service.subsequentLocations || []).length || (service.subsequentCallingPoints || []).some(group=>(group.callingPoint || []).length)) continue;
    const destinations = service.destination || [];
    const last = route.callingPoints.at(-1);
    if (destinations.length !== 1 || !last || ![last.crs,last.tiploc].includes(String(destinations[0].crs || '').toUpperCase())) continue;
    service.trustCallingPoints = {source:'TRUST timetable',expiresAt,callingPoints:route.callingPoints};
    board._mcv.trustCallingPatternsMatched++;
  }
  for (const service of trust.services || []) {
    if (output.length >= 200 || service.mcvSource !== 'TRUST' || service.category !== 'EE' || service.isPassengerService !== false) continue;
    const key = service.uid+'|'+service.sdd;
    if (seen.has(key)) continue;
    seen.add(key);
    // Darwin wins. A same-headcode/date conflict is withheld even when the UID
    // differs: it must be reconciled rather than added as a second train.
    if (original.some(existing => (!existing.sdd || String(existing.sdd) === service.sdd) &&
        (existing.uid === service.uid || existing.trainid === service.trainid))) continue;
    output.push({...service, trust:{...service.trust, expiresAt}});
    board._mcv.trustServicesAdded++;
  }
  const histories = new Map();
  for (const row of trust.histories || []) {
    const key = identity(row);
    histories.set(key,histories.has(key) ? null : row);
  }
  for (const service of output) {
    const row = histories.get(identity(service));
    if (!row || output.filter(item=>identity(item)===identity(service)).length !== 1) continue;
    const fields = ['sta','std'].filter(field=>service[field]);
    if (!fields.length || !fields.every(field=>sameBookedMinute(service[field],row[field]))) continue;
    const actual = row.events.filter(event=>event.timeBasis==='actual');
    const arrivals = actual.filter(event=>event.tiploc==='MNCRVIC' && event.kind==='arrival');
    const departures = actual.filter(event=>event.tiploc==='MNCRVIC' && event.kind==='departure');
    const dwell = arrivals.length===1 && departures.length===1 ? (Date.parse(departures[0].at)-Date.parse(arrivals[0].at))/1000 : null;
    service.trustHistory = {source:'TRUST',events:row.events,lastReport:actual.at(-1) || null,
      dwellSeconds:dwell!==null && dwell>=0 && dwell<=43200 ? dwell : null,reconciliationRequired:row.reconciliationRequired,expiresAt};
    board._mcv.trustHistoriesMatched++;
  }
  board.trainServices = output;
  board._mcv.servicesReturned = output.length;
}

