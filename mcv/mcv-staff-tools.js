/* Current-board comparison and a manually generated handover summary. */
(function(global){
  'use strict';
  const escape=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const stamp=value=>global.MCVRecent.dateTime(value);
  const units=(r,field)=>r?.allocation?.[field]?.join(' + ')||(r?.allocation?.status==='unallocated'?'Reported unallocated':'Not supplied');
  const label=r=>`${r.headcode||'No headcode'} · ${stamp(r.std||r.sta)} · ${r.destination||'Unknown destination'}`;
  function comparisonRows(a,b){
    const metrics=row=>{const t=global.MCVServiceReport.timingSummary(row);return {
      arrival:t.arrival.seconds===null?'Not available':global.MCVServiceReport.duration(t.arrival.seconds)+(t.arrival.seconds===0?' on time':t.arrival.seconds>0?' late':' early')+' · '+t.arrival.source,
      departure:t.departure.seconds===null?'Not available':global.MCVServiceReport.duration(t.departure.seconds)+(t.departure.seconds===0?' on time':t.departure.seconds>0?' late':' early')+' · '+t.departure.source,
      dwell:t.dwell.seconds===null?'Not available':global.MCVServiceReport.duration(t.dwell.seconds)+' · '+t.dwell.source};};
    const x=metrics(a),y=metrics(b);
    const row=(name,first,second)=>({name,first:String(first||'Not supplied'),second:String(second||'Not supplied')});
    return [row('Identity',`${a.headcode} · ${a.uid} · ${a.date}`,`${b.headcode} · ${b.uid} · ${b.date}`),
      row('Origin',a.origin,b.origin),row('Destination',a.destination,b.destination),row('Operator',a.operator,b.operator),
      row('Booked arrival',stamp(a.sta),stamp(b.sta)),row('Booked departure',stamp(a.std),stamp(b.std)),
      row('Actual arrival',stamp(a.ata),stamp(b.ata)),row('Actual departure',stamp(a.atd),stamp(b.atd)),
      row('Arrival forecast',stamp(a.eta),stamp(b.eta)),row('Departure forecast',stamp(a.etd),stamp(b.etd)),
      row('Arrival delay',x.arrival,y.arrival),row('Departure delay',x.departure,y.departure),row('Completed dwell',x.dwell,y.dwell),
      row('Platform',a.platform,b.platform),row('Arrival units',units(a,'arrivalUnits'),units(b,'arrivalUnits')),
      row('Departure units',units(a,'departureUnits'),units(b,'departureUnits')),row('Status',a.status,b.status),
      row('Reason',a.reason,b.reason),row('Calling pattern',a.callingDescription,b.callingDescription),row('Board received',stamp(a.lastSeen),stamp(b.lastSeen))];
  }
  function comparisonHTML(a,b){
    if(!a||!b)return '<p class="placeholder">Choose two services from the current board. A service that has left the board must be found in recent-service search.</p>';
    if(a.key===b.key)return '<p class="placeholder">Choose two different services to compare.</p>';
    return '<div class="comparison-scroll" tabindex="0" aria-label="Scrollable service comparison"><table class="comparison-table"><caption class="detail-small">Current board comparison · all times Europe/London · differing values highlighted</caption><thead><tr><th scope="col">Field</th><th scope="col">'+escape(label(a))+'</th><th scope="col">'+escape(label(b))+'</th></tr></thead><tbody>'+comparisonRows(a,b).map(r=>`<tr${r.first!==r.second?' class="comparison-different"':''}><th scope="row">${escape(r.name)}</th><td>${escape(r.first)}</td><td>${escape(r.second)}</td></tr>`).join('')+'</tbody></table></div>';
  }
  function handoverReport(input,now=Date.now()){
    const rows=(input.services||[]).filter(s=>!s.departed&&!(s.ata&&!s.std));
    const age=now-Date.parse(input.receivedAt),generatedAge=now-Date.parse(input.generatedAt);
    const stale=Boolean(input.error)||!Number.isFinite(age)||age<0||age>90000||!Number.isFinite(generatedAge)||generatedAge< -30000||generatedAge>90000;
    const lines=['Manchester Victoria handover summary',`Generated: ${stamp(new Date(now).toISOString())}`,`Board generated: ${stamp(input.generatedAt)}`,`Board received: ${stamp(input.receivedAt)}`,
      stale?'BOARD UPDATE OVERDUE OR UNAVAILABLE · last received information':'Board updates recent',
      `Scope: ${rows.length} listed services excluding confirmed departures and completed terminating arrivals; all board filters ignored.`,
      `Allocations: ${input.meta?.unitAllocationsAvailable===true?'available':input.meta?.unitAllocationsAvailable===false?'unavailable':'not reported'} | TRUST: ${input.meta?.trustAvailable===true?'available':input.meta?.trustAvailable===false?'unavailable':'not reported'} | Booked timetable: ${input.meta?.timetableAvailable===true?'available':input.meta?.timetableAvailable===false?'unavailable':'not reported'}`];
    const section=(title,records,describe)=>{lines.push('',`${title} (${records.length})`);if(!records.length)lines.push('None shown.');records.slice(0,40).forEach(s=>lines.push(describe(s)));if(records.length>40)lines.push(`First 40 of ${records.length} shown.`)};
    const detail=s=>`${label(s)} | Platform ${s.platform||'TBC'} | ${s.status||'Status not supplied'}${s.reason?' | '+s.reason:''}`;
    section('Cancellations',rows.filter(s=>s.cancelled),detail);
    section('Delays',rows.filter(s=>s.delayed&&!s.cancelled),detail);
    section('Alterations',rows.filter(s=>s.terminatesEarly||s.stopsRemoved||s.futureCancellation||s.routeDiverted),detail);
    section('Platform changes observed in this browser',input.platformChanges||[],s=>`${stamp(new Date(s.at).toISOString())} | ${s.message}`);
    section('No current allocated unit numbers',rows.filter(s=>!s.allocation||(!s.allocation.arrivalUnits?.length&&!s.allocation.departureUnits?.length)),s=>`${label(s)} | ${s.allocationDescription||'No current unit numbers supplied'}`);
    section('No onward calling pattern',rows.filter(s=>s.std&&!s.cancelled&&!s.callingCount),s=>`${label(s)} | ${s.callingDescription||'Upstream reason not supplied'}`);
    lines.push('','Snapshot generated manually; later changes are not included. Platform changes cover this browser session only. All times Europe/London.');
    return lines.join('\n');
  }
  let getInput=()=>({services:[]}),keys=['',''];
  const $=id=>document.getElementById(id);
  function refresh(){
    if(typeof document==='undefined'||!$('comparison-body')||$('comparison-body').hidden)return;
    const input=getInput(),services=input.services||[];
    for(let i=0;i<2;i++){
      const select=$('compare-'+i),available=services.some(s=>s.key===keys[i]);
      const html='<option value="">Choose a service</option>'+(!available&&keys[i]?`<option value="${escape(keys[i])}">Service no longer in current board</option>`:'')+services.map(s=>`<option value="${escape(s.key)}">${escape(label(s))}</option>`).join('');
      if(select._options!==html){select.innerHTML=html;select._options=html}select.value=keys[i];
    }
    const html=comparisonHTML(...keys.map(key=>services.find(s=>s.key===key)));
    if($('comparison-results')._html!==html){$('comparison-results').innerHTML=html;$('comparison-results')._html=html}
    $('comparison-age').textContent='Board received '+stamp(input.receivedAt)+(input.error||Date.now()-Date.parse(input.receivedAt)>90000?' · update overdue':'');
  }
  function compareService(key){
    if(!keys.includes(key)){if(!keys[0])keys[0]=key;else keys[1]=key}
    $('comparison-body').hidden=false;$('comparison-toggle').setAttribute('aria-expanded','true');$('comparison-toggle').textContent='Hide comparison ▴';refresh();
    $('comparison-body').scrollIntoView({behavior:'smooth',block:'start'});
  }
  function configure(fn){getInput=fn}
  global.MCVStaffTools=Object.freeze({comparisonRows,comparisonHTML,handoverReport,configure,refresh,compareService});
  if(typeof document==='undefined'||!$('comparison-toggle'))return;
  $('comparison-toggle').addEventListener('click',()=>{const open=$('comparison-body').hidden;$('comparison-body').hidden=!open;$('comparison-toggle').setAttribute('aria-expanded',String(open));$('comparison-toggle').textContent=open?'Hide comparison ▴':'Compare services ▾';refresh()});
  for(let i=0;i<2;i++)$('compare-'+i).addEventListener('change',e=>{keys[i]=e.target.value;refresh()});
  $('compare-clear').addEventListener('click',()=>{keys=['',''];refresh()});
  $('handover-toggle').addEventListener('click',()=>{const open=$('handover-body').hidden;$('handover-body').hidden=!open;$('handover-toggle').setAttribute('aria-expanded',String(open));$('handover-toggle').textContent=open?'Hide handover ▴':'Show handover ▾'});
  $('handover-generate').addEventListener('click',()=>{const input=getInput();if(!input.receivedAt){$('handover-status').textContent='Waiting for the first board response.';return}$('handover-text').value=handoverReport(input);$('handover-copy').disabled=false;$('handover-status').textContent='Summary generated from the current board. Copy it or regenerate after an update.'});
  $('handover-copy').addEventListener('click',async()=>{const area=$('handover-text');if(!area.value)return;try{await global.navigator.clipboard.writeText(area.value);$('handover-status').textContent='Handover summary copied.'}catch{area.focus();area.select();$('handover-status').textContent='Automatic copy unavailable. Select and copy the summary manually.'}});
})(typeof window!=='undefined'?window:globalThis);
