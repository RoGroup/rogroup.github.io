import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const context={Date,Intl};vm.createContext(context);
vm.runInContext(readFileSync(new URL('../mcv-data.js',import.meta.url),'utf8'),context);
const M=context.MCVData;
const point=(crs,locationName)=>({crs,locationName,tiploc:crs,st:'2026-10-22T20:00:00+01:00'});
const hud=point('HUD','Huddersfield'),bgh=point('BGH','Brighouse'),bdi=point('BDI','Bradford Interchange');
const route=points=>({source:'Booked calling pattern',expiresAt:new Date(Date.now()+60000).toISOString(),callingPoints:points});
const tpe={operatorCode:'TP',trainid:'9E18',trustCallingPoints:route([bgh,point('NCL','Newcastle')])};
const display=(s,name='Newcastle',crs='NCL')=>M.displayDestinationName(name,crs,s.trainid,s);
assert.equal(display(tpe),'Newcastle via Brighouse');
assert.equal(display({...tpe,trustCallingPoints:route([hud,point('NCL','Newcastle')])}),'Newcastle via Huddersfield');
assert.equal(display({...tpe,subsequentCallingPoints:[{callingPoint:[hud]}]}),'Newcastle via Huddersfield','Darwin live route replaces booked via');
assert.equal(display({...tpe,subsequentLocations:[hud]}),'Newcastle via Huddersfield');
assert.equal(display({...tpe,subsequentLocations:[point('YRK','York')]}),'Newcastle','A partial live pattern cannot borrow a booked via');
assert.equal(display({...tpe,subsequentCallingPoints:[{assocIsCancelled:true,callingPoint:[hud]}]}),'Newcastle');
assert.equal(display({...tpe,subsequentLocations:[{...hud,isCancelled:true}]}),'Newcastle');
for(const change of [{isCancelled:true},{filterLocationCancelled:true},{futureCancellation:true},{diversion:true},{affectedByDiversion:true},
 {trustCallingPoints:{...tpe.trustCallingPoints,expiresAt:new Date(Date.now()-1).toISOString()}}])assert.equal(display({...tpe,...change}),'Newcastle');
assert.equal(display({...tpe,trustCallingPoints:route([{...bgh,isPass:true}])}),'Newcastle');
assert.equal(display({...tpe,trustCallingPoints:route([{...bgh,isOperational:true}])}),'Newcastle');
assert.equal(display(tpe,'Brighouse','BGH'),'Brighouse','Destination itself is not a via');
const northern={operatorCode:'NT',trainid:'2I30',trustCallingPoints:route([bdi,point('LDS','Leeds')])};
assert.equal(display(northern,'Leeds','LDS'),'Leeds via Bradford Int');
assert.equal(display({...northern,trustCallingPoints:route([bgh,point('LDS','Leeds')])},'Leeds','LDS'),'Leeds via Brighouse');
assert.equal(display({...northern,trustCallingPoints:route([point('LDS','Leeds')])},'Leeds','LDS'),'Leeds','No inferred Brighouse from a destination-only route');
assert.equal(display({...northern,subsequentLocations:[bgh]},'Leeds','LDS'),'Leeds via Brighouse');
assert.equal(display({...northern,trainid:'1J30'},'Leeds','LDS'),'Leeds via Bradford Int');
assert.equal(display({...northern,trainid:'1J30',subsequentLocations:[bgh]},'Leeds','LDS'),'Leeds via Brighouse');
const native={...tpe,uid:'G15988',sdd:'2026-10-22',serviceID:'later',std:'2026-10-22T19:00:00',destination:[{locationName:'Newcastle',crs:'NCL'}]};
const legacy=M.toLegacyBoard({generatedAt:new Date().toISOString(),trainServices:[native]}).results[0];
assert.equal(legacy.destination.name,'Newcastle via Brighouse');
assert.equal(legacy.destination_name,'Newcastle via Brighouse');
assert.equal(legacy.calling_points_source,'Booked calling pattern');
for(const name of ['staff.html','staff-platform.html'])assert.ok(readFileSync(new URL('../'+name,import.meta.url),'utf8').includes('mcv-data.js?v=20261022-wigan-via'));
console.log('Via labels: booked patterns, live precedence, partial/cancelled/expired routes, relevant waypoints and staff integration passed');

// Wigan 2J workings carry an explicit Darwin destination via outside 2W rules.
for(const [trainid,std] of [['2J63','2026-10-22T20:09:00'],['2J65','2026-10-22T21:09:00']]){
  const s={operatorCode:'NT',trainid,std,destination:[{locationName:'Wigan North Western',crs:'WGN',via:'via Bolton'}]};
  assert.equal(display(s,'Wigan North Western','WGN'),'Wigan North Western via Bolton');
  assert.equal(display({...s,destination:[{locationName:'Wigan North Western',crs:'WGN',via:'Bolton'}]},'Wigan North Western','WGN'),'Wigan North Western via Bolton');
  assert.equal(display({...s,destination:[],trustCallingPoints:route([point('BON','Bolton'),point('WGN','Wigan North Western')])},'Wigan North Western','WGN'),'Wigan North Western via Bolton');
  assert.equal(display({...s,destination:[]},'Wigan North Western','WGN'),'Wigan North Western','A 2J headcode alone does not imply Bolton');
}
console.log('Wigan 20:09/21:09: Darwin via label and booked Bolton waypoint passed');
