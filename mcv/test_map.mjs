import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
class Element {
 constructor(){this.children=[];this.style={};this.hidden=false;this.textContent='';}
 append(...items){this.children.push(...items)}
 replaceChildren(...items){this.children=items}
 showModal(){this.open=true}close(){this.open=false}
}
const elements=new Map();const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id)};
const context=vm.createContext({document:{getElementById:get,createElement:()=>new Element(),addEventListener(){},hidden:false},Date,AbortController,setTimeout,clearTimeout,setInterval(){},fetch:async()=>({ok:true,json:async()=>({version:1,available:false})})});
vm.runInContext(readFileSync(new URL('./map.js',import.meta.url),'utf8'),context);
await new Promise(resolve=>setImmediate(resolve));
const now=Date.now()/1000;
context.data={version:1,available:true,feedAt:now,generatedAt:now,scanLimited:false,berths:[{headcode:'2I30',berth:'0581',from:'0702',platforms:['5'],time:now,event:'arrival',offset:49},{headcode:'2J27',berth:'0753',from:'',platforms:['4','5'],time:now,event:'description',offset:null}],events:[]};
vm.runInContext('snapshot=data; failed=false; render()',context);
assert.equal(get('diagram').children.length,7,'Shared description has its own lane');
const lane5=get('diagram').children[4];assert.equal(lane5.children[1].children[0].children[0].textContent,'2I30');
lane5.children[1].children[0].onclick();assert.equal(get('details').open,true);assert.equal(get('detailTitle').textContent,'2I30');
vm.runInContext('snapshot.feedAt-=181;render()',context);assert.equal(get('diagram').children.length,6);assert.match(get('health').textContent,/stale/);
assert.equal(get('diagram').children[4].children[1].children[0].textContent,'Waiting for fresh TD data');
vm.runInContext('snapshot.feedAt+=181; failed=true;render()',context);assert.match(get('health').textContent,/unavailable/);
get('plus').onclick();assert.equal(get('diagram').style.width,'125%');get('fit').onclick();assert.equal(get('diagram').style.width,'100%');
console.log('Map rendering: platform association, shared berth, evidence dialog, stale/failure hiding and zoom passed');
