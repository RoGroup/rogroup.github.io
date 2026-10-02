/* GitHub Pages only. Reads committed notices.json; no server and no device tracking. */
(()=>{
  'use strict';
  const screen=location.pathname.split('/').pop().toLowerCase();
  if(!/^(?:platform(?:[1-6]|12|45)?|nexttrain[1-6])\.html$/.test(screen))return;
  const priorities={urgent:0,warning:1,info:2};
  let notices=[],displayedId='',panel,label,body,rotateAt=0;
  const style=document.createElement('style');
  style.textContent=`#mcv-static-notice{position:fixed;bottom:75px;left:50%;transform:translateX(-50%);width:min(1110px,calc(100vw - 42px));box-sizing:border-box;z-index:2147483600;background:#fff;border:2px solid #262262;border-left:11px solid #0698d6;border-radius:7px;box-shadow:0 8px 35px rgba(0,0,0,.32);color:#262262;padding:14px 22px;display:flex;gap:18px;align-items:center;pointer-events:none;font:700 clamp(17px,1.5vw,26px)/1.32 'Bunday Clean',Arial,sans-serif}#mcv-static-notice[hidden]{display:none!important}#mcv-static-label{flex:none;font-size:.65em;letter-spacing:.08em;text-transform:uppercase;border-radius:3px;padding:7px 10px;background:#0698d6;color:white}#mcv-static-notice.mcv-warning{border-left-color:#ffbd1c}#mcv-static-notice.mcv-warning #mcv-static-label{background:#ffbd1c;color:#262262}#mcv-static-notice.mcv-urgent{border-left-color:#eb0040}#mcv-static-notice.mcv-urgent #mcv-static-label{background:#eb0040;color:white}@media(max-width:720px){#mcv-static-notice{bottom:65px;width:calc(100vw - 20px);padding:12px;gap:9px;font-size:15px;flex-wrap:wrap}}`;
  document.head.appendChild(style);
  function ensurePanel(){if(panel||!document.body)return;panel=document.createElement('div');panel.id='mcv-static-notice';panel.hidden=true;panel.setAttribute('role','status');label=document.createElement('span');label.id='mcv-static-label';body=document.createElement('span');body.id='mcv-static-body';panel.append(label,body);document.body.appendChild(panel);}
  function show(){ensurePanel();if(!panel)return;const current=notices.filter(n=>n&&typeof n.message==='string'&&n.message.length>=5&&n.message.length<=270&&Array.isArray(n.targets)&&n.targets.includes(screen)&&Number.isFinite(Date.parse(n.expires_at))&&Date.parse(n.expires_at)>Date.now()&&['info','warning','urgent'].includes(n.kind));
    if(!current.length){panel.hidden=true;displayedId='';return;}
    current.sort((a,b)=>(priorities[a.kind]??4)-(priorities[b.kind]??4)||Date.parse(a.created_at)-Date.parse(b.created_at));
    let selected=current.find(n=>n.id===displayedId);
    if(!selected||Date.now()>=rotateAt){const idx=selected?current.findIndex(n=>n.id===selected.id):-1;selected=current[(idx+1)%current.length];rotateAt=Date.now()+14000;}
    displayedId=selected.id;panel.className=selected.kind==='urgent'?'mcv-urgent':selected.kind==='warning'?'mcv-warning':'';label.textContent=selected.kind==='urgent'?'IMPORTANT':selected.kind==='warning'?'TRAVEL NOTICE':'INFORMATION';body.textContent=selected.message;panel.hidden=false;}
  async function update(){try{const res=await fetch('./notices.json?_='+Date.now(),{cache:'no-store'});if(!res.ok)throw Error('Unable to fetch notices.json');const data=await res.json();if(!Array.isArray(data.notices))throw Error('Invalid notice file');notices=data.notices;show();}catch(_){/* Keep prior notices only until their individual expiry. */show();}}
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',update,{once:true});else update();
  setInterval(update,30000);setInterval(show,1500);addEventListener('pageshow',update);
})();
