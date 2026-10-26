import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('./worker.mjs',import.meta.url),'utf8');
const worker=await import('data:text/javascript;base64,'+Buffer.from(source+'\nexport {validateBookedPatterns,mergeBookedPatterns,validateTrustSnapshot,mergeTrustServices};').toString('base64'));
const stamp=new Date().toISOString(),expiry=new Date(Date.now()+300000).toISOString();
const point=(tiploc,crs,locationName,st)=>({tiploc,crs,locationName,st});
const origin=point('MNCRVIC','MCV','Manchester Victoria','2026-10-26T15:22:00Z');
const turn=point('MNCRVRS','MNCRVRS','MNCRVRS','2026-10-26T15:25:00Z');
const returned=point('MNCRVIC','MCV','Manchester Victoria','2026-10-26T15:37:00Z');
const identity={uid:'N03290',trainid:'5P31',sdd:'2026-10-26'};
const routes=[{...identity,sta:null,std:origin.st,operational:true,callingPoints:[turn,returned],previousCallingPoints:[]},
 {...identity,sta:returned.st,std:null,operational:true,callingPoints:[],previousCallingPoints:[origin,turn]}];
const base={...identity,isPassengerService:false,category:'EE',operator:'TransPennine Express',operatorCode:'TP',origin:[{crs:'MCV',tiploc:'MNCRVIC',locationName:'Manchester Victoria'}],destination:[{crs:'MCV',tiploc:'MNCRVIC',locationName:'Manchester Victoria'}]};
const original=[{...base,std:'2026-10-26T15:22:00',platform:'3',etd:'2026-10-26T15:24:00'},
 {...base,sta:'2026-10-26T15:37:00',platform:'3',eta:'2026-10-26T15:29:00'}];
const timetable=worker.validateBookedPatterns({version:1,available:true,updatedAt:stamp,scheduleAt:stamp,routes,checks:[]});
const board={trainServices:structuredClone(original)};
worker.mergeBookedPatterns(board,{timetable});
assert.equal(board._mcv.timetableCallingPatternsMatched,2);
assert.equal(board.trainServices[0].trustCallingPoints.callingPoints.length,2);
assert.equal(board.trainServices[1].bookedOperationalRoute.previousCallingPoints.length,2);
assert.equal(board.trainServices[1].trustCallingPoints,undefined,'Return arrival has no invented onward calls');
assert.equal(board.trainServices[1].eta,original[1].eta,'Keep live Darwin return forecast');
assert.equal(board.trainServices[0].etd,original[0].etd,'Keep live Darwin outbound forecast');
const context={Date,Intl,console,setTimeout,clearTimeout,setInterval,clearInterval};vm.createContext(context);
vm.runInContext(readFileSync(new URL('../mcv-data.js',import.meta.url),'utf8'),context);
const adapted=context.MCVData.toLegacyBoard({generatedAt:stamp,trainServices:board.trainServices},{audience:'staff'}).results;
assert.equal(adapted[0].calling_points.length,2);
assert.equal(adapted[0].calling_points[0].crs,'MNCRVRS');assert.equal(adapted[0].calling_points[1].crs,'MCV');
assert.match(adapted[0].destination_name,/via West Turnback/);assert.match(adapted[1].origin_name,/via West Turnback/);
assert.equal(adapted[1].previous_calling_points.length,2);
const expired=structuredClone(board.trainServices[1]);expired.bookedOperationalRoute.expiresAt=new Date(Date.now()-1000).toISOString();
assert.equal(context.MCVData.toLegacyBoard({generatedAt:stamp,trainServices:[expired]},{audience:'staff'}).results[0].previous_calling_points.length,0);
assert.doesNotMatch(context.MCVData.toLegacyBoard({generatedAt:stamp,trainServices:[expired]},{audience:'staff'}).results[0].origin_name,/via West Turnback/);
for(const extra of [{isCancelled:true},{affectedByDiversion:true},{futureCancellation:true},{isPassengerService:true,category:'OO'}]){
 const altered={trainServices:[{...original[0],...extra}]};worker.mergeBookedPatterns(altered,{timetable});assert.equal(altered.trainServices[0].bookedOperationalRoute,undefined);
}
const live={trainServices:[{...original[0],subsequentLocations:[{crs:'OTHER'}]}]};worker.mergeBookedPatterns(live,{timetable});assert.equal(live.trainServices[0].trustCallingPoints,undefined);
const duplicate={trainServices:[{...original[0]},{...original[0]}]};worker.mergeBookedPatterns(duplicate,{timetable});assert.equal(duplicate._mcv.timetableCallingPatternsMatched,0);
assert.throws(()=>worker.validateBookedPatterns({version:1,available:true,updatedAt:stamp,scheduleAt:stamp,routes:[{...routes[0],operational:'yes'}]}));
// Activated TRUST routes also join distinct Darwin visits rather than colliding.
const trust=worker.validateTrustSnapshot({version:1,available:true,updatedAt:stamp,feedAt:stamp,scheduleAt:stamp,services:[],routes});
const activated={trainServices:structuredClone(original)};worker.mergeTrustServices(activated,{trust});
assert.equal(activated._mcv.trustCallingPatternsMatched,2);
// Exercise staff normalization itself: the future MCV call must not be sliced off.
const html=readFileSync(new URL('../staff.html',import.meta.url),'utf8');
const start=html.indexOf('    let onward=points.map(mapCallingPoint);');assert.ok(start>=0);
context.points=adapted[0].calling_points;context.mapCallingPoint=p=>({name:p.name,crs:p.crs});
vm.runInContext('onward=points.map(mapCallingPoint)',context);assert.equal(context.onward.length,2);assert.equal(context.onward[1].crs,'MCV');
assert.ok(html.includes("(s.ecs&&!Number.isFinite(s.bookedMs)&&beforeStops.length>0)"),'Arrival-only ECS details show prior timing points');
console.log('Turnback: two exact visits, full outbound/return route, live precedence, cancellation, expiry and adapter checks passed');
const supplements=routes.map((route,index)=>({...base,sta:route.sta,std:route.std,ata:null,atd:null,serviceID:'trust:2026-10-26:315P31IQ26:visit:'+index,
 mcvSource:'TRUST',serviceType:'train',platform:'3',previousCallingPoints:route.previousCallingPoints.length?[{callingPoint:route.previousCallingPoints}]:[],subsequentCallingPoints:route.callingPoints.length?[{callingPoint:route.callingPoints}]:[],
 trust:{platformSource:'booked',lastReportAt:null,departureDirection:index===0?'West':'',directionPoint:index===0?'MNCRVRS':'',trainId:'315P31IQ26'}}));
