import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('./worker.mjs',import.meta.url),'utf8');
const worker=await import('data:text/javascript;base64,'+Buffer.from(source+'\nexport {validateRecent};').toString('base64'));
const now=Date.now(),iso=offset=>new Date(now+offset).toISOString();
const service={uid:'P12345',headcode:'2N01',date:'2026-10-22',source:'Darwin',cancelled:false,
  sta:iso(-3600000),std:iso(-3540000),firstSeen:iso(-7200000),lastSeen:iso(-1800000),origin:'Leeds',destination:'Liverpool',platform:'4',ata:'',atd:'',eta:'',etd:'',
  allocation:{status:'allocated',capturedAt:iso(-3600000),arrivalUnits:['150123'],departureUnits:['150456']},
  history:{capturedAt:iso(-3600000),reconciliationRequired:false,events:[{kind:'arrival',at:iso(-3600000),timeBasis:'actual',locationName:'Manchester Victoria',tiploc:'MNCRVIC',crs:'MCV',platform:'4',delaySeconds:0}]}};
const archive={version:1,retentionHours:48,startedAt:iso(-7200000),updatedAt:iso(-1000),services:[service]};
assert.equal(worker.validateRecent({...archive,xml:'drop',services:[{...service,xml:'drop'}]}).services[0].xml,undefined);
for(const change of [{uid:'wrong'},{std:'12:30'},{allocation:{...service.allocation,departureUnits:['garbage']}},{history:{...service.history,events:[{...service.history.events[0],timeBasis:'received'}]}}])assert.throws(()=>worker.validateRecent({...archive,services:[{...service,...change}]}));
assert.throws(()=>worker.validateRecent({...archive,services:[service,service]}));
let saved=null,writes=0;
const env={UNIT_INGEST_KEY:'test-archive-key',UNIT_ALLOCATIONS:{put:async(key,value)=>{saved=JSON.parse(value);writes++},get:async()=>saved}};
const fetch=(path,options={})=>worker.default.fetch(new Request('https://worker.test'+path,options),env,{});
let response=await fetch('/recent-ingest',{method:'POST',body:JSON.stringify(archive)});
assert.equal(response.status,401);assert.equal(writes,0);
response=await fetch('/recent-ingest',{method:'POST',headers:{Authorization:'Bearer test-archive-key'},body:JSON.stringify(archive)});
assert.equal(response.status,200);assert.equal(writes,1);
for(const q of ['2N01','p12345','150456','150123']){
  response=await fetch('/recent-services?q='+q);
  const data=await response.json();assert.equal(data.total,1);assert.equal(data.services[0].history.events.length,1,'Historical reports do not expire like live joins');
}
assert.equal((await fetch('/recent-services?q=X')).status,400);
assert.equal((await fetch('/recent-services?q=2N01&offset=-1')).status,400);
assert.equal((await (await fetch('/recent-services?q=2N01&date=2026-10-21')).json()).total,0);
saved.services=[service,{...service,uid:'P12346',sta:iso(60000),std:iso(120000)},{...service,uid:'P12347',sta:iso(-49*3600000),std:iso(-49*3600000)}];
assert.equal((await (await fetch('/recent-services?q=2N01')).json()).total,1,'Future and expired records are excluded');
saved.updatedAt=iso(-21*60000);
assert.equal((await (await fetch('/recent-services?q=2N01')).json()).stale,true);
saved.services=Array.from({length:25},(_,i)=>({...service,uid:'P'+String(i).padStart(5,'0')}));
let page=await (await fetch('/recent-services?q=2N01')).json();assert.equal(page.services.length,20);assert.equal(page.nextOffset,20);
page=await (await fetch('/recent-services?q=2N01&offset=20')).json();assert.equal(page.services.length,5);assert.equal(page.nextOffset,null);
saved=null;assert.equal((await (await fetch('/recent-services?q=2N01')).json()).available,false);

// The collapsed panel never fetches on load/open. Search and pagination are explicit.
const nodes=new Map();const node=id=>{if(!nodes.has(id))nodes.set(id,{hidden:false,value:'',textContent:'',innerHTML:'',listeners:{},addEventListener(type,fn){this.listeners[type]=fn},getAttribute(){return this.expanded||'false'},setAttribute(k,v){this.expanded=v},focus(){},insertAdjacentHTML(pos,content){this.innerHTML+=content}});return nodes.get(id)};
let requests=0,failed=false;
const documentListeners={};
const context={Date,Intl,URLSearchParams,document:{getElementById:node,addEventListener:(type,fn)=>documentListeners[type]=fn},MCVSite:{fetch:async()=>{requests++;if(failed)throw Error();return {ok:true,json:async()=>({...archive,available:true,total:1,nextOffset:null})}}}};
vm.createContext(context);vm.runInContext(readFileSync(new URL('../mcv-service-report.js',import.meta.url),'utf8'),context);vm.runInContext(readFileSync(new URL('../mcv-recent.js',import.meta.url),'utf8'),context);
assert.equal(requests,0);node('recent-toggle').listeners.click();assert.equal(requests,0);
const html=context.MCVRecent.recordHTML({...service,origin:'<script>alert(1)</script>'});assert.ok(!html.includes('<script>'));assert.ok(html.includes('&lt;script&gt;'));assert.ok(!html.includes(' open'));
node('recent-query').value='2N01';node('recent-form').listeners.submit({preventDefault(){}});
await new Promise(resolve=>setTimeout(resolve,0));assert.equal(requests,1);assert.match(node('recent-results').innerHTML,/150456/);assert.match(node('recent-status').textContent,/Capture started/);
node('recent-date').value='2026-10-21';documentListeners.click({target:{closest:()=>({dataset:{unitHistory:'150456'}})}});
await new Promise(resolve=>setTimeout(resolve,0));assert.equal(node('recent-query').value,'150456');assert.equal(node('recent-date').value,'');assert.equal(requests,2);
failed=true;node('recent-form').listeners.submit({preventDefault(){}});await new Promise(resolve=>setTimeout(resolve,0));assert.match(node('recent-status').textContent,/unavailable/);assert.equal(node('recent-submit').disabled,false);
console.log('Recent archive: validation, authentication, retention, identity/date/unit search, pagination, historical reports and UI checks passed');
