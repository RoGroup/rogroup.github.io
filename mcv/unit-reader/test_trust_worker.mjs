import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./worker.mjs', import.meta.url), 'utf8');
const worker = await import('data:text/javascript;base64,' + Buffer.from(source + '\nexport {validateTrustSnapshot, mergeTrustServices,validateBookedPatterns,mergeBookedPatterns};').toString('base64'));
const now = Date.now();
const stamp = new Date(now).toISOString();
const service = {
  serviceID:'trust:2026-10-22:313D32M422', uid:'P28858', trainid:'3D32', sdd:'2026-10-22',
  sta:'2026-10-22T04:37:00+01:00', std:'2026-10-22T04:48:00+01:00',
  ata:'2026-10-22T04:35:00+01:00', atd:null, platform:'4',
  operator:'Northern', operatorCode:'NT', category:'EE', serviceType:'train', isPassengerService:false,
  mcvSource:'TRUST', origin:[{locationName:'NWTNHDD', tiploc:'NWTNHDD', crs:'NWTNHDD'}],
  destination:[{locationName:'CHESTER', tiploc:'CHST', crs:'CTR'}],
  previousCallingPoints:[], subsequentCallingPoints:[],
  trust:{platformSource:'reported', lastReportAt:stamp, departureDirection:'West', directionPoint:'MNCRDST', trainId:'313D32M422'}
};
const snapshot = {version:1, available:true, updatedAt:stamp, feedAt:stamp, scheduleAt:stamp, services:[service]};
const cleaned = worker.validateTrustSnapshot({...snapshot, services:[{...service, isCancelled:true, unitAllocation:{unsafe:true}}]});
assert.equal(cleaned.services[0].isCancelled, undefined);
assert.equal(cleaned.services[0].unitAllocation, undefined);
assert.throws(()=>worker.validateTrustSnapshot({...snapshot, services:[{...service,isPassengerService:true}]}));
assert.throws(()=>worker.validateTrustSnapshot({...snapshot, services:[{...service,std:'not a time'}]}));
for (const existing of [{uid:'P28858',sdd:service.sdd}, {uid:'P99999',trainid:'3D32',sdd:service.sdd}, {trainid:'3D32'}]) {
  const board={trainServices:[existing]};
  worker.mergeTrustServices(board,{trust:cleaned,readerRunning:false});
  assert.equal(board.trainServices.length,1,'Darwin must win identity conflicts');
}
const added={trainServices:[]};
worker.mergeTrustServices(added,{trust:cleaned,readerRunning:false});
assert.equal(added.trainServices.length,1,'TRUST is independent of Gemini reader status');
assert.ok(Date.parse(added.trainServices[0].trust.expiresAt)>now);
const stale={trainServices:[]};
worker.mergeTrustServices(stale,{trust:{...cleaned,feedAt:new Date(now-301000).toISOString()}});
assert.equal(stale.trainServices.length,0);
const duplicate={trainServices:[]};
worker.mergeTrustServices(duplicate,{trust:{...cleaned,services:[service,service]}});
assert.equal(duplicate.trainServices.length,1);

// Exercise the public route with a configured TRUST-containing KV snapshot.
// It must return Darwin data without touching the staff-only KV enrichment.
globalThis.caches={default:{match:async()=>null,put:async()=>{}}};
globalThis.fetch=async()=>Response.json({generatedAt:stamp,trainServices:[{...service,serviceID:'darwin',uid:'P11111',trainid:'2N01',category:'OO',isPassengerService:true,mcvSource:undefined,trust:undefined}]});
let kvReads=0;
const publicResponse=await worker.default.fetch(new Request('https://example.test/departures'),{
  RDM_API_KEY:'test',RDM_STAFF_API_KEY:'test',UNIT_ALLOCATIONS:{get:async()=>{kvReads++;return {trust:cleaned};}}
},{waitUntil:()=>{}});
assert.equal(publicResponse.status,200);
assert.equal(kvReads,0);
assert.ok((await publicResponse.json()).trainServices.every(row=>row.serviceID!=='trust:2026-10-22:313D32M422'));

