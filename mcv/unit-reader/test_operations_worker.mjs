import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const context={Date,console};vm.createContext(context);vm.runInContext(fs.readFileSync(new URL('../mcv-operations.js',import.meta.url),'utf8'),context);
const ops=context.MCVOperations,now=Date.now(),stamp=new Date(now).toISOString();
const meta={unitAllocationsAvailable:true,unitReaderRunning:true,unitSnapshotAt:stamp,trustAvailable:true,trustSnapshotAt:stamp,trustFeedAt:stamp,operations:{updatedAt:stamp,scheduleAt:stamp,vstp:{available:true,blocked:false,feedAt:stamp}}};
assert.ok(ops.health(meta,stamp,false,now).every(row=>row.status==='Current'));
assert.equal(ops.health(meta,stamp,true,now)[0].status,'Stale / unavailable');
assert.ok(ops.health(meta,stamp,false,now+37*3600000).every(row=>row.status!=='Current'));
assert.equal(ops.health({...meta,operations:{...meta.operations,vstp:{...meta.operations.vstp,blocked:true}}},stamp,false,now)[3].status,'Stale / unavailable');
const a={key:'a',uid:'A12345',serviceDate:'2026-10-26',bookedArrivalMs:now,bookedMs:NaN,arrivalUnits:['150123'],cancelled:false};
const b={key:'b',uid:'B12345',serviceDate:'2026-10-26',bookedArrivalMs:NaN,bookedMs:now+20*60000,departureUnits:['150123'],cancelled:false};
assert.equal(ops.turnaroundLinks([a,b],now).length,1);
assert.match(ops.turnaroundLinks([a,b],now)[0].basis,/inferred/);
assert.equal(ops.turnaroundLinks([a,b,{...b,key:'c'}],now).length,0,'Ambiguous onward allocation withheld');
assert.equal(ops.turnaroundLinks([a,{...b,departureUnits:['150124']}],now).length,0);
assert.equal(ops.turnaroundLinks([a,{...b,cancelled:true}],now).length,0);
assert.equal(ops.turnaroundLinks([a,{...b,departureUnits:['150123','150124']}],now).length,0,'Partial set does not prove continuity');
assert.equal(ops.turnaroundLinks([a,{...b,bookedMs:now-60000}],now).length,0);
const outbound={...b,uid:'N03290',ecs:true,operationalRoute:{callingPoints:[{tiploc:'MNCRVRS',st:stamp},{tiploc:'MNCRVIC',st:new Date(now+40*60000).toISOString()}]}};
const back={...a,key:'back',uid:'N03290',bookedArrivalMs:now+40*60000};
assert.equal(ops.turnbackLinks([outbound,back]).length,1);
assert.equal(ops.turnbackLinks([outbound,back,{...back,key:'dup'}]).length,0);
assert.equal(ops.turnbackLinks([{...outbound,operationalRoute:null},back]).length,0);
const source=fs.readFileSync(new URL('./worker.mjs',import.meta.url),'utf8');
const worker=await import('data:text/javascript;base64,'+Buffer.from(source+'\nexport {validateOperations,enrichUnits};').toString('base64'));
const summary={version:1,updatedAt:stamp,scheduleAt:stamp,vstp:{configured:true,available:true,blocked:false,feedAt:stamp},changes:[{uid:'43876',headcode:'2N01',startDate:'2026-10-26',endDate:'2026-10-26',operatingDates:['2026-10-26'],at:stamp,action:'Delete',status:'withdrawn',origin:'MNCRVIC',destination:'MNCRVRS',victoria:[],previousVictoria:[{arrival:'',departure:'1100',pass:'',platform:'5'}],comparison:'previous capture',routeChanged:false}]};
assert.equal(worker.validateOperations(summary).changes[0].status,'withdrawn');
assert.throws(()=>worker.validateOperations({...summary,changes:Array(31).fill(summary.changes[0])}));
assert.throws(()=>worker.validateOperations({...summary,updatedAt:'invalid'}));
assert.throws(()=>worker.validateOperations({...summary,changes:[{...summary.changes[0],status:'whatever'}]}));
const board={trainServices:[]};await worker.enrichUnits(board,{}, {available:false,operations:summary});assert.equal(board._mcv.operations,summary,'VSTP health independent of Gemini availability');
console.log('Operations: health expiry, unique unit links, turnback visits and Worker schema passed');
// Exercise the actual panel rendering, not a copy.
const html=fs.readFileSync(new URL('../staff.html',import.meta.url),'utf8');
const elements=new Map();const listeners=[];
const element=id=>{if(!elements.has(id))elements.set(id,{id,value:'',innerHTML:'',textContent:'',addEventListener:(kind,fn)=>listeners.push({id,kind,fn})});return elements.get(id);};
Object.assign(context,{
 $:element,document:{addEventListener:(kind,fn)=>listeners.push({id:'document',kind,fn})},
 localStorage:{getItem:()=>null,setItem:()=>{}},
 state:{unitFeedMeta:{...meta,operations:summary},feedGeneratedAt:now,lastGood:now,lastError:'',services:[],viewMode:'departures'},
 escapeHTML:value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])),
 updateDisplayHTML:(element,value)=>{element.innerHTML=value;},relativeAge:()=> '0s',station:(name)=>name,
 allocatedUnits:(s,view)=>view==='arrivals'?s.arrivalUnits||[]:s.departureUnits||[],
 allocationCarriages:()=>2,serviceHasDeparture:s=>Number.isFinite(s.bookedMs)
});
vm.runInContext(html.slice(html.indexOf('function operationsBoardCurrent()'),html.indexOf('function render(){')),context);
context.renderOperations();assert.match(element('feed-health').innerHTML,/Daily timetable/);assert.match(element('vstp-changes').innerHTML,/Withdrawn VSTP variant/);
element('vstp-search').value='no-match';context.renderOperations();assert.match(element('vstp-changes').innerHTML,/No matching/);
element('vstp-search').value='';
const malicious={...summary.changes[0],headcode:'<img>',origin:'<svg>'};context.state.unitFeedMeta={...meta,operations:{...summary,changes:[malicious]}};context.renderOperations();assert.doesNotMatch(element('vstp-changes').innerHTML,/<img>|<svg>/);
assert.doesNotMatch(html,/data-formation-reference|data-clear-formation|shortFormationWarning/);
assert.equal(ops.shortFormation,undefined);
context.state.lastError='Network failure';assert.equal(context.operationLinks().length,0);
console.log('Actual panel rendering, search, escaped text, no manual formation entry and board-failure gating passed');

