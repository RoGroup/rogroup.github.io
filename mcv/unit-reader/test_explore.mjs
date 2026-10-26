import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
const code=fs.readFileSync(new URL('../mcv-explore.js',import.meta.url),'utf8');
const ctx={Intl,Date,URL,console};vm.createContext(ctx);vm.runInContext(code,ctx);
const {movements,matches}=ctx.MCVExplore;
const now=Date.now();
const base={key:'a',platform:'1',bookedArrivalMs:now+60000,bookedMs:now+180000,stops:[{name:'Bolton',crs:'BON',booked:'19:00'},{name:'Bramley',crs:'BLE',cancelled:true}]};
assert.equal(movements([base],'1').length,2);
assert.equal(movements([base],'2').length,0);
assert.equal(movements([{...base,platform:''}],'unknown').length,2);
assert.equal(movements([{...base,departed:true}],'all').length,0);
assert.equal(movements([{...base,source:'TRUST',trust:{expiresAt:new Date(now-1000).toISOString()}}],'all').length,0);
assert.equal(matches([base],'bon').length,1);
assert.equal(matches([base],'bolton').length,1);
assert.equal(matches([base],'Bramley').length,0);
assert.equal(matches([base],'Bramley',true).length,1);
assert.equal(matches([{...base,ecs:true}],'Bolton').length,0);
assert.equal(matches([{...base,bookedMs:NaN}],'Bolton').length,0);
assert.equal(matches([{...base,stops:[]}],'Bolton').length,0);
// Route changes select exactly one view and keep the navigation state aligned.
const ids=['staff-board-view','events-view','platform-view','calling-point-view'];
const elements=Object.fromEntries(ids.map(id=>[id,{hidden:false}]));
const links=['','events','platform','calling-points'].map(hash=>({href:'https://railstaffhub.uk/mcv/staff.html'+(hash?'#'+hash:''),attributes:{},setAttribute(k,v){this.attributes[k]=v;},removeAttribute(k){delete this.attributes[k];}}));
let setup,hashchange;
const document={readyState:'loading',getElementById:id=>elements[id]||{addEventListener(){}},querySelectorAll:()=>links,addEventListener:(name,fn)=>{if(name==='DOMContentLoaded')setup=fn;}};
const window={document,location:{href:'https://railstaffhub.uk/mcv/staff.html#platform',pathname:'/mcv/staff.html',hash:'#platform'},addEventListener:(name,fn)=>{if(name==='hashchange')hashchange=fn;},scrollTo(){}};
const ui={window,document,location:window.location,Intl,Date,URL};vm.createContext(ui);vm.runInContext(code,ui);setup();
for(const [hash,id] of [['#platform','platform-view'],['#events','events-view'],['#calling-points','calling-point-view'],['','staff-board-view']]){
 window.location.hash=hash;hashchange({type:'hashchange'});
 assert.equal(ids.filter(x=>!elements[x].hidden).join(),id);
 assert.equal(links.filter(a=>a.attributes['aria-current']==='page').length,1);
}
console.log('Explorer filtering, movements, expiry and four-view routing passed');