// Check the actual shared adapter preserves absolute dates and does not invent
// a forecast or an on-time status for an activated TRUST working.
const context={Date,Intl,console,setTimeout,clearTimeout,setInterval,clearInterval};
vm.createContext(context);
vm.runInContext(readFileSync(new URL('../mcv-data.js', import.meta.url),'utf8'),context);
let legacy=context.MCVData.toLegacyBoard({generatedAt:stamp,trainServices:added.trainServices}).results[0];
assert.equal(legacy.actual_arrives,'2026-10-22T03:35:00.000Z');
assert.equal(legacy.departs,'2026-10-22T03:48:00.000Z');
assert.equal(legacy.status_text,'Arrived 04:35');
assert.equal(legacy.feed_source,'TRUST');
assert.equal(legacy.expected_departs,null);
legacy=context.MCVData.toLegacyBoard({generatedAt:stamp,trainServices:[{...service,ata:null}]}).results[0];
assert.equal(legacy.status_text,'Activated · no forecast');
assert.equal(legacy.origin.crs,'NWTNHDD');
// Supplemental reports require exact identity, a unique Darwin row and booked
// minutes at MCV. They must not replace Darwin's status, forecast or platform.
const report={uid:'P11111',trainid:'2N01',sdd:'2026-10-22',sta:service.sta,std:service.std,
  ata:service.ata,atd:null,lastReportAt:service.ata,reportedPlatform:'4'};
const reports=worker.validateTrustSnapshot({...snapshot,services:[],movements:[{...report,etd:'unsafe',isCancelled:true}]});
assert.equal(reports.movements[0].etd,undefined);
const darwin={uid:report.uid,trainid:report.trainid,sdd:report.sdd,sta:report.sta,std:report.std,
  serviceID:'darwin-passenger',platform:'5',etd:'Delayed',isCancelled:true};
const enhanced={trainServices:[{...darwin}]};
worker.mergeTrustServices(enhanced,{trust:reports});
assert.equal(enhanced._mcv.trustMovementsMatched,1);
assert.equal(enhanced.trainServices.length,1);
assert.equal(enhanced.trainServices[0].platform,'5');
assert.equal(enhanced.trainServices[0].etd,'Delayed');
assert.equal(enhanced.trainServices[0].isCancelled,true);
assert.equal(enhanced.trainServices[0].ata,undefined);
assert.equal(enhanced.trainServices[0].trustMovement.reportedPlatform,'4');
for(const changes of [{uid:'P22222'},{sdd:'2026-10-23'},{trainid:'2N02'},{std:'2026-10-22T04:49:00+01:00'},{std:null,sta:null}]){
  const board={trainServices:[{...darwin,...changes}]};
  worker.mergeTrustServices(board,{trust:reports});
  assert.equal(board.trainServices[0].trustMovement,undefined);
}
for(const [rows,movements] of [[[darwin,darwin],[report]],[[darwin],[report,report]]]){
  const board={trainServices:rows.map(row=>({...row}))};
  worker.mergeTrustServices(board,{trust:{...reports,movements}});
  assert.ok(board.trainServices.every(row=>!row.trustMovement),'Ambiguous identities must be withheld');
}
const clockOnly={trainServices:[{...darwin,sta:'04:37',std:'04:48'}]};
worker.mergeTrustServices(clockOnly,{trust:reports});
assert.equal(clockOnly._mcv.trustMovementsMatched,1);
const londonWall={trainServices:[{...darwin,sta:'2026-10-22T04:37:00',std:'2026-10-22T04:48:00'}]};
worker.mergeTrustServices(londonWall,{trust:reports});
assert.equal(londonWall._mcv.trustMovementsMatched,1,'Darwin offset-free timestamps are London wall clocks in BST');
const wrongDate={trainServices:[{...darwin,sta:'2026-10-23T04:37:00',std:'2026-10-23T04:48:00'}]};
worker.mergeTrustServices(wrongDate,{trust:reports});
assert.equal(wrongDate._mcv.trustMovementsMatched,0,'Wall-clock matching must preserve the calendar date');
worker.mergeTrustServices(enhanced,{trust:{...reports,feedAt:new Date(now-301000).toISOString()}});
assert.equal(enhanced.trainServices[0].trustMovement,undefined,'Stale reports must disappear');
for(const changes of [{reportedPlatform:'<script>'},{ata:null},{lastReportAt:stamp},{atd:service.ata,std:null}]){
  assert.throws(()=>worker.validateTrustSnapshot({...snapshot,movements:[{...report,...changes}]}));
}
const movement={...report,expiresAt:new Date(now+60000).toISOString()};
const converted=context.MCVData.toLegacyBoard({generatedAt:stamp,trainServices:[{...darwin,trustMovement:movement}]}).results[0];
assert.equal(converted.trust_movement.reportedPlatform,'4');
assert.match(context.MCVData.trustMovementText(movement),/arrived 04:35.*reported P4/);
assert.equal(context.MCVData.trustMovementText({...movement,expiresAt:new Date(now-1).toISOString()}),'');
const pattern={uid:report.uid,trainid:report.trainid,sdd:report.sdd,sta:report.sta,std:report.std,
  callingPoints:[{locationName:'CHESTER',crs:'CTR',tiploc:'CHST',st:'2026-10-22T05:46:00+01:00'}]};
