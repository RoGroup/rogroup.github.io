/* Read-only explanations of the feed evidence available to the staff board. */
(function(global){
  'use strict';
  function describe(input,now=Date.now()){
    const meta=input.meta||{},snapshot=input.snapshot||{},trust=snapshot.trust||{},service=input.service;
    const rows=[];
    const add=(group,label,value,warning=false)=>rows.push({group,label,value,warning});
    const age=stamp=>{const value=Date.parse(stamp||'');return Number.isFinite(value)?now-value:null};
    const fresh=(stamp,max)=>{const value=age(stamp);return value!==null&&value>=-30000&&value<=max};
    const stamp=value=>{
      const elapsed=age(value);
      if(elapsed===null)return 'Not supplied';
      const at=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(value));
      if(elapsed < -30000)return at+' · timestamp is in the future';
      const seconds=Math.max(0,Math.floor(elapsed/1000));
      return at+' · '+(seconds<60?seconds+'s':seconds<3600?Math.floor(seconds/60)+'m':Math.floor(seconds/3600)+'h '+Math.floor(seconds%3600/60)+'m')+' ago';
    };
    const boardFresh=Number.isFinite(input.receivedAt)&&input.receivedAt>0&&now-input.receivedAt<=90000&&now-input.receivedAt>=-30000;
    const generatedFresh=fresh(input.generatedAt,90000);
    add('Darwin','Board updates',!input.receivedAt?'Waiting for data':input.boardError?'Refresh failed · showing last received board':!boardFresh||!generatedFresh?'Board is stale or its generation time is unavailable':'Receiving recent board updates',!boardFresh||!generatedFresh||Boolean(input.boardError));
    add('Darwin','Board generated',stamp(input.generatedAt),!generatedFresh);
    add('Darwin','Board received',stamp(input.receivedAt?new Date(input.receivedAt).toISOString():null),!boardFresh);

    const unitStamp=meta.unitSnapshotAt||snapshot.updatedAt;
    const unitReader=meta.unitReaderRunning??snapshot.readerRunning;
    const unitFresh=fresh(unitStamp,360000);
    const unitAvailable=meta.unitAllocationsAvailable??snapshot.available;
    add('Gemini','Allocation reader',unitReader===true?'Reported active':unitReader===false?'Reported offline':'State not supplied',unitReader!==true);
    add('Gemini','Allocation snapshot',stamp(unitStamp),!unitFresh);
    add('Gemini','Inspected snapshot coverage',Number.isInteger(snapshot.allocationRecords)&&Number.isInteger(snapshot.allocatedRecords)?snapshot.allocatedRecords+' of '+snapshot.allocationRecords+' published service records contain allocated units':'Not inspected yet');
    add('Gemini','Allocation availability',unitReader===false?'Reader offline':!unitFresh?'Snapshot missing or older than 6 minutes':unitAvailable===true?'Available':unitAvailable===false?'Worker reports allocations unavailable':'Availability not supplied',unitReader!==true||!unitFresh||unitAvailable!==true);

    const trustStamp=meta.trustSnapshotAt||trust.updatedAt;
    const trustFresh=fresh(trustStamp,360000);
    const captureFresh=fresh(trust.feedAt,300000),scheduleFresh=fresh(trust.scheduleAt,36*3600000);
    const trustAvailable=meta.trustAvailable;
    let trustState=trustAvailable===true&&trustFresh?'Worker reports TRUST available':trustAvailable===false?'Worker reports TRUST unavailable':!trustFresh?'TRUST snapshot missing or stale':'Availability not supplied';
    if(trust.feedAt&&!captureFresh)trustState='TRUST capture is stale or has an invalid timestamp';
    if(trust.scheduleAt&&!scheduleFresh)trustState='Timetable extract is stale or has an invalid timestamp';
    const trustWarning=trustAvailable!==true||!trustFresh||(trust.feedAt&&!captureFresh)||(trust.scheduleAt&&!scheduleFresh);
    add('TRUST','Board TRUST availability',trustState,Boolean(trustWarning));
    add('TRUST','TRUST snapshot',stamp(trustStamp),!trustFresh);
    add('TRUST','Last TRUST capture',stamp(trust.feedAt),!captureFresh);
    add('TRUST','Timetable extract',stamp(trust.scheduleAt),!scheduleFresh);
    const count=(key)=>Number.isInteger(meta[key])&&meta[key]>=0?String(meta[key]):'Not supplied';
    add('TRUST','Joined to this board','ECS '+count('trustServicesAdded')+' · movement reports '+count('trustMovementsMatched')+' · booked patterns '+count('trustCallingPatternsMatched')+' · histories '+count('trustHistoriesMatched'));

    add('Publisher','Latest accepted snapshot',stamp(snapshot.updatedAt),!fresh(snapshot.updatedAt,360000));
    add('Publisher','Snapshot inspection',input.snapshotBusy?'Checking snapshot…':input.snapshotError?(input.inspectedAt?'Check failed · showing last inspected snapshot':'Snapshot check failed'):input.inspectedAt?stamp(new Date(input.inspectedAt).toISOString()):'Open this panel to inspect the snapshot',Boolean(input.snapshotError));
    add('Publisher','Meaning of snapshot time','The timestamp records a snapshot accepted by the Worker; it does not prove every source supplied data.');

    if(service){
      const missing=[];
      if(!/^[A-Z]\d{5}$/.test(service.uid||''))missing.push('valid UID');
      if(!/^[0-9][A-Z]\d{2}$/.test(service.headcode||''))missing.push('valid headcode');
      if(!/^\d{4}-\d\d-\d\d$/.test(service.serviceDate||''))missing.push('operating date');
      add('Selected service','Identity',missing.length?'Missing '+missing.join(', '):service.headcode+' · '+service.uid+' · '+service.serviceDate,missing.length>0);
      const allocation=service.unitAllocation;
      add('Selected service','Unit allocations',input.allocationDescription||(!allocation?'No allocation match returned':allocation.status==='unallocated'?'Gemini reports no allocated units':allocation.status==='not-supplied'?'No matching allocation snapshot supplied':'Allocation supplied'),!allocation||allocation.status!=='allocated'||!fresh(allocation.syncedAt,360000));
      let calls,warning=false;
      if(service.stops?.length)calls=service.callingPointsReturned===0?'Destination-only display fallback; no calling pattern returned':service.callingPointsSource?'Booked timetable fallback · '+service.stops.length+' stops':service.source==='TRUST'?'TRUST booked ECS route · '+service.stops.length+' stops':'Darwin supplied '+service.stops.length+' calling points';
      else{
        warning=true;
        calls=service.terminatesEarly?'Terminates early; an onward booked fallback is withheld':service.cancelled?'Service cancelled; booked fallback is withheld':service.futureCancellation||service.stopsRemoved||service.routeDiverted?'Live alteration/cancellation flagged; booked fallback is withheld':missing.length?'Required matching identifiers are missing':trustWarning?'TRUST unavailable or stale; no booked fallback is available':'No matched pattern returned; upstream reason not supplied';
      }
      add('Selected service','Calling points',calls,warning);
      const history=service.trustHistory;
      const historyFresh=Boolean(history&&age(history.expiresAt)!==null&&age(history.expiresAt)<0&&age(history.expiresAt)>=-360000);
      add('Selected service','Journey history',historyFresh?'Matched history · '+(history.events?.length||0)+' captured reports':missing.length?'Required matching identifiers are missing':trustWarning?'TRUST unavailable or stale; history hidden':'No matched history returned; upstream reason not supplied',!historyFresh);
      add('Selected service','Missing-match detail','A missing match alone cannot distinguish a missing activation, absent timetable, conflicting identity or failed route/time checks.');
    }else add('Selected service','Service diagnostics','Select a service in the board to inspect its identifiers and missing data.');
    return rows;
  }
  global.MCVFeedDiagnostics=Object.freeze({describe});
})(typeof window!=='undefined'?window:globalThis);
