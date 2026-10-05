/* Manchester Victoria: changes observed by THIS page only. No cross-device signalling. */
(()=>{
  'use strict';
  const screen=location.pathname.split('/').pop().toLowerCase();
  const isPassenger=/^(?:platform(?:[1-6]|12|45)?|nexttrain[1-6])\.html$/.test(screen);
  // Platform changes are now shown inline on the affected service, never as a
  // floating overlay that can cover passenger information.
  const SHOW_OVERLAY=false;
  const MAX_AGE=6*60*1000;
  const memory=new Map(), changes=[];
  let firstSnapshot=false, visibleId='', rotateAt=0, panel, title, message;
  const normalizePlatform=s=>String(s??'').toUpperCase().replace(/^\s*PLATFORM\s*/,'').replace(/\s+/g,'');
  const validPlatform=s=>/^[1-6](?:[AB])?$/.test(s);
  const fmt=ms=>Number.isFinite(ms)?new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',hour:'2-digit',minute:'2-digit'}).format(new Date(ms)):'—';
  const safeId=raw=>{
    // Never equate separate trains using only an unqualified headcode.
    const id=raw.train_id!=null?String(raw.train_id).trim():String(raw.train_uid||'').trim();
    const booked=String(raw.departs||'');
    const time=Date.parse(booked);
    return id && Number.isFinite(time) ? [id,time,String(raw.destination?.crs||raw.destination?.name||raw.destination_name||'').toUpperCase()].join('|') : '';
  };
  const fileTargets=(change)=>{
    const result=new Set(['platform.html']);
    for(const p of [change.from,change.to]){
      const n=Number(String(p).charAt(0));
      if(n>=1&&n<=6){result.add(`platform${n}.html`);result.add(`nexttrain${n}.html`);}
      if(n===1||n===2)result.add('platform12.html');
      if(n===4||n===5)result.add('platform45.html');
    }
    return [...result];
  };
  function readChanges(){return changes.filter(c=>Date.now()-c.at<MAX_AGE).slice().sort((a,b)=>b.at-a.at).map(x=>({...x,targets:fileTargets(x)}));}
  function observe(rows){
    if(!Array.isArray(rows))return;
    const now=Date.now();
    for(const raw of rows){
      if(raw?.not_for_display===true)continue;
      const status=String(raw.status||'').toLowerCase();
      const text=String(raw.status_text||'').toLowerCase();
      if(status==='departed'||status==='cancelled'||/^(departed|cancelled)/.test(text)){
        const departedKey=safeId(raw);
        if(departedKey){for(let i=changes.length-1;i>=0;i--)if(changes[i].key===departedKey)changes.splice(i,1);memory.delete(departedKey);}
        continue;
      }
      if(['freight','trip','empty stock'].includes(String(raw.service_class||'').toLowerCase()))continue;
      const key=safeId(raw); if(!key)continue;
      const p=normalizePlatform(raw.platform_withheld?'':raw.platform);
      const prior=memory.get(key);
      // A genuinely reported allocation -> different reported allocation.
      // Initial allocation (TBC -> 2) is not classified as a platform change.
      if(firstSnapshot && prior && validPlatform(prior.platform) && validPlatform(p) && p!==prior.platform){
        const change={id:key+'|'+prior.platform+'|'+p, key, at:now,
          trainId:raw.train_id==null?'':String(raw.train_id),
          bookedAt:Date.parse(raw.departs),booked:fmt(Date.parse(raw.departs)),
          destination:String(raw.destination?.name||raw.destination_name||'Unknown').replace(/^salford$/i,'SALFORD CENTRAL').toUpperCase(),
          headcode:String(raw.headcode||'').toUpperCase(),from:prior.platform,to:p};
        if(!changes.some(c=>c.id===change.id)){for(let i=changes.length-1;i>=0;i--)if(changes[i].key===change.key)changes.splice(i,1);changes.unshift(change);if(changes.length>35)changes.length=35;
          window.dispatchEvent(new CustomEvent('mcv:platform-change',{detail:{...change,targets:fileTargets(change)}}));}
      }
      if(validPlatform(p)) memory.set(key,{platform:p,lastSeen:now});
      // Missing/withheld allocation must not erase the last confirmed allocation.
    }
    firstSnapshot=true;
    for(const [k,v] of memory)if(now-v.lastSeen>30*60*1000)memory.delete(k);
    for(let i=changes.length-1;i>=0;i--)if(now-changes[i].at>MAX_AGE)changes.splice(i,1);
    show();
  }
  function ensureUI(){
    if(!isPassenger||!SHOW_OVERLAY||panel||!document.body)return;
    const css=document.createElement('style');
    css.textContent=`#mcv-observed-alteration{position:fixed;left:50%;transform:translateX(-50%);bottom:190px;width:min(1100px,calc(100vw - 36px));z-index:2147483590;box-sizing:border-box;background:#fff;color:#262262;border:2px solid #262262;border-left:12px solid #ffbd1c;box-shadow:0 7px 32px #0005;border-radius:7px;padding:13px 19px;display:flex;gap:15px;align-items:center;pointer-events:none;font:700 clamp(16px,1.5vw,25px)/1.3 'Bunday Clean',Arial,sans-serif}#mcv-observed-alteration[hidden]{display:none!important}#mcv-observed-alteration strong{font-size:.68em;letter-spacing:.04em;background:#ffbd1c;color:#262262;padding:7px 9px;border-radius:3px;white-space:nowrap}#mcv-observed-alteration span{overflow-wrap:anywhere}@media(max-width:700px){#mcv-observed-alteration{bottom:155px;width:calc(100vw - 16px);gap:8px;padding:10px;font-size:15px;flex-wrap:wrap}}`;
    document.head.appendChild(css);
    panel=document.createElement('div');panel.id='mcv-observed-alteration';panel.hidden=true;
    panel.setAttribute('role','status');title=document.createElement('strong');title.textContent='CHECK PLATFORM';
    message=document.createElement('span');panel.append(title,message);document.body.appendChild(panel);
  }
  function show(){
    if(!isPassenger||!SHOW_OVERLAY)return;
    ensureUI();if(!panel)return;
    const relevant=readChanges().filter(c=>c.targets.includes(screen));
    if(!relevant.length){panel.hidden=true;visibleId='';return;}
    let chosen=relevant.find(c=>c.id===visibleId);
    if(!chosen||Date.now()>=rotateAt){const idx=chosen?relevant.findIndex(c=>c.id===chosen.id):-1;chosen=relevant[(idx+1)%relevant.length];visibleId=chosen.id;rotateAt=Date.now()+16000;}
    message.textContent=`${chosen.booked} TO ${chosen.destination}: LIVE DATA NOW SHOWS PLATFORM ${chosen.to} (PREVIOUSLY ${chosen.from}). PLEASE CONFIRM USING OFFICIAL STATION INFORMATION.`;
    panel.hidden=false;
  }
  window.MCVPlatformAlerts={observe,recent:readChanges,targetsFor:fileTargets,normalizePlatform};
  if(isPassenger){if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',show,{once:true});else show();setInterval(show,1000);}
})();
