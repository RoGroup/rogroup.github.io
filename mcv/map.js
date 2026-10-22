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
  if(row.associationStep)body.append(node('p',`Platform retained from the connected SMART arrival step ${row.associationStep.from} → ${row.associationStep.to} at ${clock(row.associationStep.time)}.`));
  $('details').showModal();
}
function button(row){const b=node('button',null,'train'+(row.platforms.length>1||row.event==='description'?' ambiguous':''));b.append(node('strong',row.headcode),node('small',row.event==='arrival'?'Arrival step':row.associationStep?'Platform retained':'Description observed'),node('small',`M3 ${row.berth} · ${clock(row.time)}`));b.onclick=()=>show(row);return b;}
// Original geometry drawn from the supplied station-layout reference.
// Track lines provide context only: no S-class occupancy, points or aspects.
function centerVictoria(){const viewport=$('viewport');const width=$('diagram').getBoundingClientRect().width;viewport.scrollLeft=Math.max(0,width*862/1440-viewport.clientWidth/2);}
function buildDiagram(diagram){
 const ns='http://www.w3.org/2000/svg';
 const svg=document.createElementNS(ns,'svg');
 svg.setAttribute('viewBox','0 0 1440 650');svg.setAttribute('role','img');
 svg.setAttribute('aria-label','Schematic: Salford Central west of Manchester Victoria; Victoria platforms six to one, with turnback siding and Ordsall Chord below.');
 const put=(tag,attrs,text)=>{const el=document.createElementNS(ns,tag);for(const [key,value] of Object.entries(attrs))el.setAttribute(key,value);if(text)el.textContent=text;svg.append(el);return el;};
 const track=d=>put('path',{d,class:'track'});
 // Four routes through the station throat, plus the two east-facing bays.
 track('M 70 155 H 555 L 610 110 H 1370');
 track('M 70 215 H 555 L 610 180 H 1370');
 track('M 70 305 H 450 L 505 250 H 1370');
 track('M 70 365 H 510 L 555 320 H 1370');
 track('M 780 405 H 1000 L 1115 290 L 1155 250');
 track('M 780 485 H 945 L 1110 320');
 // Junction ladders, redrawn with independent spacing and geometry.
 track('M 145 155 L 205 215');track('M 315 215 L 375 155');
 track('M 440 155 L 510 215');track('M 445 215 L 535 305');
 track('M 365 365 L 480 250');track('M 610 250 L 680 180');
 track('M 640 320 L 710 250');track('M 570 180 L 640 250');
 track('M 650 250 L 720 320');track('M 1000 110 L 1070 180');
 track('M 1080 180 L 1150 250');track('M 1170 250 L 1240 180');
 track('M 1010 320 L 1080 250');
 // Turnback siding and the chord. Their descriptions are not mapped yet.
 track('M 635 390 H 700 L 770 320');
 track('M 70 590 L 220 440 V 405 L 260 365');
 track('M 135 590 L 280 445 V 405 L 320 365');
 put('path',{d:'M 780 392 V 418 M 780 472 V 498 M 635 378 V 402',class:'buffer'});
 const platform=(x,y,w,h)=>put('rect',{x,y,width:w,height:h,rx:5,class:'platform-block'});
 platform(790,53,145,38);platform(790,198,145,34);platform(790,338,145,48);platform(790,425,145,40);
 platform(238,104,110,32);platform(238,234,110,32);
 const label=(x,y,text,cls='map-label',anchor='middle')=>put('text',{x,y,class:cls,'text-anchor':anchor},text);
 for(const [p,y] of [[6,110],[5,180],[4,250],[3,320],[2,405],[1,485]]){
  put('rect',{x:752,y:y-13,width:23,height:26,rx:3,class:'platform-number'});label(763.5,y+5,String(p),'number');
 }
 label(293,126,'1','number');label(293,257,'2','number');
 label(293,65,'SALFORD CENTRAL','station-label');label(862,545,'MANCHESTER VICTORIA','station-label');
 label(450,118,'Deal Street Jn','map-label');label(427,408,'Irwell Street Jn','map-label');
 label(655,430,'Turnback siding','map-label');label(206,540,'Ordsall Chord','map-label','start');
 label(70,120,'West approaches','direction-label','start');label(1370,75,'East approaches →','direction-label','end');
 label(70,625,'↙ Oxford Road / Piccadilly','direction-label','start');
 label(1080,588,'Approach lines shown for context','context-label');
 label(1080,612,'Live descriptions: Victoria platforms only','context-label');
 diagram.append(svg);
 for(const [p,y] of [[6,110],[5,180],[4,250],[3,320],[2,405],[1,485]]){
  const slot=node('div',null,'berth-slot');slot.id='platform-'+p;slot.setAttribute('aria-label','Platform '+p+' train descriptions');
  slot.style.left=(862/1440*100)+'%';slot.style.top=(y/650*100)+'%';diagram.append(slot);
 }
 requestAnimationFrame(centerVictoria);
}
// Retain only a connected arrival-to-next-berth chain, never headcode alone.
function resolveAssociation(row,events){
 if(row.platforms.length!==1 && row.event==='description' && row.from){
  const prior=(events||[]).filter(e=>e.headcode===row.headcode && e.time<=row.time && row.time-e.time<=120).sort((a,b)=>b.time-a.time);
  const latest=prior[0];
  const tied=latest?prior.filter(e=>e.time===latest.time):[];
  if(latest && tied.length===1 && latest.event==='arrival' && latest.berth===row.from &&
     latest.platforms.length===1 && row.platforms.includes(latest.platforms[0])){
   return {...row,platforms:latest.platforms,associationStep:{from:latest.from,to:latest.berth,time:latest.time}};
  }
 }
 return row;
}
function render(){
 const now=Date.now()/1000,live=!failed&&fresh(snapshot,now);
 $('health').textContent=live?(snapshot.scanLimited?'TD received · replay window limited':'TD received'):failed?'TD connection unavailable':snapshot?.available?'TD snapshot stale':'Awaiting TD publisher';
 $('health').style.color=live?'#8fe1cb':'#ffcc65';
 $('freshness').textContent=snapshot?.feedAt?`Last M3 receipt ${clock(snapshot.feedAt)} · snapshot ${Math.max(0,Math.floor(now-snapshot.generatedAt))}s old`:'Deploy the TD Worker route and server publisher to connect this map.';
 const diagram=$('diagram');
 if(!diagram.children.length)buildDiagram(diagram);
 const rows=live?(snapshot.berths||[]).filter(r=>now-r.time<=600 && r.time<=now+30).map(r=>resolveAssociation(r,snapshot.events)):[];
 for(let p=1;p<=6;p++){
  const slot=$('platform-'+p);slot.replaceChildren();
  const matches=rows.filter(r=>r.platforms.length===1&&r.platforms[0]===String(p));
  matches.forEach(r=>slot.append(button(r)));
  if(!matches.length){const empty=node('span','—','empty-berth');empty.title=live?'No recent mapped description; platform occupancy unknown':'Waiting for fresh TD data';slot.append(empty);}
 }
 const shared=$('shared');shared.replaceChildren();
 const uncertain=rows.filter(r=>r.platforms.length!==1);
 shared.hidden=!uncertain.length;
 if(uncertain.length){shared.append(node('strong','Shared platform associations'));uncertain.forEach(r=>{const b=button(r);b.append(node('small',`Platforms ${r.platforms.join(' / ')}`));shared.append(b)});}
 const movements=$('movements');movements.replaceChildren();
 const events=live?(snapshot.events||[]).filter(r=>now-r.time<=600).slice().reverse():[];
 $('empty').hidden=events.length>0;$('empty').textContent=live?'No mapped movements in the last ten minutes.':'Recent movements will appear when fresh TD data is available.';
 for(const row of events){const div=node('div',null,'movement'),b=node('button',row.headcode);b.onclick=()=>show(row);div.append(node('time',clock(row.time)),b,node('span',`Platform ${row.platforms.join(' / ')} · ${row.event==='arrival'?'arrival':'departure'} step`),node('span',`${row.from} → ${row.berth}`));movements.append(div);}
}
async function refresh(){if(busy)return;busy=true;$('refresh').disabled=true;const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),12000);try{const response=await fetch(API,{cache:'no-store',signal:controller.signal});if(!response.ok)throw Error('TD endpoint unavailable');const data=await response.json();if(data.version!==1 || (data.available && (!Array.isArray(data.berths)||!Array.isArray(data.events))))throw Error('Invalid snapshot');snapshot=data;failed=false;}catch{failed=true;}finally{clearTimeout(timeout);busy=false;$('refresh').disabled=false;render();}}
function setZoom(value){zoom=Math.max(1,Math.min(2.5,value));$('diagram').style.width=`${Math.max(900,$('viewport').clientWidth||900)*zoom}px`;}
$('plus').onclick=()=>setZoom(zoom+.25);$('minus').onclick=()=>setZoom(zoom-.25);$('fit').onclick=()=>{setZoom(1);centerVictoria()};$('refresh').onclick=refresh;$('close').onclick=()=>$('details').close();
$('fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else if(document.documentElement.requestFullscreen)await document.documentElement.requestFullscreen();else $('viewport').scrollIntoView({behavior:'smooth'});}catch{}};
render();refresh();setInterval(()=>{if(!document.hidden)refresh()},30000);setInterval(render,10000);document.addEventListener('visibilitychange',()=>{if(!document.hidden)refresh()});
