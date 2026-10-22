import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
class Element {
 constructor(){this.children=[];this.style={};this.hidden=false;this.textContent='';this.clientWidth=390;this.attributes={};}
 set id(value){elements.set(value,this)}
 setAttribute(key,value){this.attributes[key]=value}
 getBoundingClientRect(){return {width:parseFloat(this.style.width)||900}}
 append(...items){this.children.push(...items)}
 replaceChildren(...items){this.children=items}
 showModal(){this.open=true}close(){this.open=false}
}
const elements=new Map();const get=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id)};
const context=vm.createContext({document:{getElementById:get,createElement:()=>new Element(),createElementNS:()=>new Element(),addEventListener(){},hidden:false},Date,AbortController,requestAnimationFrame:fn=>fn(),setTimeout,clearTimeout,setInterval(){},fetch:async()=>({ok:true,json:async()=>({version:1,available:false})})});
vm.runInContext(readFileSync(new URL('./map.js',import.meta.url),'utf8'),context);
await new Promise(resolve=>setImmediate(resolve));
const now=Date.now()/1000;
context.data={version:1,available:true,feedAt:now,generatedAt:now,scanLimited:false,berths:[{headcode:'2I30',berth:'0581',from:'0702',platforms:['5'],time:now,event:'arrival',offset:49},{headcode:'2J27',berth:'0753',from:'',platforms:['4','5'],time:now,event:'description',offset:null}],events:[]};
vm.runInContext('snapshot=data; failed=false; render()',context);
assert.equal(get('diagram').children.length,7,'Static SVG and six anchored berth slots');
assert.equal(get('shared').hidden,false);
const lane5=get('platform-5');assert.equal(lane5.children[0].children[0].textContent,'2I30');
lane5.children[0].onclick();assert.equal(get('details').open,true);assert.equal(get('detailTitle').textContent,'2I30');
vm.runInContext('snapshot.feedAt-=181;render()',context);assert.equal(get('shared').hidden,true);assert.match(get('health').textContent,/stale/);
assert.equal(get('platform-5').children[0].textContent,'—');
vm.runInContext('snapshot.feedAt+=181; failed=true;render()',context);assert.match(get('health').textContent,/unavailable/);
get('plus').onclick();assert.equal(get('diagram').style.width,'1125px');get('fit').onclick();assert.equal(get('diagram').style.width,'900px');
console.log('Map rendering: platform association, shared berth, evidence dialog, stale/failure hiding and zoom passed');

const positions=[6,5,4,3,2,1].map(p=>parseFloat(get('platform-'+p).style.top));
assert.ok(positions.every((y,i)=>!i||y>positions[i-1]),'Platform 6 at top through to platform 1 at bottom');
assert.ok(get('viewport').scrollLeft>0,'Mobile view starts centred on Victoria');