const routeSnapshot=worker.validateTrustSnapshot({...snapshot,services:[],routes:[pattern]});
const missingPattern={...darwin,isCancelled:false,destination:[{crs:'CTR'}]};
const routeBoard={trainServices:[{...missingPattern}]};
worker.mergeTrustServices(routeBoard,{trust:routeSnapshot});
assert.equal(routeBoard._mcv.trustCallingPatternsMatched,1);
assert.equal(routeBoard.trainServices[0].subsequentCallingPoints,undefined,'Keep original Darwin data separate');
for(const changes of [{isCancelled:true},{futureCancellation:true},{diversion:{reason:'altered'}},{destination:[{crs:'LDS'}]},
  {subsequentCallingPoints:[{callingPoint:[{crs:'CTR',isCancelled:true}]}]},
  {subsequentLocations:[{crs:'CTR',isPass:true}]},{std:null},{uid:'P22222'}]){
  const board={trainServices:[{...missingPattern,...changes}]};
  worker.mergeTrustServices(board,{trust:routeSnapshot});
  assert.equal(board.trainServices[0].trustCallingPoints,undefined,'Darwin patterns/alterations and exact matching must win');
}
for(const [rows,routes] of [[[missingPattern,missingPattern],[pattern]],[[missingPattern],[pattern,pattern]]]){
  const board={trainServices:rows.map(row=>({...row}))};
  worker.mergeTrustServices(board,{trust:{...routeSnapshot,routes}});
  assert.ok(board.trainServices.every(row=>!row.trustCallingPoints));
}
const timetableLegacy=context.MCVData.toLegacyBoard({generatedAt:stamp,trainServices:routeBoard.trainServices}).results[0];
assert.equal(timetableLegacy.calling_points_source,'TRUST timetable');
assert.equal(timetableLegacy.calling_points[0].station.crs,'CTR');
assert.equal(timetableLegacy.calling_points[0].expected_arrives,null,'Booked-only stops must not invent forecasts');
assert.equal(timetableLegacy.calling_points[0].arrives,'2026-10-22T04:46:00.000Z');
const overnightFallback={...routeBoard.trainServices[0],trustCallingPoints:{...routeBoard.trainServices[0].trustCallingPoints,callingPoints:[{...pattern.callingPoints[0],st:'2026-10-23T00:06:00+01:00'}]}};
assert.equal(context.MCVData.toLegacyBoard({generatedAt:stamp,trainServices:[overnightFallback]}).results[0].calling_points[0].arrives,'2026-10-22T23:06:00.000Z','Preserve the absolute date of calls after midnight');
const supplied=context.MCVData.toLegacyBoard({generatedAt:stamp,trainServices:[{...routeBoard.trainServices[0],subsequentCallingPoints:[{callingPoint:[{crs:'LDS',locationName:'LEEDS',st:'06:00'}]}]}]}).results[0];
assert.equal(supplied.calling_points_source,'Darwin');
assert.equal(supplied.calling_points[0].station.crs,'LDS');
const expiredRoute={...routeBoard.trainServices[0],trustCallingPoints:{...routeBoard.trainServices[0].trustCallingPoints,expiresAt:new Date(now-1).toISOString()}};
assert.equal(context.MCVData.toLegacyBoard({generatedAt:stamp,trainServices:[expiredRoute]}).results[0].calling_points.length,0);
worker.mergeTrustServices(routeBoard,{trust:{...routeSnapshot,feedAt:new Date(now-301000).toISOString()}});
assert.equal(routeBoard.trainServices[0].trustCallingPoints,undefined);
assert.throws(()=>worker.validateTrustSnapshot({...snapshot,routes:[{...pattern,callingPoints:[{...pattern.callingPoints[0],st:null}]}]}));
const historyEvent=(kind,at,tiploc='MNCRVIC',timeBasis='actual')=>({kind,at,tiploc,timeBasis,crs:tiploc==='MNCRVIC'?'MCV':'',locationName:tiploc==='MNCRVIC'?'Manchester Victoria':'Deal Street',platform:'4',delaySeconds:timeBasis==='actual'?0:null});
const historyRow={uid:darwin.uid,trainid:darwin.trainid,sdd:darwin.sdd,sta:darwin.sta,std:darwin.std,reconciliationRequired:false,
  dwellSeconds:99999,lastReport:{unsafe:true},events:[
    historyEvent('activation','2026-10-22T03:30:00Z','','received'),
    historyEvent('arrival','2026-10-22T03:35:00Z'),
    historyEvent('departure','2026-10-22T03:48:00Z'),
    historyEvent('pass','2026-10-22T03:49:30Z','MNCRDST'),
    historyEvent('cancellation','2026-10-22T03:50:00Z','','received'),
    historyEvent('reinstatement','2026-10-22T03:51:00Z','','received')
  ]};
