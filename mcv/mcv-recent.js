/* Recent observations are historical records, not live service forecasts. */
(function(global){
  'use strict';
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const dateTime=value=>{
    if(!value)return 'Not captured';
    // Offset-free Darwin values already represent London wall time.
    if(/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?$/.test(value))return value.replace('T',' ');
    if(!/(?:Z|[+-]\d\d:\d\d)$/.test(value)||!Number.isFinite(Date.parse(value)))return String(value);
    return new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',day:'2-digit',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(new Date(value));
  };
  function recordHTML(row){
    const h=row.history,a=row.allocation;
    const pair=(label,value)=>`<dt>${escape(label)}</dt><dd>${escape(value)}</dd>`;
    const units=field=>a?.[field]?.length?a[field].join(' + '):a?.status==='unallocated'?'Reported unallocated':'Not captured';
    return `<details class="recent-record"><summary><strong>${escape(row.headcode)} · ${escape(row.uid)}</strong> · ${escape(dateTime(row.std||row.sta))}<br><span>${escape(row.origin||'Unknown origin')} → ${escape(row.destination||'Unknown destination')}${row.cancelled?' · Cancellation shown at capture':''}</span></summary><div class="recent-record-body">
      <p class="detail-small">Historical observation · ${escape(row.source)} · Last captured ${escape(dateTime(row.lastSeen))}. Later changes may be missing.</p>
      <dl class="recent-facts">${pair('Service date',row.date)}${pair('Booked arrival',dateTime(row.sta))}${pair('Booked departure',dateTime(row.std))}${pair('Actual arrival captured',dateTime(row.ata))}${pair('Actual departure captured',dateTime(row.atd))}${pair('Arrival forecast at capture',dateTime(row.eta))}${pair('Departure forecast at capture',dateTime(row.etd))}${pair('Platform at capture',row.platform||'Not captured')}${pair('Arrival units (Gemini)',units('arrivalUnits'))}${pair('Departure units (Gemini)',units('departureUnits'))}${a?pair('Allocation captured',dateTime(a.capturedAt)):''}</dl>
      <details class="recent-history"><summary>Captured TRUST journey reports${h?' ('+h.events.length+')':''}</summary>${h?`<p class="detail-small">Captured ${escape(dateTime(h.capturedAt))}. Reporting-point history can have gaps. Lifecycle times are receipt times.${h.reconciliationRequired?' Some reports were withheld following a route or identity correction.':''}</p><ol>${h.events.map(e=>`<li><strong>${escape(e.kind.replace(/-/g,' '))}</strong>${e.locationName?' · '+escape(e.locationName):''} · ${e.timeBasis==='received'?'Received':'Reported'} ${escape(dateTime(e.at))}${e.delaySeconds!=null?' · '+escape(e.delaySeconds===0?'On working timetable':Math.abs(e.delaySeconds)+'s '+(e.delaySeconds>0?'late':'early')+' vs working timetable'):''}${e.platform?' · Reported platform '+escape(e.platform):''}</li>`).join('')}</ol>`:'<p>No matched TRUST reports were captured for this service.</p>'}</details>
    </div></details>`;
  }
  global.MCVRecent=Object.freeze({recordHTML,dateTime});
  if(typeof document==='undefined')return;
  const $=id=>document.getElementById(id);
  const toggle=$('recent-toggle');if(!toggle)return;
  let busy=false,nextOffset=null,query='',date='';
  toggle.addEventListener('click',()=>{const open=toggle.getAttribute('aria-expanded')!=='true';toggle.setAttribute('aria-expanded',String(open));$('recent-body').hidden=!open;toggle.textContent=open?'Hide search ▴':'Show search ▾';if(open)$('recent-query').focus()});
  async function search(more=false){
    if(busy)return;
    if(!more){query=$('recent-query').value.trim().toUpperCase();date=$('recent-date').value;nextOffset=null;$('recent-results').innerHTML=''}
    if(!/^[A-Z0-9]{2,40}$/.test(query)){$('recent-status').textContent='Enter at least two letters or digits of a headcode, UID or unit number.';return}
    busy=true;$('recent-submit').disabled=true;$('recent-more').disabled=true;$('recent-status').textContent='Searching captured services…';
    try{
      const params=new URLSearchParams({q:query,date,offset:String(more?nextOffset:0)});
      const response=await MCVSite.fetch('https://mcv-rdm-proxy.railstaffhub.uk/recent-services?'+params,{method:'GET',cache:'no-store',headers:{Accept:'application/json'}});
      if(!response.ok)throw Error('unavailable');
      const data=await response.json();
      if(data.version!==1||!Array.isArray(data.services))throw Error('unexpected');
      if(!data.available){$('recent-status').textContent='The recent-service archive has not been published yet. The updated Worker and server publisher are required.';nextOffset=null;return}
      const content=data.services.map(recordHTML).join('');
      if(more)$('recent-results').insertAdjacentHTML('beforeend',content);else $('recent-results').innerHTML=content;
      nextOffset=data.nextOffset;
      $('recent-status').textContent=`${data.total} matching service${data.total===1?'':'s'}. Archive updated ${dateTime(data.updatedAt)}${data.stale?' · Update overdue; showing the last published archive':''}. Capture started ${dateTime(data.startedAt)}. Last 48 hours, up to 1,200 captured services; earlier or unobserved services may be missing. All times Europe/London; date filter uses the service date.`;
    }catch{$('recent-status').textContent='Recent-service search is unavailable. Check that the matching Worker and publisher are deployed, then try again.';nextOffset=null}
    finally{busy=false;$('recent-submit').disabled=false;$('recent-more').disabled=false;$('recent-more').hidden=nextOffset==null}
  }
  $('recent-form').addEventListener('submit',event=>{event.preventDefault();search()});
  $('recent-more').addEventListener('click',()=>{if(nextOffset!=null)search(true)});
})(typeof window!=='undefined'?window:globalThis);
