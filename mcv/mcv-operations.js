/* Staff summaries: no network requests, no confirmed stock-diagram claims. */
(function(root){
'use strict';
const minute=60000;
const fresh=(value,max,now)=>{const age=now-Date.parse(value||'');return Number.isFinite(age)&&age>=-30000&&age<=max;};
function health(meta,generatedAt,boardError,now=Date.now()){
  meta=meta||{};const ops=meta.operations,summaryFresh=fresh(ops?.updatedAt,6*minute,now);
  const row=(name,ok,at,note)=>({name,status:ok?'Current':at?'Stale / unavailable':'Not supplied',at:at||null,note});
  return [row('Darwin',!boardError&&fresh(generatedAt,2*minute,now),generatedAt,'Board generated time'),
    row('Gemini',meta.unitAllocationsAvailable===true&&meta.unitReaderRunning===true&&fresh(meta.unitSnapshotAt,6*minute,now),meta.unitSnapshotAt,'Allocation publisher snapshot; reader '+(meta.unitReaderRunning===true?'running':meta.unitReaderRunning===false?'stopped':'unknown')),
    row('TRUST',meta.trustAvailable===true&&fresh(meta.trustSnapshotAt,6*minute,now)&&fresh(meta.trustFeedAt,5*minute,now),meta.trustFeedAt,'Last captured movement batch'),
    row('VSTP',summaryFresh&&ops?.vstp?.available===true&&!ops.vstp.blocked&&fresh(ops.vstp.feedAt,3*minute,now),ops?.vstp?.feedAt,ops?.vstp?.blocked?'Capture blocked; inspection required':'Last verified broker catch-up'),
    row('Daily timetable',summaryFresh&&fresh(ops?.scheduleAt||meta.timetableScheduleAt,36*60*minute,now),ops?.scheduleAt||meta.timetableScheduleAt,'Full timetable extract time')];
}
const unitKey=values=>Array.isArray(values)&&values.length&&values.every(x=>/^\d{6}$/.test(x))?[...new Set(values)].sort().join('|'):'';
function turnaroundLinks(services,now=Date.now()){
  const active=services.filter(s=>!s.cancelled&&!s.futureCancellation&&!s.routeDiverted&&!s.recentlyDeparted);
  const candidates=[];
  for(const a of active){
    if(!Number.isFinite(a.bookedArrivalMs)||Number.isFinite(a.bookedMs))continue;
    for(const b of active){
      if(a.key===b.key||!Number.isFinite(b.bookedMs)||Number.isFinite(b.bookedArrivalMs))continue;
      const gap=b.bookedMs-a.bookedArrivalMs;
      if(gap<0||gap>120*minute||b.bookedMs<now-15*minute||a.bookedArrivalMs>now+6*60*minute)continue;
      const sameSchedule=a.uid&&a.uid===b.uid&&a.serviceDate&&a.serviceDate===b.serviceDate;
      const au=unitKey(a.arrivalUnits),bu=unitKey(b.departureUnits);
      if(!sameSchedule&&!(au&&au===bu))continue;
      // Conflicting supplied stock defeats the inferred association.
      if(au&&bu&&au!==bu)continue;
      candidates.push({arrival:a,departure:b,minutes:Math.round(gap/minute),basis:sameSchedule?'Same schedule':'Matching Gemini units · inferred',units:au&&au===bu?au.split('|'):[]});
    }
  }
  return candidates.filter(pair=>candidates.filter(p=>p.arrival.key===pair.arrival.key).length===1&&candidates.filter(p=>p.departure.key===pair.departure.key).length===1);
}
function turnbackLinks(services){
  const pairs=[];
  for(const a of services){
    if(!a.ecs||a.cancelled||a.futureCancellation||a.routeDiverted||!Number.isFinite(a.bookedMs)||Number.isFinite(a.bookedArrivalMs))continue;
    const calls=a.operationalRoute?.callingPoints||[];
    if(!calls.some(p=>p.tiploc==='MNCRVRS'))continue;
    const returns=calls.filter(p=>p.tiploc==='MNCRVIC');
    if(returns.length!==1)continue;
    const time=Date.parse(returns[0].st);
    const matches=services.filter(b=>b.key!==a.key&&!b.cancelled&&!b.futureCancellation&&!b.routeDiverted&&b.uid===a.uid&&b.serviceDate===a.serviceDate&&Number.isFinite(b.bookedArrivalMs)&&!Number.isFinite(b.bookedMs)&&Math.floor(b.bookedArrivalMs/minute)===Math.floor(time/minute));
    if(matches.length===1)pairs.push({departure:a,arrival:matches[0],basis:'Same schedule · West Turnback return'});
  }
  return pairs.filter(pair=>pairs.filter(p=>p.departure.key===pair.departure.key).length===1&&pairs.filter(p=>p.arrival.key===pair.arrival.key).length===1);
}
function baselineKey(s,view){return JSON.stringify([s.uid||s.rid||s.serviceId||s.key,s.serviceDate||'',s.bookedArrivalMs??null,s.bookedMs??null,view==='arrivals'?'arrival':'departure']);}
function shortFormation(service,reference,actual,now=Date.now()){
  if(service.ecs||service.cancelled||service.futureCancellation||!reference||!fresh(reference.at,48*60*minute,now)||!Number.isInteger(reference.count)||reference.count<1||reference.count>30||!Number.isInteger(actual)||actual<1||actual>=reference.count)return null;
  return {booked:reference.count,actual,missing:reference.count-actual};
}
root.MCVOperations={health,turnaroundLinks,turnbackLinks,baselineKey,shortFormation,fresh};
})(typeof window!=='undefined'?window:globalThis);
