'use strict';
self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
// Always request the current page. Never cache live rail data or old boards.
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.mode!=='navigate'||url.origin!==self.location.origin||url.pathname!=='/mcv/staff.html')return;
  event.respondWith(fetch(event.request).catch(()=>new Response(
    '<!doctype html><html lang="en"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="theme-color" content="#262262"><title>MCV Staff — offline</title><style>body{font:18px system-ui;background:#f2f5fa;color:#262262;padding:32px;max-width:560px;margin:auto}a{color:#262262}</style><h1>MCV Staff</h1><p>You are offline. Connect to the internet to view live train information.</p><p><a href="/mcv/staff.html?source=app">Try again</a></p></html>',
    {status:503,headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}}
  )));
});