const supplementSnapshot=worker.validateTrustSnapshot({...trust,services:supplements});
const absent={trainServices:[]};worker.mergeTrustServices(absent,{trust:supplementSnapshot});assert.equal(absent.trainServices.length,2,'Keep both activated ECS visits when Darwin is absent');
const partial={trainServices:[structuredClone(original[0])]};worker.mergeTrustServices(partial,{trust:supplementSnapshot});assert.equal(partial.trainServices.length,2,'Darwin outbound suppresses only the matching visit');assert.equal(partial.trainServices.filter(s=>s.mcvSource==='TRUST')[0].std,null);
// Prior-stop requests and caches must distinguish visits sharing a Darwin RID.
vm.runInContext(html.slice(html.indexOf('function detailCacheKey('),html.indexOf('function realTimeTrainsUrl('))+
 html.slice(html.indexOf('function matchDetailedService('),html.indexOf('async function loadPreviousStops(')),context);
const outVisit={rid:'202610267803290',uid:'N03290',serviceId:'same',serviceDate:'2026-10-26',headcode:'5P31',operatorCode:'TP',bookedArrivalMs:NaN,bookedMs:Date.parse(origin.st),previousStops:[]};
const backVisit={...outVisit,bookedArrivalMs:Date.parse(returned.st),bookedMs:NaN,previousStops:['Victoria','West Turnback']};
assert.notEqual(context.detailCacheKey(outVisit),context.detailCacheKey(backVisit),'Separate prior-stop caches for each visit');
assert.equal(context.matchDetailedService(backVisit,[outVisit,backVisit]),backVisit);
assert.equal(context.matchDetailedService(outVisit,[backVisit,outVisit]),outVisit);
assert.equal(context.matchDetailedService(backVisit,[outVisit]),null,'Do not substitute outbound visit');
assert.equal(context.matchDetailedService(backVisit,[backVisit,{...backVisit}]),null,'Withhold duplicate exact visits');
assert.equal(context.matchDetailedService(backVisit,[{...backVisit,serviceDate:'2026-10-27'}]),null);
assert.equal(context.matchDetailedService({...backVisit,bookedArrivalMs:NaN},[backVisit]),null);
const through={...outVisit,bookedArrivalMs:Date.parse(origin.st)-60000};
assert.equal(context.matchDetailedService(through,[outVisit]),null,'Every supplied clock must match');
assert.equal(context.matchDetailedService(backVisit,[{...backVisit,rid:'different',uid:'X12345',serviceId:'different'}]),null);
const noIds={...backVisit,rid:'',uid:'',serviceId:''};
assert.equal(context.matchDetailedService(noIds,[backVisit]),backVisit,'Unique headcode/date/clocks fallback');
const cancelledVisit={trainServices:[{...original[0],filterLocationCancelled:true}]};
worker.mergeTrustServices(cancelledVisit,{trust});
assert.equal(cancelledVisit.trainServices[0].bookedOperationalRoute,undefined,'Cancelled Victoria call has no TRUST booked route');
assert.equal(cancelledVisit.trainServices[0].trustCallingPoints,undefined);
console.log('Visit detail matching, independent caches and cancelled-call regression checks passed');