const historySnapshot=worker.validateTrustSnapshot({...snapshot,services:[],histories:[historyRow]});
assert.equal(historySnapshot.histories[0].dwellSeconds,undefined,'Dwell must be calculated from evidence');
const historyBoard={trainServices:[{...darwin}]};
worker.mergeTrustServices(historyBoard,{trust:historySnapshot});
const attached=historyBoard.trainServices[0].trustHistory;
assert.equal(historyBoard._mcv.trustHistoriesMatched,1);
assert.equal(attached.lastReport.tiploc,'MNCRDST');
assert.equal(attached.dwellSeconds,13*60);
assert.equal(historyBoard.trainServices[0].isCancelled,true,'History must not override Darwin cancellation');
assert.equal(historyBoard.trainServices[0].etd,'Delayed');
assert.equal(historyBoard.trainServices[0].platform,'5');
for(const changes of [{uid:'P99999'},{trainid:'2N02'},{sdd:'2026-10-23'},{std:'2026-10-22T04:49:00'}]){
  const board={trainServices:[{...darwin,...changes}]};
  worker.mergeTrustServices(board,{trust:historySnapshot});
  assert.equal(board.trainServices[0].trustHistory,undefined);
}
for(const [rows,histories] of [[[darwin,darwin],[historyRow]],[[darwin],[historyRow,historyRow]]]){
  const board={trainServices:rows.map(row=>({...row}))};
  worker.mergeTrustServices(board,{trust:{...historySnapshot,histories}});
  assert.ok(board.trainServices.every(row=>!row.trustHistory));
}
for(const events of [historyRow.events.filter(event=>event.kind!=='departure'),[historyEvent('arrival','2026-10-22T03:48:00Z'),historyEvent('departure','2026-10-22T03:35:00Z')]]){
  const board={trainServices:[{...darwin}]};
  worker.mergeTrustServices(board,{trust:{...historySnapshot,histories:[{...historyRow,events}]}});
  assert.equal(board.trainServices[0].trustHistory.dwellSeconds,null,'Incomplete or reversed reports must not produce a dwell time');
}
const ecsHistory={...historyRow,uid:service.uid,trainid:service.trainid};
const ecsBoard={trainServices:[]};
worker.mergeTrustServices(ecsBoard,{trust:{...historySnapshot,services:[service],histories:[ecsHistory]}});
assert.ok(ecsBoard.trainServices[0].trustHistory,'Standalone TRUST ECS can also show journey reports');
for(const changes of [{kind:'unsafe'},{timeBasis:'forecast'},{delaySeconds:0.5},{at:new Date(now+120000).toISOString()}]){
  assert.throws(()=>worker.validateTrustSnapshot({...snapshot,histories:[{...historyRow,events:[{...historyRow.events[1],...changes}]}]}));
}
const convertedHistory=context.MCVData.toLegacyBoard({generatedAt:stamp,trainServices:historyBoard.trainServices}).results[0];
assert.equal(convertedHistory.trust_history.dwellSeconds,780);
assert.equal(context.MCVData.trustHistoryFresh(attached),true);
assert.equal(context.MCVData.trustHistoryFresh({...attached,expiresAt:new Date(now-1).toISOString()}),false);
context.escapeHTML=context.MCVData.escapeHTML;
context.station=(name,crs)=>context.MCVData.displayStationName(name,crs);
context.relativeAge=()=> '1m';
const staffHTML=readFileSync(new URL('../staff.html',import.meta.url),'utf8');
vm.runInContext(staffHTML.slice(staffHTML.indexOf('function trustDuration('),staffHTML.indexOf('function renderDetails(')),context);
const historyHTML=context.renderTrustHistory({trustHistory:attached});
for(const label of ['Last movement report','Deal Street','Completed dwell at Victoria','13m','Cancellation reported','Reinstatement reported','Received '])assert.ok(historyHTML.includes(label),label);
assert.equal(context.renderTrustHistory({trustHistory:{...attached,expiresAt:new Date(now-1).toISOString()}}),'');
const unsafe={...attached,lastReport:{...attached.lastReport,locationName:'<script>alert(1)</script>'}};
assert.ok(!context.renderTrustHistory({trustHistory:unsafe}).includes('<script>'));
worker.mergeTrustServices(historyBoard,{trust:{...historySnapshot,feedAt:new Date(now-301000).toISOString()}});
assert.equal(historyBoard.trainServices[0].trustHistory,undefined);
console.log('TRUST ECS, movement reports, calling patterns and histories: identity, dwell, lifecycle, expiry, public isolation and UI checks passed');

