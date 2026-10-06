/*
 * Manchester Victoria shared live-data layer
 * -------------------------------------------
 * One place for:
 * - Cloudflare/RDM endpoint
 * - RDM -> display-model mapping
 * - station-name corrections
 * - formation / TPE First Class rule
 * - front-carriage boarding notices
 * - platform filtering
 * - delayed-service ordering
 * - last-good-data fallback + staleness state
 *
 * Include before a page's own script:
 *   <script src="mcv-data.js"></script>
 *
 * Then, for example:
 *   const result = await MCVData.fetchBoard();
 *   const next12 = MCVData.selectDepartures(result.services, { limit: 12 });
 */
(function (global) {
  'use strict';

  const VERSION = '1.2.0';

  const CONFIG = Object.freeze({
    departuresUrl: 'https://mcv-rdm-proxy.railstaffhub.uk/departures',
    refreshIntervalMs: 20000,
    staleAfterMs: 90000,
    lastGoodStorageKey: 'mcv-rdm-last-good-v1',
    maxStoredAgeMs: 6 * 60 * 60 * 1000,
    stationTimeZone: 'Europe/London'
  });

  const NON_PASSENGER_CLASSES = new Set(['freight', 'empty stock', 'trip']);

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function reasonText(value, depth) {
    depth = Number(depth) || 0;
    if (value == null || depth > 4) return '';

    if (typeof value === 'string' || typeof value === 'number') {
      const result = text(value);
      return result === '[object Object]' ? '' : result;
    }

    if (Array.isArray(value)) {
      const seen = new Set();
      return value.map(function (item) { return reasonText(item, depth + 1); })
        .filter(function (item) {
          if (!item || seen.has(item)) return false;
          seen.add(item);
          return true;
        }).join('; ');
    }

    if (typeof value === 'object') {
      const preferred = [
        'reasonText', 'reasonDescription', 'description', 'message', 'reason',
        'text', 'value', 'name', 'delayReason', 'lateReason', 'cancelReason',
        'cancellationReason'
      ];

      for (let i = 0; i < preferred.length; i += 1) {
        if (!Object.prototype.hasOwnProperty.call(value, preferred[i])) continue;
        const result = reasonText(value[preferred[i]], depth + 1);
        if (result) return result;
      }

      const values = Object.keys(value)
        .filter(function (key) {
          return !/^(?:id|code|reasonCode|category|type)$/i.test(key);
        })
        .map(function (key) { return reasonText(value[key], depth + 1); })
        .filter(Boolean);

      return values[0] || '';
    }

    return '';
  }

  function escapeHTML(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (char) {
      return ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      })[char];
    });
  }

  function rdmTime(value) {
    const valueText = text(value);

    if (/^\d{2}:\d{2}$/.test(valueText)) return valueText;

    // LDBSVWS Staff responses can supply DateTime values such as
    // 2026-10-05T19:30:00 instead of the HH:MM strings used by LDBWS.
    // Treat those as station-local clock values for display/sorting.
    const dateTime = /T(\d{2}):(\d{2})(?::\d{2})?/.exec(valueText);
    if (dateTime) return dateTime[1] + ':' + dateTime[2];

    return '--:--';
  }

  function londonClockParts(date) {
    const sourceDate = date instanceof Date ? date : new Date(date || Date.now());
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: CONFIG.stationTimeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).formatToParts(sourceDate);

    const obj = Object.fromEntries(parts.map(function (part) {
      return [part.type, part.value];
    }));

    return {
      year: Number(obj.year),
      month: Number(obj.month),
      day: Number(obj.day),
      hour: Number(obj.hour),
      minute: Number(obj.minute)
    };
  }

  // RDM times are station-local clock values. Anchor the clock time to the
  // generatedAt date and choose the nearest occurrence across midnight.
  function scheduledEpoch(hhmm, generatedAt) {
    const clock = rdmTime(hhmm);
    const match = /^(\d{2}):(\d{2})$/.exec(clock);
    if (!match) return Number.POSITIVE_INFINITY;

    const base = new Date(generatedAt || Date.now());
    const london = londonClockParts(base);

    let guess = Date.UTC(
      london.year,
      london.month - 1,
      london.day,
      Number(match[1]),
      Number(match[2])
    );

    // Align the neutral UTC guess with the actual Europe/London clock.
    for (let i = 0; i < 2; i += 1) {
      const shown = londonClockParts(new Date(guess));
      const desiredMinutes = Number(match[1]) * 60 + Number(match[2]);
      const shownMinutes = shown.hour * 60 + shown.minute;
      let deltaMinutes = desiredMinutes - shownMinutes;

      if (deltaMinutes > 720) deltaMinutes -= 1440;
      if (deltaMinutes < -720) deltaMinutes += 1440;
      guess += deltaMinutes * 60000;
    }

    const baseMs = base.getTime();
    if (guess < baseMs - 12 * 60 * 60 * 1000) guess += 24 * 60 * 60 * 1000;
    if (guess > baseMs + 12 * 60 * 60 * 1000) guess -= 24 * 60 * 60 * 1000;

    return guess;
  }

  function expectedMinutesLate(std, etd) {
    const booked = /^(\d{2}):(\d{2})$/.exec(rdmTime(std));
    const expected = /^(\d{2}):(\d{2})$/.exec(rdmTime(etd));
    if (!booked || !expected) return null;

    const bookedMinutes = Number(booked[1]) * 60 + Number(booked[2]);
    const expectedMinutes = Number(expected[1]) * 60 + Number(expected[2]);
    let difference = expectedMinutes - bookedMinutes;

    if (difference < -720) difference += 1440;
    if (difference > 720) difference -= 1440;

    return difference;
  }

  // Presentation-only correction used across the MCV screens.
  // SFD = Salford Central. SLD must remain Salford Crescent.
  function displayStationName(name, crs) {
    const rawName = text(name);
    const rawUpper = rawName.toUpperCase();
    const code = text(crs).toUpperCase();

    const operationalLocations = {
      CHNL159: 'Chinley Signal Cy159',
      NWTNHDD: 'Newton Heath TMD',
      ARDWTMD: 'Ardwick TMD',
      MNCRVRS: 'Manchester Victoria Turnback'
    };

    if (operationalLocations[code]) return operationalLocations[code];
    if (operationalLocations[rawUpper]) return operationalLocations[rawUpper];

    if (code === 'SFD') return 'Salford Central';
    if (rawUpper === 'SALFORD' && code !== 'SLD') return 'Salford Central';

    return rawName || code;
  }

  function coachCount(raw) {
    if (raw === null || raw === undefined || typeof raw === 'boolean' || raw === '') return null;
    const value = typeof raw === 'number' ? raw : Number(text(raw));
    return Number.isInteger(value) && value > 0 && value <= 30 ? value : null;
  }

  function isTransPennineExpress(operatorName, operatorCode) {
    const name = text(operatorName).replace(/\s+/g, ' ').toLowerCase();
    const code = text(operatorCode).toUpperCase();
    return code === 'TP' || name === 'tpe' || name.includes('transpennine express');
  }

  function allocationPrefix(service, view) {
    const departureMs = service.bookedMs == null ? service.scheduledMs : service.bookedMs;
    return view === 'arrivals' || (view === 'all' && !Number.isFinite(departureMs)) ? 'arrival' : 'departure';
  }

  function allocationFresh(service, nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const age = now - Date.parse(service && service.unitAllocation && service.unitAllocation.syncedAt || '');
    return Number.isFinite(age) && age >= 0 && age <= 6 * 60000;
  }

  function allocatedUnits(service, view) {
    if (!allocationFresh(service) || service.unitAllocation.status !== 'allocated') return [];
    const values = service.unitAllocation[allocationPrefix(service, view) + 'Units'];
    return Array.isArray(values) ? values.filter(function (unit) { return typeof unit === 'string' && /^\d{6}$/.test(unit); }) : [];
  }

  function allocationCarriages(service, view) {
    if (!allocatedUnits(service, view).length) return null;
    const value = service.unitAllocation[allocationPrefix(service, view) + 'Carriages'];
    return Number.isInteger(value) && value > 0 && value <= 100 ? value : null;
  }

  function displayCarriages(service, view) {
    return allocationCarriages(service, view) || coachCount(service.coaches);
  }

  function unitClass(service, unit, view) {
    if (!allocationFresh(service)) return '';
    const classes = service.unitAllocation[allocationPrefix(service, view) + 'UnitClasses'];
    const value = classes && classes[unit];
    return typeof value === 'string' && /^\d{3}(?:\/\d{1,3})?$/.test(value) ? 'Class ' + value : '';
  }

  function reportedUnitOrder(service, view) {
    return allocatedUnits(service, view).length > 0 && service.unitAllocation[allocationPrefix(service, view) + 'OrderKnown'] === true;
  }

  function inferredTpeFormation(service, view) {
    if (service.ecs || allocatedUnits(service, view).length || !isTransPennineExpress(service.operator, service.operatorCode)) return '';
    return ({3:'Class 185', 6:'2 × Class 185', 5:'Class 802'})[displayCarriages(service, view)] || '';
  }

  function firstClassPosition(service, view) {
    if (service.ecs || service.cancelled || !isTransPennineExpress(service.operator, service.operatorCode)) return '';
    const count = allocationCarriages(service, view);
    const allocation = service.unitAllocation;
    const positions = allocation && allocation[allocationPrefix(service, view) + 'FirstClassCarriages'];
    if (reportedUnitOrder(service, view) && count && Array.isArray(positions) && positions.length &&
        positions.every(function (position) { return Number.isInteger(position) && position >= 1 && position <= count; })) {
      const label = positions.length === 1
        ? (positions[0] === 1 ? 'front carriage' : positions[0] === count ? 'rear carriage' : 'carriage ' + positions[0] + ' of ' + count)
        : 'carriages ' + positions.join(' & ') + ' of ' + count;
      return 'First class: ' + label + ' · Gemini reported';
    }
    const notice = firstClassNotice(Object.assign({}, service, {coaches: displayCarriages(service, view)}));
    return notice ? 'First class: ' + notice.replace('FIRST CLASS: ', '') + ' · front/rear not supplied' : 'First-class position not supplied';
  }

  function formationSummary(service, view) {
    const gemini = allocationCarriages(service, view);
    const darwin = coachCount(service.coaches);
    return {
      carriages: gemini || darwin,
      geminiCarriages: gemini,
      darwinCarriages: darwin,
      source: gemini ? 'Gemini Feed' : darwin ? 'Darwin Feed' : '',
      units: allocatedUnits(service, view),
      orderKnown: reportedUnitOrder(service, view),
      inferredClass: inferredTpeFormation(service, view),
      firstClass: firstClassPosition(service, view),
      difference: gemini && darwin && gemini !== darwin ? 'Darwin: ' + darwin + ' cars · Gemini: ' + gemini + ' cars' : ''
    };
  }

  // Locally configured MCV boarding information.
  function frontCarriagesNotice(destinationName, destinationCrs, coaches) {
    const name = text(destinationName).replace(/\s+/g, ' ').toUpperCase();
    const code = text(destinationCrs).toUpperCase();

    // These local boarding notices apply when the live feed confirms
    // the service is formed of more than 2 carriages.
    if (!(coachCount(coaches) > 2)) return null;

    if (name === 'CLITHEROE' || code === 'CLH') {
      return {
        stops: 'LANGHO, WHALLEY & CLITHEROE',
        rowText: 'For LANGHO, WHALLEY & CLITHEROE, travel in the FRONT 2 CARRIAGES ONLY.'
      };
    }

    if (name === 'HEADBOLT LANE' || code === 'HBL') {
      return {
        stops: 'UPHOLLAND, RAINFORD & HEADBOLT LANE',
        rowText: 'For UPHOLLAND, RAINFORD & HEADBOLT LANE, travel in the FRONT 2 CARRIAGES ONLY.'
      };
    }

    return null;
  }

  function firstClassNotice(service) {
    if (!service || service.cancelled || service.statusClass === 'cancelled') return null;
    if (!isTransPennineExpress(service.operator, service.operatorCode)) return null;

    if (service.coaches === 3) return 'FIRST CLASS: COACH C';
    if (service.coaches === 5) return 'FIRST CLASS: COACH E';
    if (service.coaches === 6) return 'FIRST CLASS: COACHES C & G';

    return null;
  }

  function formationText(service) {
    if (!service || service.coaches === null) return '';
    const count = service.coaches;
    const base = count + ' ' + (count === 1 ? 'CARRIAGE' : 'CARRIAGES');
    const firstClass = firstClassNotice(service);
    return firstClass ? base + ' · ' + firstClass : base;
  }

  function platformBase(platform) {
    const raw = text(platform).toUpperCase();
    const match = /^(\d+)/.exec(raw);
    return match ? match[1] : raw;
  }

  function platformMatches(platform, target) {
    if (target === undefined || target === null || target === '') return true;

    const currentRaw = text(platform).toUpperCase();
    const currentBase = platformBase(currentRaw);
    const targets = Array.isArray(target) ? target : [target];

    return targets.some(function (wanted) {
      const wantedRaw = text(wanted).toUpperCase();
      if (!wantedRaw) return true;
      return currentRaw === wantedRaw || currentBase === platformBase(wantedRaw);
    });
  }

  function parseCallingPointGroups(service, property) {
    const groups = Array.isArray(service && service[property])
      ? service[property]
      : [];

    const points = groups.flatMap(function (group) {
      return Array.isArray(group && group.callingPoint) ? group.callingPoint : [];
    });

    return points.map(function (point) {
      return {
        name: displayStationName(point && point.locationName, point && point.crs),
        rawName: text(point && point.locationName),
        crs: text(point && point.crs).toUpperCase(),
        scheduled: rdmTime(point && point.st),
        expected: text(point && point.et),
        platform: text(point && point.platform),
        cancelled: Boolean(point && point.isCancelled),
        coaches: coachCount(point && point.length),
        affectedByDiversion: Boolean(point && point.affectedByDiversion),
        rerouteDelay: Number(point && point.rerouteDelay) || 0,
        delayReason: reasonText(point && point.delayReason)
      };
    });
  }

  function parseCallingPoints(service) {
    return parseCallingPointGroups(service, 'subsequentCallingPoints');
  }

  function parsePreviousCallingPoints(service) {
    return parseCallingPointGroups(service, 'previousCallingPoints');
  }

  function statusForService(service) {
    const rawStd = text(service && service.std);
    const rawEtd = text(service && service.etd);
    const rawAtd = text(service && service.atd);

    const std = rdmTime(rawStd);
    const etd = rdmTime(rawEtd);
    const atd = rdmTime(rawAtd);

    const cancelled = Boolean(service && (service.isCancelled || service.filterLocationCancelled)) || /^cancelled$/i.test(rawEtd);
    const departed = atd !== '--:--';
    const minutesLate = expectedMinutesLate(std, etd);
    const delayed = !cancelled && (
      /^delayed$/i.test(rawEtd) ||
      (minutesLate !== null && minutesLate > 0)
    );

    let label = 'On time';
    let className = 'on-time';

    if (cancelled) {
      label = 'Cancelled';
      className = 'cancelled';
    } else if (/^delayed$/i.test(rawEtd)) {
      label = 'Delayed';
      className = 'delayed';
    } else if (etd !== '--:--' && etd !== std) {
      label = 'Expected ' + etd;
      className = delayed ? 'delayed' : 'on-time';
    } else if (rawEtd && etd === '--:--' && !/^on time$/i.test(rawEtd)) {
      label = rawEtd;
      className = delayed ? 'delayed' : 'on-time';
    }

    return {
      label: label,
      className: className,
      cancelled: cancelled,
      departed: departed,
      delayed: delayed,
      minutesLate: minutesLate,
      booked: std,
      expected: etd !== '--:--' ? etd : '',
      rawExpected: rawEtd,
      actual: atd !== '--:--' ? atd : ''
    };
  }

  function parseService(service, generatedAt, index) {
    const raw = service || {};
    const status = statusForService(raw);

    const destinations = Array.isArray(raw.destination) ? raw.destination : [];
    const destinationNames = destinations
      .map(function (destination) {
        return displayStationName(destination && destination.locationName, destination && destination.crs);
      })
      .filter(Boolean);

    const destination = destinationNames.length ? destinationNames.join(' & ') : 'Unknown';
    const destinationCrs = text(destinations[0] && destinations[0].crs).toUpperCase();

    const origins = Array.isArray(raw.origin) ? raw.origin : [];
    const originNames = origins
      .map(function (origin) {
        return displayStationName(origin && origin.locationName, origin && origin.crs);
      })
      .filter(Boolean);

    const callingPoints = parseCallingPoints(raw);
    const activeCallingPoints = callingPoints.filter(function (point) { return !point.cancelled; });
    const coaches = coachCount(raw.length);

    const serviceId = text(raw.serviceID);
    const rid = text(raw.rid);
    const rsid = text(raw.rsid);
    const uid = text(raw.uid);
    const headcode = text(raw.trainid || raw.trainId || raw.headcode).toUpperCase();

    const key = serviceId || rid || rsid || [
      text(raw.std),
      text(raw.operatorCode || raw.operator || 'operator'),
      destination,
      String(index == null ? '' : index)
    ].join('|');

    const parsed = {
      key: key,
      serviceId: serviceId,
      trainId: headcode || serviceId || rid || rsid,
      headcode: headcode,
      uid: uid,
      rid: rid,
      rsid: rsid,
      scheduledDepartureDate: text(raw.sdd),

      scheduledMs: scheduledEpoch(raw.std, generatedAt),
      time: rdmTime(raw.std),
      booked: rdmTime(raw.std),
      expected: status.expected,
      actual: status.actual,

      destination: destination,
      destinationCrs: destinationCrs,
      destinations: destinations.map(function (destinationEntry) {
        return {
          name: displayStationName(destinationEntry && destinationEntry.locationName, destinationEntry && destinationEntry.crs),
          crs: text(destinationEntry && destinationEntry.crs).toUpperCase(),
          via: text(destinationEntry && destinationEntry.via)
        };
      }),
      origin: originNames.join(' & '),
      origins: origins.map(function (originEntry) {
        return {
          name: displayStationName(originEntry && originEntry.locationName, originEntry && originEntry.crs),
          crs: text(originEntry && originEntry.crs).toUpperCase()
        };
      }),

      operator: text(raw.operator) || 'National Rail',
      operatorCode: text(raw.operatorCode).toUpperCase(),
      platform: text(raw.platform),
      platformBase: platformBase(raw.platform),

      coaches: coaches,
      reverseFormation: Boolean(raw.isReverseFormation),
      unitAllocation: raw.unitAllocation || null,
      detachFront: Boolean(raw.detachFront),

      status: status.label,
      statusClass: status.className,
      cancelled: status.cancelled,
      isCancelled: status.cancelled,
      departed: status.departed,
      isDeparted: status.departed,
      delayed: status.delayed,
      isDelayed: status.delayed,
      minutesLate: status.minutesLate,

      delayReason: status.delayed ? reasonText(raw.delayReason) : '',
      lateReason: status.delayed ? reasonText(raw.delayReason) : '',
      cancellationReason: status.cancelled ? reasonText(raw.cancelReason || raw.delayReason) : '',
      cancelReason: status.cancelled ? reasonText(raw.cancelReason || raw.delayReason) : '',

      callingPoints: callingPoints,
      activeCallingPoints: activeCallingPoints,
      stops: activeCallingPoints.map(function (point) { return point.name; }),
      stopsText: activeCallingPoints.map(function (point) { return point.name; }).join(', '),

      frontCarriages: frontCarriagesNotice(destination, destinationCrs, coaches),

      futureCancellation: Boolean(raw.futureCancellation),
      futureDelay: Boolean(raw.futureDelay),
      serviceType: text(raw.serviceType || 'train').toLowerCase(),
      serviceClass: text(raw.serviceType || 'train').toLowerCase(),
      notForDisplay: text(raw.serviceType || 'train').toLowerCase() !== 'train',
      affectedByDiversion: activeCallingPoints.some(function (point) { return point.affectedByDiversion; }),

      raw: raw
    };

    parsed.firstClassNotice = firstClassNotice(parsed);
    parsed.formationText = formationText(parsed);

    return parsed;
  }

  function parseBoard(data) {
    if (!data || !Array.isArray(data.trainServices)) {
      throw new Error('Unexpected RDM departure data');
    }

    const generatedAt = data.generatedAt || new Date().toISOString();
    const services = data.trainServices.map(function (service, index) {
      return parseService(service, generatedAt, index);
    });

    return {
      generatedAt: generatedAt,
      locationName: text(data.locationName) || 'Manchester Victoria',
      crs: text(data.crs).toUpperCase() || 'MCV',
      platformAvailable: data.platformAvailable !== false,
      servicesAvailable: data.areServicesAvailable !== false,
      services: services,
      raw: data
    };
  }

  function isPassengerService(service) {
    if (!service) return false;
    if (service.notForDisplay) return false;
    if (NON_PASSENGER_CLASSES.has(text(service.serviceClass).toLowerCase())) return false;
    return true;
  }

  // Delayed trains only rise to the top after their booked departure time.
  function isOverdueDelayed(service, nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    return Boolean(
      service &&
      service.delayed &&
      Number.isFinite(service.scheduledMs) &&
      service.scheduledMs < now
    );
  }

  function selectDepartures(services, options) {
    const opts = Object.assign({
      limit: 12,
      platform: null,
      includeCancelled: true,
      includeDeparted: false,
      overdueFirst: true,
      nowMs: Date.now()
    }, options || {});

    let selected = (Array.isArray(services) ? services : []).filter(function (service) {
      if (!isPassengerService(service)) return false;
      if (!opts.includeDeparted && service.departed) return false;
      if (!opts.includeCancelled && service.cancelled) return false;
      if (!platformMatches(service.platform, opts.platform)) return false;
      return true;
    });

    selected.sort(function (a, b) {
      return (a.scheduledMs - b.scheduledMs) || a.key.localeCompare(b.key);
    });

    if (Number.isFinite(opts.limit) && opts.limit > 0) {
      selected = selected.slice(0, opts.limit);
    }

    if (opts.overdueFirst) {
      selected.sort(function (a, b) {
        return Number(isOverdueDelayed(b, opts.nowMs)) - Number(isOverdueDelayed(a, opts.nowMs)) ||
          (a.scheduledMs - b.scheduledMs) ||
          a.key.localeCompare(b.key);
      });
    }

    return selected;
  }

  function chooseNextService(services, options) {
    const opts = Object.assign({
      platform: null,
      includeCancelled: false,
      nowMs: Date.now()
    }, options || {});

    const candidates = selectDepartures(services, {
      limit: Number.POSITIVE_INFINITY,
      platform: opts.platform,
      includeCancelled: opts.includeCancelled,
      includeDeparted: false,
      overdueFirst: true,
      nowMs: opts.nowMs
    });

    return candidates[0] || null;
  }

  function safeStorageGet(key) {
    try {
      return global.localStorage ? global.localStorage.getItem(key) : null;
    } catch (_) {
      return null;
    }
  }

  function safeStorageSet(key, value) {
    try {
      if (global.localStorage) global.localStorage.setItem(key, value);
    } catch (_) {
      // Displays must continue to operate if storage is unavailable/full.
    }
  }

  function saveLastGood(raw, receivedAt, storageKey) {
    if (!raw || !Array.isArray(raw.trainServices)) return;

    safeStorageSet(storageKey || CONFIG.lastGoodStorageKey, JSON.stringify({
      receivedAt: receivedAt || Date.now(),
      data: raw
    }));
  }

  function loadLastGood(nowMs, storageKey) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const stored = safeStorageGet(storageKey || CONFIG.lastGoodStorageKey);
    if (!stored) return null;

    try {
      const parsed = JSON.parse(stored);
      const receivedAt = Number(parsed && parsed.receivedAt);
      const data = parsed && parsed.data;
      if (!Number.isFinite(receivedAt) || !data || !Array.isArray(data.trainServices)) return null;

      const ageMs = Math.max(0, now - receivedAt);
      if (ageMs > CONFIG.maxStoredAgeMs) return null;

      return {
        receivedAt: receivedAt,
        ageMs: ageMs,
        data: data
      };
    } catch (_) {
      return null;
    }
  }

  function freshness(receivedAt, nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const received = Number(receivedAt);
    const ageMs = Number.isFinite(received) ? Math.max(0, now - received) : Number.POSITIVE_INFINITY;

    return {
      ageMs: ageMs,
      stale: ageMs > CONFIG.staleAfterMs,
      receivedAt: Number.isFinite(received) ? received : null
    };
  }

  const rawRequests = new Map();
  function fetchRaw(options) {
    const opts = Object.assign({url: CONFIG.departuresUrl, timeoutMs: 12000}, options || {});
    const key = !opts.signal ? JSON.stringify([opts.url, opts.timeoutMs]) : null;
    if (key && rawRequests.has(key)) return rawRequests.get(key);
    const work = fetchRawOnce(opts);
    if (key) {
      rawRequests.set(key, work);
      work.then(function () { rawRequests.delete(key); }, function () { rawRequests.delete(key); });
    }
    return work;
  }

  async function fetchRawOnce(options) {
    const opts = Object.assign({
      url: CONFIG.departuresUrl,
      timeoutMs: 12000,
      signal: null
    }, options || {});

    const controller = !global.MCVSite && typeof AbortController !== 'undefined' ? new AbortController() : null;
    let timeoutId = null;

    const forwardAbort = function () { controller.abort(); };
    if (controller && opts.signal) {
      if (opts.signal.aborted) controller.abort();
      else opts.signal.addEventListener('abort', forwardAbort, { once: true });
    }

    if (controller && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0) {
      timeoutId = setTimeout(function () { controller.abort(); }, opts.timeoutMs);
    }

    try {
      const request = global.MCVSite ? global.MCVSite.fetch : global.fetch.bind(global);
      const response = await request(opts.url, {
        method: 'GET',
        cache: 'no-store',
        headers: { 'Accept': 'application/json' },
        timeoutMs: opts.timeoutMs,
        signal: controller ? controller.signal : opts.signal || undefined
      });

      if (!response.ok) {
        throw new Error('RDM proxy HTTP ' + response.status);
      }

      const data = await response.json();
      if (!data || !Array.isArray(data.trainServices)) {
        throw new Error('Unexpected RDM departure data');
      }

      return data;
    } finally {
      if (timeoutId !== null) clearTimeout(timeoutId);
      if (controller && opts.signal) opts.signal.removeEventListener('abort', forwardAbort);
    }
  }

  // Fetch live data; if that fails, optionally return the last good board from
  // this browser. Consumers can decide how to present a stale-data warning.
  async function fetchBoard(options) {
    const opts = Object.assign({
      allowStale: true,
      timeoutMs: 12000,
      nowMs: Date.now()
    }, options || {});
    const cacheKey = opts.url && opts.url !== CONFIG.departuresUrl ? CONFIG.lastGoodStorageKey + ':' + opts.url : CONFIG.lastGoodStorageKey;

    try {
      const raw = await fetchRaw(opts);
      const receivedAt = Date.now();
      saveLastGood(raw, receivedAt, cacheKey);
      const board = parseBoard(raw);
      const fresh = freshness(receivedAt, opts.nowMs);

      return Object.assign({}, board, fresh, {
        source: 'live',
        live: true,
        fallback: false,
        error: null
      });
    } catch (error) {
      if (!opts.allowStale) throw error;

      const cached = loadLastGood(opts.nowMs, cacheKey);
      if (!cached) throw error;
      if (global.MCVSite) global.MCVSite.reportFallback(cached.data, cached.receivedAt);

      const board = parseBoard(cached.data);
      const fresh = freshness(cached.receivedAt, opts.nowMs);

      return Object.assign({}, board, fresh, {
        source: 'last-good',
        live: false,
        fallback: true,
        error: error
      });
    }
  }

  function ageLabel(ageMs) {
    const age = Math.max(0, Number(ageMs) || 0);
    if (age < 60000) return Math.round(age / 1000) + ' sec ago';
    if (age < 60 * 60000) return Math.round(age / 60000) + ' min ago';
    return Math.round(age / (60 * 60000)) + ' hr ago';
  }


  // ---------- Shared live clock/date helpers ----------
  // Live clocks include seconds. Timetable times stay HH:MM because Darwin/RDM
  // only supplies them to minute precision.
  function formatLiveClock(value) {
    const date = value instanceof Date ? value : new Date(value == null ? Date.now() : value);
    if (!Number.isFinite(date.getTime())) return '--:--:--';
    return new Intl.DateTimeFormat('en-GB', {
      timeZone: CONFIG.stationTimeZone,
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }).format(date);
  }

  function formatLiveDate(value, options) {
    const date = value instanceof Date ? value : new Date(value == null ? Date.now() : value);
    if (!Number.isFinite(date.getTime())) return '--';
    return new Intl.DateTimeFormat('en-GB', Object.assign({
      timeZone: CONFIG.stationTimeZone,
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
    }, options || {})).format(date);
  }

  function resolveElement(target) {
    if (!target) return null;
    if (typeof target === 'string') {
      return global.document ? global.document.getElementById(target) : null;
    }
    return target;
  }

  function updateClock(timeTarget, dateTarget, options) {
    const opts = options || {};
    const now = new Date();
    const timeNode = resolveElement(timeTarget);
    const dateNode = resolveElement(dateTarget);
    if (timeNode) timeNode.textContent = formatLiveClock(now);
    if (dateNode) dateNode.textContent = formatLiveDate(now, opts.dateOptions);
    return now;
  }

  function startClock(timeTarget, dateTarget, options) {
    const opts = Object.assign({ intervalMs: 1000 }, options || {});
    updateClock(timeTarget, dateTarget, opts);
    const id = global.setInterval(function () {
      updateClock(timeTarget, dateTarget, opts);
    }, opts.intervalMs);
    return function stopClock() { global.clearInterval(id); };
  }

  // ---------- Legacy adapter ----------
  // Some established display renderers still consume the older Traini-shaped
  // model. Keeping the adapter here means RDM interpretation stays centralised.
  function clockToIso(clock, generatedAt) {
    const normalisedClock = rdmTime(clock);
    if (normalisedClock === '--:--') return null;
    const ms = scheduledEpoch(normalisedClock, generatedAt);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }

  function expectedClockToIso(value, booked, generatedAt) {
    const raw = text(value);
    const clock = rdmTime(raw);
    if (clock !== '--:--') return clockToIso(clock, generatedAt);
    if (/^(on time|early)$/i.test(raw)) return clockToIso(booked, generatedAt);
    return null;
  }

  function legacyStatus(service) {
    const status = statusForService(service || {});
    const rawEtd = text(service && service.etd);
    const etd = rdmTime(rawEtd);

    if (status.departed) return ['departed', 'Departed'];
    if (status.cancelled) return ['cancelled', 'Cancelled'];
    if (/^delayed$/i.test(rawEtd)) return ['delayed_no_estimate', 'Delayed'];
    if (status.delayed && etd !== '--:--') return ['expected_late', 'Expected ' + etd];
    if (etd !== '--:--' && expectedMinutesLate(service.std, etd) < 0) {
      return ['expected_early', 'Expected ' + etd];
    }
    if (/^(on time|early)$/i.test(rawEtd) || !rawEtd || etd === rdmTime(service.std)) {
      return ['on_time', 'On time'];
    }

    return ['', status.label || rawEtd || 'Status not supplied'];
  }

  function toLegacyBoard(input) {
    const data = input && input.raw && Array.isArray(input.raw.trainServices)
      ? input.raw
      : input;
    if (!data || !Array.isArray(data.trainServices)) return data;

    const generatedAt = data.generatedAt || new Date().toISOString();

    return {
      generated_at: generatedAt,
      results: data.trainServices.map(function (service, index) {
        const statusPair = legacyStatus(service);
        const destination = Array.isArray(service.destination)
          ? (service.destination[0] || {})
          : (service.destination || {});
        const origin = Array.isArray(service.origin)
          ? (service.origin[0] || {})
          : (service.origin || {});
        const booked = clockToIso(service.std, generatedAt);
        const expected = expectedClockToIso(service.etd, service.std, generatedAt);
        const bookedArrival = clockToIso(service.sta, generatedAt);
        const expectedArrival = expectedClockToIso(service.eta, service.sta, generatedAt);
        const actualArrival = clockToIso(service.ata, generatedAt);
        const actualDeparture = clockToIso(service.atd, generatedAt);

        function legacyPoint(point) {
          const scheduled = clockToIso(point.scheduled, generatedAt);
          const expectedPoint =
            expectedClockToIso(point.expected, point.scheduled, generatedAt) || scheduled;

          return {
            station: { name: point.rawName || point.name, crs: point.crs },
            name: point.rawName || point.name,
            crs: point.crs,
            scheduled: scheduled,
            arrives: scheduled,
            departs: scheduled,
            expected: expectedPoint,
            expected_arrives: expectedPoint,
            expected_departs: expectedPoint,
            platform: point.platform,
            platform_withheld: !point.platform,
            is_cancelled: point.cancelled,
            affected_by_diversion: point.affectedByDiversion === true,
            reroute_delay: Number(point.rerouteDelay) || 0,
            delay_reason: reasonText(point.delayReason)
          };
        }

        const points = parseCallingPoints(service).map(legacyPoint);
        const previousPoints = parsePreviousCallingPoints(service).map(legacyPoint);

        return {
          train_id: text(service.trainid || service.serviceID || service.rid || service.rsid || ('rdm-' + index)),
          train_uid: text(service.uid),
          headcode: text(service.trainid),
          uid: text(service.uid),
          rid: text(service.rid),
          service_id: text(service.serviceID),
          rsid: text(service.rsid),
          scheduled_departure_date: text(service.sdd),
          departs: booked,
          expected_departs: expected,
          actual_departs: actualDeparture,
          arrives: bookedArrival,
          expected_arrives: actualArrival || expectedArrival,
          actual_arrives: actualArrival,
          arrival_type: text(service.arrivalType),
          departure_type: text(service.departureType),
          status: statusPair[0],
          status_text: statusPair[1],
          destination: {
            name: text(destination.locationName || destination.name || 'Unknown'),
            crs: text(destination.crs)
          },
          destination_name: text(destination.locationName || destination.name || 'Unknown'),
          destination_crs: text(destination.crs),
          origin: {
            name: text(origin.locationName || origin.name),
            crs: text(origin.crs)
          },
          origin_name: text(origin.locationName || origin.name),
          origin_crs: text(origin.crs),
          operator: text(service.operator || 'National Rail'),
          operator_code: text(service.operatorCode),
          platform: text(service.platform),
          platform_withheld: !text(service.platform),
          platform_hidden: service.platformIsHidden === true,
          calling_points: points,
          previous_calling_points: previousPoints,
          coaches: coachCount(service.length),
          unit_allocation: service.unitAllocation || null,
          late_reason: reasonText(service.delayReason),
          cancel_reason: reasonText(service.cancelReason || (service.isCancelled ? service.delayReason : '')),
          not_for_display: text(service.serviceType || 'train').toLowerCase() !== 'train',
          service_class: text(service.serviceType || 'train').toLowerCase(),
          train_category: text(service.category),
          activities: Array.isArray(service.activities) ? service.activities.join(' ') : text(service.activities),
          is_passenger_service: service.isPassengerService !== false,
          is_charter: service.isCharter === true,
          is_reverse_formation: service.isReverseFormation === true,
          is_operational_call: service.isOperationalCall === true,
          uncertainty: text(service.uncertainty),
          future_delay: service.futureDelay === true,
          future_cancellation: service.futureCancellation === true
        };
      })
    };
  }

  async function fetchLegacyBoard(options) {
    const board = await fetchBoard(options);
    return Object.assign({}, board, { legacy: toLegacyBoard(board.raw) });
  }

  global.MCVData = Object.freeze({
    VERSION: VERSION,
    CONFIG: CONFIG,

    escapeHTML: escapeHTML,
    reasonText: reasonText,
    rdmTime: rdmTime,
    scheduledEpoch: scheduledEpoch,
    expectedMinutesLate: expectedMinutesLate,
    displayStationName: displayStationName,
    coachCount: coachCount,
    isTransPennineExpress: isTransPennineExpress,
    frontCarriagesNotice: frontCarriagesNotice,
    firstClassNotice: firstClassNotice,
    formationText: formationText,
    platformBase: platformBase,
    platformMatches: platformMatches,
    parseCallingPoints: parseCallingPoints,
    parsePreviousCallingPoints: parsePreviousCallingPoints,
    statusForService: statusForService,
    allocationPrefix: allocationPrefix,
    allocationFresh: allocationFresh,
    allocatedUnits: allocatedUnits,
    allocationCarriages: allocationCarriages,
    displayCarriages: displayCarriages,
    unitClass: unitClass,
    reportedUnitOrder: reportedUnitOrder,
    inferredTpeFormation: inferredTpeFormation,
    firstClassPosition: firstClassPosition,
    formationSummary: formationSummary,
    parseService: parseService,
    parseBoard: parseBoard,
    isPassengerService: isPassengerService,
    isOverdueDelayed: isOverdueDelayed,
    selectDepartures: selectDepartures,
    chooseNextService: chooseNextService,
    saveLastGood: saveLastGood,
    loadLastGood: loadLastGood,
    freshness: freshness,
    fetchRaw: fetchRaw,
    fetchBoard: fetchBoard,
    ageLabel: ageLabel,
    formatLiveClock: formatLiveClock,
    formatLiveDate: formatLiveDate,
    updateClock: updateClock,
    startClock: startClock,
    clockToIso: clockToIso,
    expectedClockToIso: expectedClockToIso,
    toLegacyBoard: toLegacyBoard,
    fetchLegacyBoard: fetchLegacyBoard
  });
})(typeof window !== 'undefined' ? window : globalThis);
