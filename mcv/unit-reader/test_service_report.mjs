import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const context={Date,Intl};vm.createContext(context);
vm.runInContext(readFileSync(new URL('../mcv-service-report.js',import.meta.url),'utf8'),context);
vm.runInContext(readFileSync(new URL('../mcv-recent.js',import.meta.url),'utf8'),context);
const report=context.MCVServiceReport;
const row={uid:'P12345',headcode:'2N01',date:'2026-10-22',source:'Darwin',origin:'Leeds',destination:'Liverpool',platform:'4',cancelled:false,
  sta:'2026-10-22T14:55:00',std:'2026-10-22T15:00:00+01:00',ata:'2026-10-22T13:56:00Z',atd:'2026-10-22T15:03:30',
  eta:'2026-10-22T16:00:00',etd:'2026-10-22T17:00:00',lastSeen:'2026-10-22T14:05:00Z',
  allocation:{status:'allocated',capturedAt:'2026-10-22T13:30:00Z',arrivalUnits:['150123'],departureUnits:['150456']}};
let t=report.timingSummary(row);
assert.equal(t.arrival.seconds,60);assert.equal(t.departure.seconds,210);assert.equal(t.dwell.seconds,450);assert.equal(t.dwell.source,'Darwin');
assert.match(report.summaryHTML(row),/3m 30s late/);
assert.equal(report.instant('14:55'),null,'A clock alone has no reliable calendar date');
assert.equal(report.instant('On time'),null);
assert.equal(report.instant('2026-10-25T01:30:00'),null,'Repeated autumn hour cannot be inferred');
assert.equal(report.instant('2026-03-29T01:30:00'),null,'Nonexistent spring hour cannot be inferred');
assert.equal(report.instant('2026-10-25T01:30:00+01:00'),Date.parse('2026-10-25T00:30:00Z'));
assert.equal(report.completedDwell('2026-10-22T23:59:00+01:00','2026-10-23T00:02:00+01:00'),180);
assert.equal(report.completedDwell(row.atd,row.ata),null);
assert.equal(report.completedDwell(row.ata,'2026-10-23T15:00:00Z'),null);
assert.equal(report.delay('2026-10-22T14:54:00',row.sta),-60);
assert.equal(report.timingSummary({...row,ata:'',atd:''}).arrival.seconds,null,'Never turn forecasts into actuals');
const event=(kind,at,tiploc='MNCRVIC')=>({kind,at,timeBasis:'actual',tiploc,locationName:'Manchester Victoria',delaySeconds:0});
const trust={events:[event('arrival','2026-10-22T13:57:00Z'),event('departure','2026-10-22T14:04:00Z')],reconciliationRequired:false,capturedAt:row.lastSeen};
t=report.timingSummary({...row,ata:'',atd:'',history:trust});assert.equal(t.arrival.seconds,120);assert.equal(t.departure.seconds,240);assert.equal(t.dwell.seconds,420);assert.equal(t.dwell.source,'TRUST');
t=report.timingSummary({...row,atd:'',history:trust});assert.equal(t.arrival.source,'Darwin');assert.equal(t.departure.source,'TRUST');assert.equal(t.dwell.seconds,420,'Dwell uses a complete source pair, not mixed reports');
for(const history of [{...trust,reconciliationRequired:true},{...trust,events:trust.events.map(e=>({...e,tiploc:'OTHER'}))},{...trust,events:[...trust.events,...trust.events]}]){
  t=report.timingSummary({...row,ata:'',atd:'',history});assert.equal(t.arrival.seconds,null);assert.equal(t.departure.seconds,null);assert.equal(t.dwell.seconds,null);
}
const text=report.serviceReport({...row,history:trust});
for(const content of ['P12345','2N01','150123','150456','Arrival delay: 1m late (Darwin)','Completed dwell: 7m 30s (Darwin)','Arrival forecast at capture','Captured TRUST journey reports','not a confirmed stock diagram'])assert.ok(text.includes(content),content);
assert.ok(!report.unitButtons(['<script>']).includes('<script>'));
assert.match(report.unitButtons(['150123']),/data-unit-history="150123"/);
assert.equal((report.actionsHTML('<script>').match(/<script>/g)||[]).length,0);
// Clipboard success and denial: never lose the report when browser permissions block copying.
let copied='',selected=false;
const status={textContent:''},area={value:'',focus(){},select(){selected=true}},fallback={hidden:true,querySelector:()=>area};
const root={querySelector:selector=>selector==='[data-copy-status]'?status:fallback};
context.navigator={clipboard:{writeText:async text=>{copied=text}}};
await report.copyReport(row,root);assert.ok(copied.includes('150456'));assert.equal(fallback.hidden,true);assert.match(status.textContent,/copied/);
context.navigator={clipboard:{writeText:async()=>{throw Error('Denied')}}};
await report.copyReport(row,root);assert.equal(fallback.hidden,false);assert.ok(selected);assert.equal(area.value,copied);assert.match(status.textContent,/copy the report below/);

// Live details preserve raw dated times, and expired evidence is not exported.
const html=readFileSync(new URL('../staff.html',import.meta.url),'utf8');
context.state={lastGood:Date.parse(row.lastSeen),unitFeedMeta:{trustSnapshotAt:trust.capturedAt}};
context.MCVData={trustHistoryFresh:h=>h?.fresh===true};context.allocationFresh=s=>s.unitAllocation?.fresh===true;
context.allocatedUnits=(s,view)=>s.unitAllocation[view==='arrivals'?'arrivalUnits':'departureUnits'];
vm.runInContext(html.slice(html.indexOf('function serviceReportRecord('),html.indexOf('function unitHistoryLinks(')),context);
const live={...row,reportTimes:{sta:row.sta,std:row.std,ata:row.ata,atd:row.atd},dest:row.destination,serviceDate:row.date,unitAllocation:{...row.allocation,syncedAt:row.allocation.capturedAt,fresh:true},trustHistory:{...trust,fresh:true}};
let record=context.serviceReportRecord(live);assert.equal(record.sta,row.sta);assert.equal(record.allocation.departureUnits[0],'150456');assert.equal(record.history.events.length,2);
record=context.serviceReportRecord({...live,unitAllocation:{...live.unitAllocation,fresh:false},trustHistory:{...trust,fresh:false}});assert.equal(record.history,null);assert.equal(record.allocation,null);
assert.ok(html.includes('MCVServiceReport.summaryHTML(serviceReportRecord(s))'));
assert.ok(html.indexOf('mcv-service-report.js')<html.indexOf('mcv-recent.js'));
console.log('Service reports: actual delays, same-source dwell, DST/midnight, TRUST identity/corrections, unit links, copying/fallback and live freshness passed');
