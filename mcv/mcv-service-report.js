/* Shared timing calculations and reports for observed services. */
(function(global){
  'use strict';
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const london=new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  function wallTime(ms){const p=Object.fromEntries(london.formatToParts(new Date(ms)).map(p=>[p.type,p.value]));return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`}
  function instant(value){
    if(typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)?$/.test(value))return null;
    const local=value.match(/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d)?/)[0];
    const text=local.length===16?local+':00':local;
    const utc=Date.parse(text+'Z');
    if(!Number.isFinite(utc)||new Date(utc).toISOString().slice(0,19)!==text)return null;
    if(/(?:Z|[+-]\d\d:\d\d)$/.test(value)){const t=Date.parse(value);return Number.isFinite(t)?t:null}
    // Bare Darwin datetimes mean London wall time. Never guess a clock-only
    // date or which occurrence of a repeated autumn clock was intended.
    const candidates=[utc,utc-3600000].filter(ms=>wallTime(ms)===text);
    return candidates.length===1?candidates[0]:null;
  }
  function duration(seconds){
    const value=Math.round(Math.abs(seconds)),h=Math.floor(value/3600),m=Math.floor(value%3600/60),s=value%60;
    return [h?h+'h':'',m?m+'m':'',s?s+'s':''].filter(Boolean).join(' ')||'0s';
  }
  function delay(actual,booked){const a=instant(actual),b=instant(booked);return a===null||b===null||Math.abs(a-b)>43200000?null:Math.round((a-b)/1000)}
  const delayText=value=>value===null?'Not available':value===0?'On time':duration(value)+(value>0?' late':' early');
  function completedDwell(arrival,departure){const a=instant(arrival),d=instant(departure);return a===null||d===null||d<a||d-a>43200000?null:Math.round((d-a)/1000)}
  function timingSummary(row){
    const events=row.history?.reconciliationRequired?[]:(row.history?.events||[]);
    const report=kind=>{const matches=events.filter(e=>e.kind===kind&&e.timeBasis==='actual'&&e.tiploc==='MNCRVIC');return matches.length===1?matches[0].at:''};
    const trustArrival=report('arrival'),trustDeparture=report('departure');
    const a=delay(row.ata,row.sta),d=delay(row.atd,row.std),ta=delay(trustArrival,row.sta),td=delay(trustDeparture,row.std);
    const ownDwell=completedDwell(row.ata,row.atd),trustDwell=completedDwell(trustArrival,trustDeparture);
    return {arrival:{seconds:a??ta,source:a!==null?row.source:ta!==null?'TRUST':''},
      departure:{seconds:d??td,source:d!==null?row.source:td!==null?'TRUST':''},
      dwell:{seconds:ownDwell??trustDwell,source:ownDwell!==null?row.source:trustDwell!==null?'TRUST':''}};
  }
  function summaryHTML(row){
    const t=timingSummary(row);
    const item=(label,metric,isDwell=false)=>`<div class="ops-metric"><div class="label">${label}</div><div class="value">${escape(metric.seconds===null?'Not available':isDwell?duration(metric.seconds):delayText(metric.seconds))}</div><div class="sub">${escape(metric.source?metric.source+(isDwell?' actual arrival → departure':' actual vs booked Victoria time'):'Matched actual timings required')}</div></div>`;
    return `<section class="detail-group"><h3>Booked vs actual at Victoria</h3><div class="ops-metrics">${item('Arrival delay',t.arrival)}${item('Departure delay',t.departure)}${item('Completed dwell',t.dwell,true)}</div><p class="detail-small">Derived from supplied actuals or unique matched Victoria reports. Forecasts are excluded; dwell uses arrival and departure from the same source.</p></section>`;
  }
  function unitButtons(units){return (units||[]).filter(unit=>/^\d{6}$/.test(unit)).map(unit=>`<button type="button" class="button unit-history-link" data-unit-history="${unit}" aria-label="Search captured workings for unit ${unit}">${unit}</button>`).join(' + ')}
  function serviceReport(row){
    const format=global.MCVRecent?.dateTime||String,t=timingSummary(row),a=row.allocation;
    const units=field=>a?.[field]?.length?a[field].join(' + '):a?.status==='unallocated'?'Reported unallocated':'Not captured';
    const metric=(item,isDwell=false)=>(item.seconds===null?'Not available':isDwell?duration(item.seconds):delayText(item.seconds))+(item.source?' ('+item.source+')':'');
    const lines=['Manchester Victoria service report',`${row.headcode||'Headcode not supplied'} | UID ${row.uid||'not supplied'} | Service date ${row.date||'not supplied'}`,
      `${row.origin||'Unknown origin'} → ${row.destination||'Unknown destination'}`,
      `Source: ${row.source||'Not supplied'} | ${row.live?'Board received':'Last captured'}: ${format(row.lastSeen)}`,
      `Cancellation shown at capture: ${row.cancelled?'Yes':'No'}`,`Platform at capture: ${row.platform||'Not captured'}`,
      `Booked arrival: ${format(row.sta)}`,`Booked departure: ${format(row.std)}`,
      `Actual arrival captured (${row.source}): ${format(row.ata)}`,`Actual departure captured (${row.source}): ${format(row.atd)}`,
      `Arrival forecast at capture: ${format(row.eta)}`,`Departure forecast at capture: ${format(row.etd)}`,
      `Arrival delay: ${metric(t.arrival)}`,`Departure delay: ${metric(t.departure)}`,`Completed dwell: ${metric(t.dwell,true)}`,
      `Arrival units (Gemini): ${units('arrivalUnits')}`,`Departure units (Gemini): ${units('departureUnits')}`];
    if(a)lines.push(`Allocation captured: ${format(a.capturedAt)}`);
    lines.push('','Captured TRUST journey reports:');
    if(row.history){
      lines.push(`History captured: ${format(row.history.capturedAt)}`);
      if(row.history.reconciliationRequired)lines.push('Some reports withheld following a route or identity correction.');
      for(const e of row.history.events)lines.push(`${e.kind.replace(/-/g,' ')}${e.locationName?' · '+e.locationName:''} | ${e.timeBasis==='received'?'Received':'Reported'} ${format(e.at)}${e.delaySeconds!=null?' | '+delayText(e.delaySeconds)+' vs working timetable':''}${e.platform?' | Reported platform '+e.platform:''}`);
    }else lines.push('No matched reports captured.');
    lines.push('','All times Europe/London. Captured observations may have gaps or later changes. Forecasts are not actuals. Unit search shows captured allocations, not a confirmed stock diagram.');
    return lines.join('\n');
  }
  function actionsHTML(id=''){return `<div class="service-report-actions"><button type="button" class="button" data-copy-service-report="${escape(id)}">Copy service report</button><span class="detail-small" role="status" data-copy-status></span><div data-report-fallback hidden><label class="detail-small">Copy manually<textarea class="service-report-text" readonly aria-label="Service report to copy"></textarea></label></div></div>`}
  async function copyReport(row,root){
    const text=serviceReport(row),status=root.querySelector('[data-copy-status]'),fallback=root.querySelector('[data-report-fallback]');
    try{await global.navigator.clipboard.writeText(text);fallback.hidden=true;status.textContent='Service report copied.'}
    catch{fallback.hidden=false;const area=fallback.querySelector('textarea');area.value=text;area.focus();area.select();status.textContent='Automatic copy unavailable. Select and copy the report below.'}
  }
  global.MCVServiceReport=Object.freeze({instant,duration,delay,completedDwell,timingSummary,summaryHTML,unitButtons,serviceReport,actionsHTML,copyReport});
})(typeof window!=='undefined'?window:globalThis);
