(function () {
  'use strict';

  const STORAGE_KEY = 'mcv-protected-access-v1';
  const ACCESS_MS = 8 * 60 * 60 * 1000;
  const PASSCODE_SHA256 = '5df367b11687a0a97d957326ba4b12b48253b7bc15e674c7c0f930f4a354cf9b';

  function hasAccess() {
    try {
      const grantedAt = Number(localStorage.getItem(STORAGE_KEY) || 0);
      if (!grantedAt || Date.now() - grantedAt > ACCESS_MS) {
        localStorage.removeItem(STORAGE_KEY);
        return false;
      }
      return true;
    } catch (_) {
      return false;
    }
  }

  if (hasAccess()) return;

  const returnTo = 'index.html';
  document.open();
  document.write(`<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="theme-color" content="#262262">
<title>Restricted MCV Tool | Manchester Victoria</title>
<style>
@font-face{font-family:Bunday;src:url('bunday-clean-regular.woff') format('woff');font-weight:400 600;font-display:swap}
@font-face{font-family:Bunday;src:url('bunday-clean-bold.woff') format('woff');font-weight:700 900;font-display:swap}
:root{--navy:#262262;--blue:#0698d6;--ink:#282849;--muted:#647089;--line:#dce4ee;--paper:#f3f6fb;--red:#b00032}
*{box-sizing:border-box}
html,body{min-height:100%}
body{margin:0;background:var(--paper);font-family:Bunday,Arial,Helvetica,sans-serif;color:var(--ink);display:grid;place-items:center;padding:22px}
.gate{width:min(460px,100%);background:#fff;border:1px solid var(--line);border-radius:12px;overflow:hidden;box-shadow:0 18px 50px rgba(38,34,98,.12)}
.head{background:var(--navy);color:#fff;padding:28px 30px;border-bottom:4px solid var(--blue)}
.eyebrow{font-size:11px;font-weight:800;letter-spacing:.14em;text-transform:uppercase;color:#8edcff}
h1{font-size:28px;line-height:1.1;margin:7px 0 0}
.body{padding:27px 30px 30px}
p{margin:0 0 20px;color:var(--muted);line-height:1.5}
label{display:block;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;color:var(--navy);margin-bottom:7px}
input{width:100%;border:1px solid #bcc8d7;border-radius:7px;padding:13px 14px;font:inherit;font-size:18px;letter-spacing:.09em;color:var(--navy);text-transform:uppercase}
input:focus{outline:3px solid rgba(6,152,214,.24);border-color:var(--blue)}
.actions{display:flex;gap:9px;margin-top:12px}
button,a{min-height:44px;border-radius:7px;padding:11px 15px;font:inherit;font-weight:800;text-decoration:none;display:inline-flex;align-items:center;justify-content:center}
button{border:1px solid var(--navy);background:var(--navy);color:#fff;flex:1;cursor:pointer}
a{border:1px solid var(--line);background:#fff;color:var(--navy)}
.error{min-height:20px;color:var(--red);font-size:12px;font-weight:700;margin-top:10px}
.foot{font-size:11px;color:#8290a2;margin-top:18px;line-height:1.45}
@media(max-width:520px){body{padding:12px}.head{padding:23px 22px}.body{padding:23px 22px}.actions{flex-direction:column}h1{font-size:24px}}
</style>
</head>
<body>
<main class="gate">
  <section class="head">
    <div class="eyebrow">Manchester Victoria</div>
    <h1>Restricted tool</h1>
  </section>
  <section class="body">
    <p>This page is restricted. Enter the staff passcode to continue.</p>
    <form id="mcv-auth-form">
      <label for="mcv-passcode">Passcode</label>
      <input id="mcv-passcode" type="password" autocomplete="current-password" autocapitalize="characters" spellcheck="false" autofocus>
      <div class="actions">
        <button type="submit">Unlock</button>
        <a href="${returnTo}">Back</a>
      </div>
      <div class="error" id="mcv-auth-error" aria-live="polite"></div>
    </form>
    <div class="foot">Access remains unlocked in this browser for up to 8 hours.</div>
  </section>
</main>
<script>
(function(){
  const form=document.getElementById('mcv-auth-form');
  const input=document.getElementById('mcv-passcode');
  const error=document.getElementById('mcv-auth-error');
  async function sha256(value){
    const data=new TextEncoder().encode(value);
    const digest=await crypto.subtle.digest('SHA-256',data);
    return Array.from(new Uint8Array(digest)).map(b=>b.toString(16).padStart(2,'0')).join('');
  }
  form.addEventListener('submit',async function(e){
    e.preventDefault();
    error.textContent='';
    const entered=input.value.trim().toUpperCase();
    const digest=await sha256(entered);
    if(digest==='${PASSCODE_SHA256}'){
      try{localStorage.setItem('${STORAGE_KEY}',String(Date.now()))}catch(_){}
      location.reload();
      return;
    }
    input.value='';
    input.focus();
    error.textContent='Incorrect passcode.';
  });
})();
<\/script>
</body>
</html>`);
  document.close();
})();