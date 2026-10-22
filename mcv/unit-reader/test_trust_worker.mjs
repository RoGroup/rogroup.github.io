import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('./worker.mjs', import.meta.url), 'utf8');
const worker = await import('data:text/javascript;base64,' + Buffer.from(source + '\nexport {validateTrustSnapshot, mergeTrustServices};').toString('base64'));
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
console.log('TRUST ECS, movement reports and booked calling patterns: matching, precedence, expiry, public isolation and adapter checks passed');