const possibleArrival={...a,arrivalUnits:[],platform:'3',operatorCode:'TP'};
const possibleDeparture={...b,departureUnits:[],platform:'3',operatorCode:'TP'};
assert.equal(ops.possibleTurnarounds([possibleArrival,possibleDeparture],[],now).length,1);
assert.match(ops.possibleTurnarounds([possibleArrival,possibleDeparture],[],now)[0].basis,/Possible pairing/);
assert.equal(ops.possibleTurnarounds([possibleArrival,possibleDeparture,{...possibleDeparture,key:'ambiguous'}],[],now).length,0);
assert.equal(ops.possibleTurnarounds([possibleArrival,{...possibleDeparture,platform:'4'}],[],now).length,0);
assert.equal(ops.possibleTurnarounds([possibleArrival,{...possibleDeparture,operatorCode:'NT'}],[],now).length,0);
assert.equal(ops.possibleTurnarounds([{...possibleArrival,arrivalUnits:['150123']},{...possibleDeparture,departureUnits:['150124']}],[],now).length,0);
assert.equal(ops.possibleTurnarounds([possibleArrival,possibleDeparture],[{arrival:possibleArrival,departure:possibleDeparture}],now).length,0);
console.log('Possible pairing fallback: absent units, ambiguity, platform/operator conflicts and stronger-link precedence passed');

const leedsArrival={...a,key:'1J21',headcode:'1J21',arrivalUnits:['195013'],platform:'1'};
const leedsDeparture={...b,key:'1J22',headcode:'1J22',departureUnits:['195013'],platform:'1',futureCancellation:true};
const flagged=ops.turnaroundLinks([leedsArrival,leedsDeparture],now);
assert.equal(flagged.length,1,'An onward cancelled call does not cancel the Victoria stock link');
assert.match(flagged[0].warning,/Later-location cancellation/);
assert.equal(ops.turnaroundLinks([leedsArrival,{...leedsDeparture,cancelled:true}],now).length,0);
assert.equal(ops.turnaroundLinks([leedsArrival,{...leedsDeparture,cancelledAtVictoria:true}],now).length,0);
assert.equal(ops.turnaroundLinks([{...leedsArrival,cancelledAtVictoria:true},leedsDeparture],now).length,0);
assert.equal(ops.turnaroundLinks([leedsArrival,{...leedsDeparture,departureUnits:['195014']}],now).length,0);
context.state.lastError='';context.state.services=[leedsArrival,leedsDeparture];context.renderOperations();
assert.match(element('turnaround-links').innerHTML,/1J21/);assert.match(element('turnaround-links').innerHTML,/1J22/);assert.match(element('turnaround-links').innerHTML,/Later-location cancellation/);
console.log('1J21/1J22: onward cancellation retains unit link and warning; Victoria cancellations still withheld');
