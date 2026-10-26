/* Focused views share the staff board; no additional feed requests. */
(function(root){
'use strict';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const time=v=>Number.isFinite(v)?new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).format(v):'—';
const fold=v=>String(v||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim();
function currentServices(services,now=Date.now()){
 return services.filter(s=>!s.departed&&!s.recentDepartedAt&&!(s.source==='TRUST'&&!(Date.parse(s.trust?.expiresAt||'')>now)));
}
function movements(services,platform,now=Date.now()){
 return currentServices(services,now).filter(s=>platform==='all'||(platform==='unknown'?!s.platform:s.platform===platform)).flatMap(s=>{
  const rows=[];
  if(Number.isFinite(s.bookedArrivalMs))rows.push({service:s,kind:'Arrival',booked:s.bookedArrivalMs,expected:s.actualArrivalMs||s.expectedArrivalMs,actual:Number.isFinite(s.actualArrivalMs)});
  if(Number.isFinite(s.bookedMs))rows.push({service:s,kind:'Departure',booked:s.bookedMs,expected:s.actualDepartureMs||s.expectedMs,actual:Number.isFinite(s.actualDepartureMs)});
  return rows;
 }).sort((a,b)=>a.booked-b.booked||a.kind.localeCompare(b.kind));
}
function matches(services,query,includeRemoved=false,now=Date.now()){
 const q=fold(query);if(!q)return [];
 return currentServices(services,now).filter(s=>!s.ecs&&Number.isFinite(s.bookedMs)).flatMap(s=>
  (s.stops||[]).filter(p=>(includeRemoved||!p.cancelled)&&(fold(p.crs)===q||fold(p.name).includes(q))).map(point=>({service:s,point}))
 ).sort((a,b)=>a.service.bookedMs-b.service.bookedMs);
}
root.MCVExplore={movements,matches,currentServices};
if(!root.document)return;
const $=id=>document.getElementById(id);
const active=()=>['events','platform','calling-points'].includes(location.hash.slice(1))?location.hash.slice(1):'staff';
function card(s,extra){
 const units=[...new Set([...(s.arrivalUnits||[]),...(s.departureUnits||[])])];
 return '<article class="explore-card"><div class="explore-card-title"><button type="button" class="button" data-explore-service="'+esc(s.key)+'">'+esc(s.headcode||s.uid||'Service')+'</button><strong>'+esc(s.origin||'Unknown origin')+' → '+esc(s.dest)+'</strong><span>'+esc(s.ecs?'ECS':s.isCharter?'Passenger charter':'Passenger')+'</span></div>'+extra+'<p>'+esc(s.operator)+' · Platform '+esc(s.platform||'TBC')+' · '+esc(s.cancelledAtVictoria?'Cancelled at Victoria':s.status)+'</p><p class="detail-small">'+esc(units.length?'Units '+units.join(' + '):'Units not supplied')+(s.coaches?' · '+esc(s.coaches)+' carriages':'')+'</p></article>';
}
function render(){
 const view=active();if(!['platform','calling-points'].includes(view)||!root.MCVStaffViews)return;
 const data=root.MCVStaffViews.snapshot(),services=data.services;
 const status=$(view==='platform'?'platform-view-status':'explorer-status');
 status.textContent=data.lastGood?(data.current?'Updated ':'Showing last received board · ')+new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(data.lastGood)+' · Current board window only.':'Waiting for the staff board…';
 status.classList.toggle('ops-warning',!data.current);
 if(view==='platform'){
  const select=$('platform-view-select'),selected=select.value||'all';
  const values=[...new Set(['1','2','3','4','5','6',...services.map(s=>s.platform).filter(Boolean)])].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  const options='<option value="all">All platforms</option>'+values.map(p=>'<option value="'+esc(p)+'">Platform '+esc(p)+'</option>').join('')+'<option value="unknown">Platform TBC</option>';
  if(select.innerHTML!==options){select.innerHTML=options;select.value=[...values,'all','unknown'].includes(selected)?selected:'all';}
  const type=$('platform-view-type').value;
  const rows=movements(services,select.value).filter(r=>type==='all'||r.kind===type);
  $('platform-view-count').textContent=rows.length+' movements';
  $('platform-view-list').innerHTML=rows.map(r=>{
   const s=r.service,links=data.links.filter(p=>p.arrival.key===s.key||p.departure.key===s.key);
   const linkHTML=links.map(p=>{const other=p.arrival.key===s.key?p.departure:p.arrival;return '<p class="detail-small">'+esc(p.basis)+' · <button type="button" class="button" data-explore-service="'+esc(other.key)+'">'+esc(other.headcode||other.uid)+' '+esc(time(other.bookedMs||other.bookedArrivalMs))+'</button>'+ (p.minutes!=null?' · '+esc(p.minutes)+'m booked turnaround':'')+'</p>';}).join('');
   return card(s,'<p><strong>'+r.kind+' '+time(r.booked)+'</strong> · '+(r.actual?'Actual ': 'Expected ')+time(r.expected)+'</p>'+linkHTML);
  }).join('')||'<p class="placeholder">No movements for this selection in the current board window.</p>';
 }else{
  const input=$('calling-point-query'),query=input.value.trim();
  const names=[...new Set(services.filter(s=>!s.ecs).flatMap(s=>(s.stops||[]).map(p=>p.name)).filter(Boolean))].sort();
  const options=names.map(name=>'<option value="'+esc(name)+'"></option>').join('');
  if($('calling-point-options').innerHTML!==options)$('calling-point-options').innerHTML=options;
  const rows=matches(services,query,$('calling-point-removed').checked);
  $('calling-point-count').textContent=query?rows.length+' matching calls':'Choose a calling point';
  const missing=services.filter(s=>!s.ecs&&Number.isFinite(s.bookedMs)&&!s.stops?.length).length;
  $('calling-point-coverage').textContent=missing+' departures have no available onward pattern and cannot be checked. Times from booked patterns are scheduled only; they do not confirm live running.';
  $('calling-point-list').innerHTML=!query?'<p class="placeholder">Enter a station name or CRS code, e.g. Bolton or BON.</p>':rows.map(({service:s,point:p})=>card(s,'<p><strong>Victoria departure '+time(s.bookedMs)+'</strong> · Expected '+time(s.expectedMs)+'</p><p><strong>'+esc(p.name)+' '+esc(p.booked)+'</strong> · '+esc(p.cancelled?'Call cancelled / removed':s.cancelled||s.cancelledAtVictoria?'Service cancelled':s.callingPointsSource?'Booked call · live forecast not supplied':'Expected '+p.expected)+'</p><p class="detail-small">Pattern: '+esc(s.callingPointsSource||s.source)+'</p>')).join('')||'<p class="placeholder">No matching onward calls in the available board window. Missing patterns are not proof that a service does not call.</p>';
 }
}
function route(event){
 const view=active();
 for(const [name,id] of [['staff','staff-board-view'],['events','events-view'],['platform','platform-view'],['calling-points','calling-point-view']])$(id).hidden=view!==name;
 document.querySelectorAll('.mcv-site-nav a').forEach(a=>{
  const url=new URL(a.href,location.href);if(!url.pathname.endsWith('/staff.html'))return;
  const key=url.hash.slice(1)||'staff';if(key===view)a.setAttribute('aria-current','page');else a.removeAttribute('aria-current');
 });
 render();if(event?.type==='hashchange')root.scrollTo({top:0,behavior:'auto'});
}
function setup(){
 root.addEventListener('hashchange',route);
 root.addEventListener('mcv-board-render',render);
 for(const id of ['platform-view-select','platform-view-type','calling-point-removed'])$(id).addEventListener('change',render);
 $('calling-point-query').addEventListener('input',render);
 document.addEventListener('click',event=>{
  const service=event.target.closest('[data-explore-service]');
  if(service){root.MCVStaffViews.open(service.dataset.exploreService);return;}
  const a=event.target.closest('.mcv-site-nav a');if(!a||event.ctrlKey||event.metaKey||event.shiftKey||event.altKey||event.button!==0)return;
  const url=new URL(a.href,location.href);if(url.pathname!==location.pathname)return;
  event.preventDefault();if(location.hash!==url.hash)location.hash=url.hash;else route();
 });
 route();
}
if(document.readyState!=='complete')document.addEventListener('DOMContentLoaded',setup,{once:true});else setup();
})(typeof window!=='undefined'?window:globalThis);