// Daily timetable fallback is independent of TRUST capture and Gemini status.
const timetable=worker.validateBookedPatterns({version:1,available:true,updatedAt:stamp,scheduleAt:stamp,routes:[pattern]});
const daily={trainServices:[{...missingPattern}]};
worker.mergeTrustServices(daily,{trust:{version:1,available:false,services:[]}});
worker.mergeBookedPatterns(daily,{readerRunning:false,timetable});
assert.equal(daily._mcv.trustAvailable,false);
assert.equal(daily._mcv.timetableCallingPatternsMatched,1);
assert.equal(daily.trainServices[0].trustCallingPoints.source,'Booked calling pattern');
assert.equal(daily.trainServices[0].etd,missingPattern.etd);
assert.equal(daily.trainServices[0].platform,missingPattern.platform);
assert.equal(daily.trainServices[0].ata,undefined);
const dailyLegacy=context.MCVData.toLegacyBoard({generatedAt:stamp,trainServices:daily.trainServices}).results[0];
assert.equal(dailyLegacy.calling_points_source,'Booked calling pattern');
assert.equal(dailyLegacy.calling_points[0].expected_departs,null);
for(const change of [{isCancelled:true},{filterLocationCancelled:true},{futureCancellation:true},{diversion:true},{affectedByDiversion:true},
  {isPassengerService:false},{uid:'P00001'},{std:'2026-10-22T04:49:00+01:00'},{sdd:'2026-10-23'},
  {destination:[{crs:'LDS'}]},{destination:[{crs:'CTR'},{crs:'LDS'}]},
  {subsequentLocations:[{crs:'CTR'}]},{subsequentCallingPoints:[{callingPoint:[{crs:'CTR',isCancelled:true}]}]},
  {trustHistory:{reconciliationRequired:true}},{trustHistory:{events:[{kind:'cancellation'}]}}]){
  const board={trainServices:[{...missingPattern,...change}]};worker.mergeBookedPatterns(board,{timetable});
  assert.equal(board.trainServices[0].trustCallingPoints,undefined,JSON.stringify(change));
}
for(const changes of [{updatedAt:new Date(now-361000).toISOString()},{scheduleAt:new Date(now-37*3600000).toISOString()},{updatedAt:new Date(now+60000).toISOString()}]){
  const board={trainServices:[{...missingPattern}]};worker.mergeBookedPatterns(board,{timetable:{...timetable,...changes}});
  assert.equal(board._mcv.timetableAvailable,false);assert.equal(board.trainServices[0].trustCallingPoints,undefined);
}
for(const [rows,routes] of [[[missingPattern,missingPattern],[pattern]],[[missingPattern],[pattern,pattern]]]){
  const board={trainServices:rows.map(row=>({...row}))};worker.mergeBookedPatterns(board,{timetable:{...timetable,routes}});
  assert.ok(board.trainServices.every(row=>!row.trustCallingPoints));
}
assert.throws(()=>worker.validateBookedPatterns({...timetable,routes:[{...pattern,uid:'unsafe'}]}));
const replaced={trainServices:[{...missingPattern,subsequentCallingPoints:[{callingPoint:[{locationName:'Live Chester',crs:'CTR',st:pattern.callingPoints[0].st}]}]}]};
worker.mergeTrustServices(replaced,{});worker.mergeBookedPatterns(replaced,{timetable});
assert.equal(replaced.trainServices[0].trustCallingPoints,undefined,'Darwin live pattern replaces the fallback');
const replacedLegacy=context.MCVData.toLegacyBoard({generatedAt:stamp,trainServices:replaced.trainServices}).results[0];
assert.equal(replacedLegacy.calling_points_source,'Darwin');
const expiredDaily=context.MCVData.toLegacyBoard({generatedAt:stamp,trainServices:[{...missingPattern,trustCallingPoints:{...daily.trainServices[0].trustCallingPoints,expiresAt:new Date(now-1).toISOString()}}]}).results[0];
assert.equal(expiredDaily.calling_points_source,'Darwin');
assert.equal(expiredDaily.calling_points.length,0);
console.log('Independent booked patterns: daily schedule freshness, exact identity, public stops, live replacement, alteration guards and UI expiry passed');

