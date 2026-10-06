/* Shared navigation, feed health and bounded requests for the MCV screens. */
(function(global){
  'use strict';
  const RELEASE='2026.10.06.3';
  const REQUEST_TIMEOUT=12000;
  const pending=new Map();
  const health={receivedAt:0,generatedAt:0,error:false,meta:null,feedName:'Darwin Feed'};
  const page=(location.pathname.split('/').pop()||'index.html').toLowerCase();
  const unattended=/^(?:platform(?:\d+)?|nexttrain\d+|staff-platform|full|old|old-dep)\.html$/.test(page);
  const staff=/^(?:staff|staff-platform|assist|assist-desktop|control|accessibility|disruption)\.html$/.test(page);
  const boardURL=url=>url.origin==='https://mcv-rdm-proxy.railstaffhub.uk'&&/^\/(?:staff-)?departures\/?$/.test(url.pathname);
  const legacyBoardURL=url=>url.origin==='https://api.traini.ac'&&url.pathname==='/api/departures/MCV';
  function ageText(stamp){
    const seconds=Math.max(0,Math.floor((Date.now()-stamp)/1000));
    return seconds<60?seconds+'s ago':Math.floor(seconds/60)+'m ago';
  }
  function reportBoard(data,source='Darwin Feed'){
    if(!data||(!Array.isArray(data.trainServices)&&!(source==='Traini Feed'&&Array.isArray(data.results))))return;
    health.receivedAt=Date.now();
    health.generatedAt=Date.parse(data.generatedAt||data.generated_at||'')||0;
    health.error=false;
    health.feedName=source;
    if(data._mcv)health.meta=data._mcv;
    renderHealth();
  }
  function reportFallback(data,receivedAt){
    if(!data||!Array.isArray(data.trainServices)||!Number.isFinite(receivedAt))return;
    health.receivedAt=receivedAt;
    health.generatedAt=Date.parse(data.generatedAt||data.generated_at||'')||0;
    health.meta=data._mcv||null;
    health.error=true;
    renderHealth();
  }
  function healthSnapshot(now=Date.now()){
    const offline=navigator.onLine===false;
    const stamp=health.generatedAt||health.receivedAt;
    const stale=health.receivedAt>0&&(now-health.receivedAt>90000||now-stamp>90000||stamp>now+60000);
    const darwin=!health.receivedAt?'Waiting for data':offline?'Offline · last update '+ageText(health.receivedAt):stale?'Stale · last update '+ageText(stamp):health.error?'Refresh failed · last update '+ageText(health.receivedAt):'Updated '+ageText(stamp);
    const meta=health.meta;
    const synced=Date.parse(meta?.unitSnapshotAt||'');
    let gemini='Waiting for snapshot';
    if(meta){
      if(meta.unitReaderRunning===false)gemini='Reader offline';
      else if(Number.isFinite(synced)&&(now-synced>360000||synced>now))gemini='Stale · last update '+ageText(synced);
      else if(meta.unitAllocationsAvailable===false)gemini='Unavailable';
      else if(Number.isFinite(synced))gemini='Updated '+ageText(synced);
      else gemini='Snapshot not supplied';
    }
    return {darwin,gemini,warning:offline||stale||health.error,stale,offline,hasData:health.receivedAt>0};
  }
  // Coalesce identical GETs only when callers do not provide independent cancellation.
  // Read the response body inside the deadline, then give each caller its own clone.
  function request(input,options={}){
    const url=new URL(typeof input==='string'?input:input.url,location.href);
    const method=String(options.method||(typeof input!=='string'&&input.method)||'GET').toUpperCase();
    const sourceSignal=options.signal||(typeof input!=='string'?input.signal:null);
    const headers=new Headers(options.headers||(typeof input!=='string'?input.headers:undefined));
    const timeoutMs=Number(options.timeoutMs)>0?Number(options.timeoutMs):REQUEST_TIMEOUT;
    const key=method==='GET'&&!sourceSignal?JSON.stringify([url.href,Array.from(headers.entries()),options.credentials||'same-origin',timeoutMs]):null;
    if(key&&pending.has(key))return pending.get(key).then(response=>response.clone());
    const work=(async()=>{
      const controller=new AbortController();
      const abort=()=>controller.abort();
      if(sourceSignal){if(sourceSignal.aborted)abort();else sourceSignal.addEventListener('abort',abort,{once:true});}
      const timer=setTimeout(abort,timeoutMs);
      try{
        const opts=Object.assign({},options,{signal:controller.signal});
        delete opts.timeoutMs;
        const response=await global.fetch(input,opts);
        const text=await response.clone().text();
        if(boardURL(url)||legacyBoardURL(url)){
          if(!response.ok){health.error=true;renderHealth();}
          else{
            let data;
            try{data=JSON.parse(text);}catch(_){health.error=true;renderHealth();}
            if(data&&(Array.isArray(data.trainServices)||(legacyBoardURL(url)&&Array.isArray(data.results))))reportBoard(data,legacyBoardURL(url)?'Traini Feed':'Darwin Feed');
            else {health.error=true;renderHealth();}
          }
        }
        return response;
      }catch(error){
        if((boardURL(url)||legacyBoardURL(url))&&!sourceSignal?.aborted){health.error=true;renderHealth();}
        throw error;
      }finally{
        clearTimeout(timer);
        sourceSignal?.removeEventListener('abort',abort);
      }
    })();
    if(key){pending.set(key,work);work.then(()=>pending.delete(key),()=>pending.delete(key));}
    return work.then(response=>response.clone());
  }
  function renderHealth(){
    const snapshot=healthSnapshot();
    const panel=document.getElementById('mcv-feed-health');
    if(panel){
      const darwin=panel.querySelector('[data-feed="darwin"]');
      const gemini=panel.querySelector('[data-feed="gemini"]');
      darwin.textContent=health.feedName+' · '+snapshot.darwin;
      darwin.classList.toggle('mcv-feed-warning',snapshot.warning);
      if(gemini){gemini.textContent='Gemini Feed · '+snapshot.gemini;gemini.classList.toggle('mcv-feed-warning',!/^(?:Updated|Waiting)/.test(snapshot.gemini));}
    }
    const warning=document.getElementById('mcv-stale-warning');
    if(warning){
      warning.hidden=!snapshot.warning;
      const updated=snapshot.hasData?new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(health.receivedAt):'';
      const message=(snapshot.offline?'OFFLINE':snapshot.stale?'LIVE DATA STALE':'LIVE UPDATE FAILED')+' · '+(snapshot.hasData?'Showing the last received board · last update '+updated:'Live information unavailable');
      if(warning.textContent!==message)warning.textContent=message;
    }
  }
  function setup(){
    document.documentElement.dataset.mcvRelease=RELEASE;
    if(!unattended)document.body.dataset.mcvInteractive='true';
    const skip=document.createElement('a');skip.className='mcv-skip-link';skip.href='#mcv-main-content';skip.textContent='Skip to content';
    const main=document.querySelector('main,.container,.main,.board-wrap,.board')||document.body;
    if(main!==document.body){
      if(!main.id)main.id='mcv-main-content';
      skip.href='#'+main.id;
      if(!main.hasAttribute('tabindex'))main.tabIndex=-1;
      document.body.prepend(skip);
    }
    document.querySelectorAll('a[href="index.html"]').forEach(link=>{link.title='Home · Manchester Victoria';if(link.querySelector('img'))link.setAttribute('aria-label','Home · Manchester Victoria');});
    const release=document.createElement('span');release.className='mcv-release';release.textContent='v'+RELEASE;release.title='Display release '+RELEASE;
    const footer=document.querySelector('footer,.foot,.bottom,.footer');
    if(footer)footer.append(release);
    else {release.classList.add('mcv-release-corner');document.body.append(release);}
    if(!unattended&&page!=='index.html'){
      const nav=document.createElement('nav');nav.className='mcv-site-nav';nav.setAttribute('aria-label','Site navigation');
      for(const [href,label] of [['index.html','Home'],['tools.html','Tools'],['staff.html','Staff display']]){
        const a=document.createElement('a');a.href=href;a.textContent=label;if(page===href)a.setAttribute('aria-current','page');nav.append(a);
      }
      const header=document.querySelector('header,.top');
      if(header)header.insertAdjacentElement('afterend',nav);else document.body.prepend(nav);
    }
    if(staff){
      const panel=document.createElement('div');panel.id='mcv-feed-health';panel.className='mcv-feed-health';panel.setAttribute('aria-label','Live feed health');
      panel.innerHTML='<span data-feed="darwin">Darwin Feed · Waiting for data</span>'+(page==='staff.html'||page==='staff-platform.html'?'<span data-feed="gemini">Gemini Feed · Waiting for snapshot</span>':'');
      if(unattended){panel.classList.add('mcv-health-compact');const host=document.querySelector('footer,.footer');if(host)host.append(panel);else document.body.append(panel);}
      else {const host=document.querySelector('.mcv-site-nav,header,.top');if(host)host.insertAdjacentElement('afterend',panel);else document.body.prepend(panel);}
    }
    const warning=document.createElement('div');warning.id='mcv-stale-warning';warning.className='mcv-stale-warning';warning.setAttribute('role','status');warning.hidden=true;document.body.append(warning);
    renderHealth();
    setInterval(renderHealth,5000);
    global.addEventListener('online',renderHealth);global.addEventListener('offline',renderHealth);
  }
  global.MCVSite={release:RELEASE,fetch:request,reportBoard,reportFallback,healthSnapshot};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',setup,{once:true});else setup();
})(window);
