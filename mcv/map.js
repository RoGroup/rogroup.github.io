'use strict';
const API='https://mcv-rdm-proxy.railstaffhub.uk/td-map';
const $=id=>document.getElementById(id);
let snapshot=null,failed=false,busy=false,zoom=1;
const clock=t=>new Date(t*1000).toLocaleTimeString('en-GB',{timeZone:'Europe/London',hour:'2-digit',minute:'2-digit',second:'2-digit'});
function node(tag,text,cls){const n=document.createElement(tag);if(text!=null)n.textContent=text;if(cls)n.className=cls;return n;}
function fresh(data,now=Date.now()/1000){return data?.available===true && data.stale!==true && Number.isFinite(data.generatedAt) && Number.isFinite(data.feedAt) && now-data.generatedAt<=180 && now-data.feedAt<=180 && data.generatedAt<=now+30 && data.feedAt<=now+30;}
function show(row){
  $('detailTitle').textContent=row.headcode;
  const body=$('detailBody');body.replaceChildren();
  for(const text of [`M3 berth step: ${row.from||'interposed'} → ${row.berth}`,`Platform association: ${row.platforms.join(' / ')}`,`Observed at ${clock(row.time)}`,row.event==='arrival'?'SMART arrival reporting step; arrival at the platform is not confirmed.':row.event==='departure'?'SMART departure reporting step.':'Train description observed; movement classification is unresolved.',row.offset==null?'Reporting offset: unresolved':`SMART reporting adjustment: ${row.offset>0?'+':''}${row.offset} seconds`])body.append(node('p',text));
  $('details').showModal();
}
function button(row){const b=node('button',null,'train'+(row.platforms.length>1||row.event==='description'?' ambiguous':''));b.append(node('strong',row.headcode),node('small',row.event==='arrival'?'Arrival step':'Description observed'),node('small',`M3 ${row.berth} · ${clock(row.time)}`));b.onclick=()=>show(row);return b;}
function render(){
 const now=Date.now()/1000,live=!failed&&fresh(snapshot,now);
 $('health').textContent=live?(snapshot.scanLimited?'TD received · replay window limited':'TD received'):failed?'TD connection unavailable':snapshot?.available?'TD snapshot stale':'Awaiting TD publisher';
 $('health').style.color=live?'#8fe1cb':'#ffcc65';
 $('freshness').textContent=snapshot?.feedAt?`Last M3 receipt ${clock(snapshot.feedAt)} · snapshot ${Math.max(0,Math.floor(now-snapshot.generatedAt))}s old`:'Deploy the TD Worker route and server publisher to connect this map.';
 const diagram=$('diagram');diagram.replaceChildren();
 const rows=live?(snapshot.berths||[]).filter(r=>now-r.time<=600 && r.time<=now+30):[];
 for(let p=1;p<=6;p++){
  const lane=node('div',null,'lane');lane.append(node('div',`Platform ${p}`,'platform'));
  const observations=node('div',null,'observations');
  const matches=rows.filter(r=>r.platforms.length===1&&r.platforms[0]===String(p));
  matches.forEach(r=>observations.append(button(r)));
  if(!matches.length)observations.append(node('span',live?'No recent mapped description':'Waiting for fresh TD data'));
  lane.append(observations);diagram.append(lane);
 }
 const shared=rows.filter(r=>r.platforms.length!==1);
 if(shared.length){const lane=node('div',null,'lane shared');lane.append(node('div','Shared association','platform'));const items=node('div',null,'observations');shared.forEach(r=>{const b=button(r);b.append(node('small',`Platforms ${r.platforms.join(' / ')}`));items.append(b)});lane.append(items);diagram.append(lane);}
 const movements=$('movements');movements.replaceChildren();
 const events=live?(snapshot.events||[]).filter(r=>now-r.time<=600).slice().reverse():[];
 $('empty').hidden=events.length>0;$('empty').textContent=live?'No mapped movements in the last ten minutes.':'Recent movements will appear when fresh TD data is available.';
 for(const row of events){const div=node('div',null,'movement'),b=node('button',row.headcode);b.onclick=()=>show(row);div.append(node('time',clock(row.time)),b,node('span',`Platform ${row.platforms.join(' / ')} · ${row.event==='arrival'?'arrival':'departure'} step`),node('span',`${row.from} → ${row.berth}`));movements.append(div);}
}
async function refresh(){if(busy)return;busy=true;$('refresh').disabled=true;const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),12000);try{const response=await fetch(API,{cache:'no-store',signal:controller.signal});if(!response.ok)throw Error('TD endpoint unavailable');const data=await response.json();if(data.version!==1 || (data.available && (!Array.isArray(data.berths)||!Array.isArray(data.events))))throw Error('Invalid snapshot');snapshot=data;failed=false;}catch{failed=true;}finally{clearTimeout(timeout);busy=false;$('refresh').disabled=false;render();}}
function setZoom(value){zoom=Math.max(1,Math.min(2.5,value));$('diagram').style.width=`${zoom*100}%`;}
$('plus').onclick=()=>setZoom(zoom+.25);$('minus').onclick=()=>setZoom(zoom-.25);$('fit').onclick=()=>setZoom(1);$('refresh').onclick=refresh;$('close').onclick=()=>$('details').close();
$('fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else if(document.documentElement.requestFullscreen)await document.documentElement.requestFullscreen();else $('viewport').scrollIntoView({behavior:'smooth'});}catch{}};
render();refresh();setInterval(()=>{if(!document.hidden)refresh()},30000);setInterval(render,10000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh()});