const check={uid:missingPattern.uid,trainid:missingPattern.trainid,sdd:missingPattern.sdd,sta:missingPattern.sta||'',std:missingPattern.std||'',reason:'booked-time-mismatch'};
const checked=worker.validateBookedPatterns({...timetable,routes:[],checks:[check]});
const why={trainServices:[{...missingPattern}]};worker.mergeBookedPatterns(why,{timetable:checked});
assert.equal(why.trainServices[0].bookedPatternStatus.reason,'booked-time-mismatch');
const whyLegacy=context.MCVData.toLegacyBoard({generatedAt:stamp,trainServices:why.trainServices}).results[0];
assert.equal(whyLegacy.booked_pattern_status.reason,'booked-time-mismatch');
assert.match(context.MCVData.bookedPatternExplanation(whyLegacy.booked_pattern_status),/public or working/);
assert.throws(()=>worker.validateBookedPatterns({...checked,checks:[{...check,reason:'raw-error-unsafe'}]}));
const wrongCheck={trainServices:[{...missingPattern,std:'2026-10-22T04:49:00'}]};worker.mergeBookedPatterns(wrongCheck,{timetable:checked});
assert.equal(wrongCheck.trainServices[0].bookedPatternStatus,undefined);
worker.mergeTrustServices(why,{});assert.equal(why.trainServices[0].bookedPatternStatus,undefined,'Old explanations are cleared before fresh joins');
console.log('Booked-pattern explanations: exact identity/time, reason validation, UI conversion and freshness clearing passed');

// VSTP's space-prefixed five-digit UID is canonicalized by the server; Darwin
// may retain the leading space. Match exact UID/date/headcode and booked times.
const vstpService={...service,uid:'43876'};
const vstpSnapshot=worker.validateTrustSnapshot({...snapshot,services:[vstpService]});
assert.equal(vstpSnapshot.services[0].uid,'43876');
assert.throws(()=>worker.validateTrustSnapshot({...snapshot,services:[{...service,uid:'1234'}]}));
assert.throws(()=>worker.validateTrustSnapshot({...snapshot,services:[{...service,uid:'<43876>'}]}));
const vstpRoute={uid:'43876',trainid:service.trainid,sdd:service.sdd,sta:service.sta,std:service.std,
 callingPoints:[{crs:'CTR',tiploc:'CHST',locationName:'Chester',st:service.std}]};
const vstpBooked=worker.validateBookedPatterns({version:1,available:true,updatedAt:stamp,scheduleAt:stamp,routes:[vstpRoute],checks:[]});
const vstpBoard={trainServices:[{uid:' 43876',trainid:service.trainid,sdd:service.sdd,sta:service.sta,std:service.std,destination:[{crs:'CTR'}]}]};
worker.mergeBookedPatterns(vstpBoard,{timetable:vstpBooked});
assert.equal(vstpBoard.trainServices[0].trustCallingPoints.callingPoints[0].crs,'CTR');
console.log('VSTP numeric UID validation and exact booked-pattern join passed');

assert.throws(()=>worker.validateTrustSnapshot({...snapshot,services:[{...service,uid:43876}]}));
