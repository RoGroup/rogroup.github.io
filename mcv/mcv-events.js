/* Data Thistle performance view. All display times are Europe/London. */
(function(root){
'use strict';
const zone='Europe/London',dayFormat=new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit'});
const clockFormat=new Intl.DateTimeFormat('en-GB',{timeZone:zone,hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
const fullFormat=new Intl.DateTimeFormat('en-GB',{timeZone:zone,weekday:'short',day:'numeric',month:'short',year:'numeric'});
function day(value){
  if(typeof value==='string'&&/^\d{4}-\d\d-\d\d$/.test(value))return value;
  const parts=Object.fromEntries(dayFormat.formatToParts(new Date(value)).map(p=>[p.type,p.value]));return `${parts.year}-${parts.month}-${parts.day}`;
}
function addDays(value,amount){const d=new Date(value+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+amount);return d.toISOString().slice(0,10);}
function escape(value){return String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function safeUrl(value){try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:'';}catch{return '';}}
function rowsFrom(data){
  if(data?.version!==1||!Array.isArray(data.events)||!Array.isArray(data.places)||!Array.isArray(data.performances)||data.performances.length>20000)throw Error('Unexpected events format');
  const events=new Map(data.events.map(row=>[row.id,row])),places=new Map(data.places.map(row=>[row.id,row]));
  return data.performances.map(performance=>{
    const event=events.get(performance.eventId),place=places.get(performance.placeId);
    if(!event||!place||!Number.isFinite(Date.parse(performance.start)))throw Error('Invalid event/venue reference');
    return {...performance,event,place,date:day(performance.start),finishDate:performance.end?day(performance.end):null};
  });
}
function filterRows(rows,filters={}){
  const query=String(filters.query||'').trim().toLocaleLowerCase('en-GB');
  return rows.filter(row=>{
    const lastDate=row.finishDate||row.date;
    if(filters.from&&lastDate<filters.from)return false;
    if(filters.to&&row.date>filters.to)return false;
    if(filters.category&&row.event.category!==filters.category)return false;
    if(filters.venue&&row.place.id!==filters.venue)return false;
    if(filters.victoriaOnly&&row.place.nearestStation!=='MCV')return false;
    if(Number(filters.capacity)>0&&!(row.capacity>=Number(filters.capacity)))return false;
    return !query||[row.event.name,row.event.description,row.event.category,...(row.event.tags||[]),row.place.name,row.place.town].join(' ').toLocaleLowerCase('en-GB').includes(query);
  }).sort((a,b)=>(filters.sort==='capacity'?(b.capacity||0)-(a.capacity||0):0)||a.date.localeCompare(b.date)||String(a.timeUnknown?1:0).localeCompare(String(b.timeUnknown?1:0))||(Date.parse(a.start)-Date.parse(b.start))||a.event.name.localeCompare(b.event.name));
}
function timing(row,now=Date.now()){
  if(row.timeUnknown)return {start:row.timeUnknown,finish:'Finish not supplied',state:row.cancelled?'Cancelled performance':'Time not confirmed'};
  const start=clockFormat.format(new Date(row.start));
  const finish=row.end?'Est. finish '+clockFormat.format(new Date(row.end))+(row.finishDate!==row.date?' · '+fullFormat.format(new Date(row.end)):''):'Finish not supplied';
  const started=Date.parse(row.start)<=now;
  const state=row.cancelled?'Cancelled performance':row.soldOut?'Sold out':!started?'Scheduled':row.end?(Date.parse(row.end)<=now?'Estimated finished':'Within estimated duration'):'Started · finish unknown';
  return {start,finish,state};
}
const names={MCV:'Manchester Victoria',MAN:'Manchester Piccadilly',MCO:'Manchester Oxford Road'};
function card(row,now=Date.now()){
  const times=timing(row,now),booking=safeUrl(row.bookingUrl),website=safeUrl(row.event.website||row.place.website);
  const capacity=row.capacity!=null?Number(row.capacity).toLocaleString('en-GB'):'Not supplied';
  const address=[row.place.address,row.place.town,row.place.postcode].filter(Boolean).join(', ');
  return `<article class="event-card${row.cancelled?' event-cancelled':''}"><div class="event-card-head"><span class="event-category">${escape(row.event.category)}</span><span class="event-state">${escape(times.state)}</span></div><h3>${escape(row.event.name)}</h3><p class="event-venue">${escape(row.place.name)}</p><div class="event-performance-time"><time datetime="${escape(row.start)}">${escape(fullFormat.format(new Date(row.date+'T12:00:00Z')))} · ${escape(times.start)}</time><span>${escape(times.finish)}</span></div><dl class="event-facts"><div><dt>Listed capacity</dt><dd>${escape(capacity)}${row.capacitySource?' <small>'+escape(row.capacitySource)+'</small>':''}</dd></div><div><dt>Nearest listed station</dt><dd>${escape(names[row.place.nearestStation]||row.place.nearestStation||'Not supplied')}</dd></div></dl><details class="event-more"><summary>Event details</summary><p>${escape(row.event.description||'No description supplied.')}</p>${address?'<p>'+escape(address)+'</p>':''}${row.event.tags?.length?'<p class="detail-small">'+escape(row.event.tags.join(' · '))+'</p>':''}<div class="event-links">${website?`<a class="button" href="${escape(website)}" target="_blank" rel="noopener noreferrer">Event / venue website ↗</a>`:''}${booking?`<a class="button" href="${escape(booking)}" target="_blank" rel="noopener noreferrer">Booking information ↗</a>`:''}</div></details></article>`;
}
root.MCVEvents={day,addDays,rowsFrom,filterRows,timing,card};
if(!root.document)return;
const $=id=>root.document.getElementById(id);
const state={data:null,rows:[],error:'',checkedAt:0,busy:false,limit:24};
const active=()=>root.location.hash==='#events';
function filters(){return {from:$('events-from').value,to:$('events-to').value,query:$('events-search').value,category:$('events-category').value,venue:$('events-venue').value,victoriaOnly:$('events-victoria').checked,capacity:$('events-capacity').value,sort:$('events-sort').value};}
function render(){
  if(!active())return;
  const status=$('events-status');
  if(state.busy&&!state.data){status.textContent='Loading the latest delivered events file…';return;}
  if(!state.data){status.textContent=state.error||'No events file has been published yet.';$('events-list').innerHTML='';$('events-more').hidden=true;$('events-result-count').textContent='— performances';$('events-venue-count').textContent='— venues';$('events-finish-count').textContent='— estimated finishes';return;}
  const stale=Date.now()-Date.parse(state.data.receivedAt)>48*3600000;
  status.classList.toggle('events-warning',stale||Boolean(state.error));
  const received=new Intl.DateTimeFormat('en-GB',{timeZone:zone,dateStyle:'medium',timeStyle:'short'}).format(new Date(state.data.receivedAt));
  status.textContent=(state.error?'Refresh failed — showing last loaded file. ':stale?'The delivered file is over 48 hours old. ':'')+'Data Thistle · Manchester sample · file received '+received+'. Source snapshot publication time is not supplied.';
  const f=filters();if(f.from&&f.to&&f.from>f.to){$('events-list').innerHTML='<p class="placeholder">Choose an end date on or after the start date.</p>';$('events-more').hidden=true;return;}
  const rows=filterRows(state.rows,f);const shown=rows.slice(0,state.limit);
  $('events-result-count').textContent=rows.length.toLocaleString('en-GB')+' performances';
  $('events-venue-count').textContent=new Set(rows.map(row=>row.place.id)).size+' venues';
  $('events-finish-count').textContent=rows.filter(row=>row.end).length+' with an estimated finish';
  $('events-list').innerHTML=shown.length?shown.map(row=>card(row)).join(''):'<p class="placeholder">No performances match these filters in the supplied sample. Coverage is not exhaustive.</p>';
  $('events-more').hidden=shown.length>=rows.length;
  $('events-more').textContent='Show more ('+shown.length+' of '+rows.length+')';
}
function options(){
  const categories=[...new Set(state.rows.map(row=>row.event.category))].sort();
  const venues=[...new Map(state.rows.map(row=>[row.place.id,row.place])).values()].sort((a,b)=>a.name.localeCompare(b.name));
  for(const [id,values,placeholder] of [['events-category',categories.map(name=>({id:name,name})),'All categories'],['events-venue',venues,'All venues']]){
    const element=$(id),selected=element.value;element.innerHTML=`<option value="">${placeholder}</option>`+values.map(row=>`<option value="${escape(row.id)}">${escape(row.name)}</option>`).join('');
    if(values.some(row=>row.id===selected))element.value=selected;
  }
}
async function load(force=false){
  if(state.busy||(!force&&state.checkedAt&&Date.now()-state.checkedAt<10*60000))return;
  state.busy=true;$('events-refresh').disabled=true;render();
  try{
    const response=await root.MCVSite.fetch('https://mcv-rdm-proxy.railstaffhub.uk/events',{headers:{Accept:'application/json'},cache:'no-store',timeoutMs:20000});
    if(!response.ok)throw Error('Events feed HTTP '+response.status);
    const data=await response.json();
    if(!data.available){state.data=null;state.rows=[];state.error='Waiting for the first delivered events file. The event importer must publish it before listings appear.';}
    else {const rows=rowsFrom(data);if(!Number.isFinite(Date.parse(data.receivedAt)))throw Error('Events file time not supplied');state.data=data;state.rows=rows;state.error='';options();}
    state.checkedAt=Date.now();
  }catch(error){state.error='Unable to refresh events: '+String(error.message||error);}
  finally{state.checkedAt=Date.now();state.busy=false;$('events-refresh').disabled=false;render();}
}
function selectView(event){
  const events=active();
  if(events){render();load();}
  if(event?.type==='hashchange')root.scrollTo({top:0,behavior:'auto'});
}
function setup(){
  const today=day(Date.now());$('events-from').value=today;$('events-to').value=today;
  $('events-refresh').addEventListener('click',()=>load(true));
  $('events-more').addEventListener('click',()=>{state.limit+=24;render();});
  for(const id of ['events-search','events-from','events-to','events-category','events-venue','events-capacity','events-sort','events-victoria'])$(id).addEventListener(id==='events-search'?'input':'change',()=>{state.limit=24;render();});
  root.document.querySelectorAll('[data-events-range]').forEach(button=>button.addEventListener('click',()=>{
    const today=day(Date.now()),range=button.dataset.eventsRange;
    $('events-from').value=range==='tomorrow'?addDays(today,1):today;
    $('events-to').value=range==='future'?'':range==='week'?addDays(today,6):$('events-from').value;
    state.limit=24;render();
  }));
  root.addEventListener('hashchange',selectView);selectView();
  root.setInterval(()=>{if(active()&&!root.document.hidden){render();load();}},60000);
}
if(root.document.readyState!=='complete')root.document.addEventListener('DOMContentLoaded',setup,{once:true});else setup();
})(typeof window!=='undefined'?window:globalThis);
