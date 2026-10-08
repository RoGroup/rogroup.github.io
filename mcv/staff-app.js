'use strict';
(()=>{
  const button=document.getElementById('install-app');
  let promptEvent=null;
  const standalone=()=>window.matchMedia('(display-mode: standalone)').matches||navigator.standalone===true;
  window.addEventListener('beforeinstallprompt',event=>{
    if(standalone())return;
    event.preventDefault();promptEvent=event;button.hidden=false;
  });
  button.addEventListener('click',async()=>{
    if(!promptEvent)return;
    const event=promptEvent;promptEvent=null;button.hidden=true;
    try{await event.prompt();await event.userChoice;}catch(error){console.warn('App installation:',error);}
  });
  window.addEventListener('appinstalled',()=>{promptEvent=null;button.hidden=true;});
  if('serviceWorker' in navigator){
    window.addEventListener('load',()=>{
      navigator.serviceWorker.register('/mcv/staff-sw.js',{scope:'/mcv/',updateViaCache:'none'})
        .catch(error=>console.warn('Staff app registration:',error));
    });
  }
})();
