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
console.log('TRUST Worker validation, stale-data rejection, Darwin deduplication, public isolation and shared adapter checks passed');
