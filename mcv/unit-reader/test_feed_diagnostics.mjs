import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const context={Date,Intl};vm.createContext(context);
vm.runInContext(readFileSync(new URL('../mcv-diagnostics.js',import.meta.url),'utf8'),context);
const now=Date.parse('2026-10-22T14:50:00Z');
const iso=offset=>new Date(now+offset).toISOString();
const base={receivedAt:now-1000,generatedAt:iso(-10000),inspectedAt:now-2000,
  meta:{unitReaderRunning:true,unitAllocationsAvailable:true,unitSnapshotAt:iso(-60000),trustAvailable:true,trustSnapshotAt:iso(-60000),trustServicesAdded:0,trustMovementsMatched:1,trustCallingPatternsMatched:2,trustHistoriesMatched:3},
  snapshot:{updatedAt:iso(-60000),available:true,readerRunning:true,allocationRecords:5,allocatedRecords:0,trust:{updatedAt:iso(-60000),feedAt:iso(-65000),scheduleAt:iso(-3600000)}}};
const describe=overrides=>context.MCVFeedDiagnostics.describe({...base,...overrides},now);
const row=(rows,label)=>rows.find(item=>item.label===label);
let rows=describe({});
assert.equal(row(rows,'Board updates').warning,false);
assert.equal(row(rows,'Last TRUST capture').warning,false);
assert.equal(row(rows,'Timetable extract').warning,false);
assert.match(row(rows,'Joined to this board').value,/ECS 0/,'Zero matched ECS is a valid count');
assert.equal(row(rows,'Joined to this board').warning,false);
assert.match(row(rows,'Inspected snapshot coverage').value,/0 of 5/);
rows=context.MCVFeedDiagnostics.describe({},now);
assert.match(row(rows,'Board updates').value,/Waiting/);
assert.equal(row(rows,'Allocation availability').warning,true);
assert.equal(row(rows,'Timetable extract').value,'Not supplied');
rows=describe({boardError:true});assert.equal(row(rows,'Board updates').warning,true);
rows=describe({receivedAt:now-100000});assert.match(row(rows,'Board updates').value,/stale/);
rows=describe({snapshotError:true});assert.match(row(rows,'Snapshot inspection').value,/last inspected/);
rows=describe({meta:{...base.meta,unitReaderRunning:false}});assert.match(row(rows,'Allocation availability').value,/offline/);
rows=describe({meta:{...base.meta,unitSnapshotAt:iso(-361000)}});assert.match(row(rows,'Allocation availability').value,/6 minutes/);
rows=describe({snapshot:{...base.snapshot,trust:{...base.snapshot.trust,feedAt:iso(-301000)}}});assert.match(row(rows,'Board TRUST availability').value,/capture is stale/);
rows=describe({snapshot:{...base.snapshot,trust:{...base.snapshot.trust,scheduleAt:iso(-37*3600000)}}});assert.match(row(rows,'Board TRUST availability').value,/Timetable extract is stale/);
rows=describe({meta:{...base.meta,trustSnapshotAt:iso(120000)}});assert.equal(row(rows,'TRUST snapshot').warning,true);
const service={uid:'P12345',headcode:'2N01',serviceDate:'2026-10-22',stops:[],source:'Darwin'};
rows=describe({service});
assert.equal(row(rows,'Identity').warning,false);
assert.match(row(rows,'Calling points').value,/upstream reason not supplied/);
assert.match(row(rows,'Journey history').value,/upstream reason not supplied/);
rows=describe({service:{...service,uid:''}});assert.match(row(rows,'Calling points').value,/identifiers/);
for(const change of [{cancelled:true},{terminatesEarly:true},{routeDiverted:true},{stopsRemoved:true},{futureCancellation:true}]){
  rows=describe({service:{...service,...change}});assert.match(row(rows,'Calling points').value,/withheld/);
}
rows=describe({service:{...service,stops:[{name:'Leeds'}],callingPointsReturned:0}});assert.match(row(rows,'Calling points').value,/Destination-only/);
rows=describe({service:{...service,stops:[{name:'Leeds'}],callingPointsSource:'TRUST timetable'}});assert.match(row(rows,'Calling points').value,/Booked timetable fallback/);
rows=describe({service:{...service,trustHistory:{events:[{}],expiresAt:iso(20000)}}});assert.match(row(rows,'Journey history').value,/Matched history/);
rows=describe({service:{...service,trustHistory:{events:[{}],expiresAt:iso(-1)}}});assert.equal(row(rows,'Journey history').warning,true);
assert.ok(rows.every(item=>typeof item.warning==='boolean'));

// Exercise the panel integration: closed panels must not poll, concurrent
// requests coalesce, successful inspections retain metadata only, and retries
// stay bounded while the panel is open.
const html=readFileSync(new URL('../staff.html',import.meta.url),'utf8');
const nodes=new Map();
context.$=id=>{if(!nodes.has(id))nodes.set(id,{addEventListener(){}});return nodes.get(id)};
context.state={diagnosticsOpen:false,diagnosticsBusy:false,diagnosticsAttemptAt:0,diagnosticsInspectedAt:0,diagnosticsError:false,lastGood:0,feedGeneratedAt:0};
context.visibleServices=()=>[];
context.escapeHTML=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
context.updateDisplayHTML=()=>{};
let requests=0,fail=false;
context.MCVSite={fetch:async()=>{requests++;if(fail)throw Error('unavailable');return {ok:true,json:async()=>({version:1,available:true,updatedAt:new Date().toISOString(),readerRunning:true,services:[{status:'allocated',xml:'must not be retained'}],trust:{available:true,feedAt:new Date().toISOString(),scheduleAt:new Date().toISOString(),histories:[{raw:'must not be retained'}]}})}}};
vm.runInContext(html.slice(html.indexOf('function renderFeedDiagnostics('),html.indexOf('function render(){')),context);
await context.refreshFeedDiagnostics(true);assert.equal(requests,0);
context.state.diagnosticsOpen=true;
await Promise.all([context.refreshFeedDiagnostics(),context.refreshFeedDiagnostics()]);assert.equal(requests,1);
assert.equal(context.state.diagnosticsSnapshot.allocationRecords,1);
assert.equal(context.state.diagnosticsSnapshot.services,undefined);
assert.equal(context.state.diagnosticsSnapshot.trust.histories,undefined);
await context.refreshFeedDiagnostics();assert.equal(requests,1);
const retained=context.state.diagnosticsSnapshot;
fail=true;await context.refreshFeedDiagnostics(true);assert.equal(requests,2);
assert.equal(context.state.diagnosticsError,true);
assert.equal(context.state.diagnosticsSnapshot,retained);
await context.refreshFeedDiagnostics();assert.equal(requests,2);
context.state.diagnosticsOpen=false;await context.refreshFeedDiagnostics(true);assert.equal(requests,2);
console.log('Feed diagnostics: freshness, missing data, withheld patterns, history expiry, bounded polling and failed-inspection checks passed');
