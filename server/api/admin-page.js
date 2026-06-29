import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { CSRF_COOKIE, getAdminSession } from '../../lib/admin-auth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const config = {
  includeFiles: ['../../private/admin-hub.html']
};

function securityHeaders(res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline' https://accounts.google.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: https://lh3.googleusercontent.com; connect-src 'self' https://accounts.google.com; frame-src https://accounts.google.com; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
}

function safeAttr(value) {
  return String(value || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function loginPage() {
  const googleClientId = process.env.GOOGLE_ADMIN_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '';
  const googleEnabled = Boolean(googleClientId);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex,nofollow,noarchive,nosnippet">
<title>Private Admin · yogacloak</title>
<style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#1e2320;color:#fbf8f0;font-family:Helvetica,Arial,sans-serif}
main{width:min(460px,calc(100vw - 32px));background:#151719;border:1px solid rgba(251,248,240,.12);border-radius:8px;padding:24px}
h1{font-size:34px;line-height:1;margin:0 0 10px;font-weight:500;letter-spacing:-.04em}
p{color:rgba(251,248,240,.58);line-height:1.5}
label{display:block;font-size:9px;letter-spacing:.18em;text-transform:uppercase;color:rgba(251,248,240,.48);font-weight:700;margin-top:18px}
input{width:100%;box-sizing:border-box;background:rgba(251,248,240,.055);border:1px solid rgba(251,248,240,.14);color:#fbf8f0;border-radius:8px;padding:13px;margin-top:8px}
button{width:100%;border:0;border-radius:999px;background:#fbf8f0;color:#1e2320;font-weight:700;padding:13px;margin-top:14px;cursor:pointer}
.google-box{margin-top:18px;padding:14px;border:1px solid rgba(251,248,240,.12);border-radius:8px;background:rgba(251,248,240,.04)}
.divider{display:flex;gap:10px;align-items:center;margin:18px 0 0;color:rgba(251,248,240,.42);font-size:11px;letter-spacing:.14em;text-transform:uppercase}
.divider:before,.divider:after{content:"";height:1px;background:rgba(251,248,240,.12);flex:1}
.fine{font-size:12px;color:rgba(251,248,240,.45);margin:10px 0 0}
.error{color:#d4948d;font-size:13px;margin-top:12px}
</style>
${googleEnabled ? '<script src="https://accounts.google.com/gsi/client" async defer></script>' : ''}
</head>
<body>
<main>
<p style="font-size:11px;letter-spacing:.22em;text-transform:uppercase;color:#7c8c82">yogacloak</p>
<h1>Private admin.</h1>
<p>This CRM is blocked until your work profile is verified.</p>
${googleEnabled ? `<div class="google-box">
<div id="g_id_onload"
  data-client_id="${safeAttr(googleClientId)}"
  data-callback="handleGoogleLogin"
  data-auto_prompt="false"></div>
<div class="g_id_signin" data-type="standard" data-size="large" data-theme="filled_black" data-text="signin_with" data-shape="pill" data-logo_alignment="left"></div>
<p class="fine">Only approved yogacloak team emails can open the admin hub.</p>
</div><div class="divider">backup code</div>` : ''}
<label>Profile access code<input id="token" type="password" autocomplete="off" autofocus></label>
<button id="login">Open admin hub</button>
<div id="msg" class="error"></div>
</main>
<script>
document.getElementById('login').addEventListener('click',login);
document.getElementById('token').addEventListener('keydown',function(e){if(e.key==='Enter')login()});
async function login(){
var msg=document.getElementById('msg');
msg.textContent='';
var res=await fetch('/api/admin-login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:document.getElementById('token').value.trim()})});
if(res.ok){location.reload();return}
var data=await res.json().catch(function(){return {}});
msg.textContent=(data.error||'Could not log in.')+' If you just changed profile codes in Vercel, redeploy Production and refresh this page.';
}
async function handleGoogleLogin(response){
var msg=document.getElementById('msg');
msg.textContent='';
var res=await fetch('/api/admin-login-google',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({credential:response&&response.credential})});
if(res.ok){location.reload();return}
var data=await res.json().catch(function(){return {}});
msg.textContent=data.error||'Google login failed.';
}
</script>
</body>
</html>`;
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map((part) => {
    const index = part.indexOf('=');
    if (index === -1) return ['', ''];
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1).trim())];
  }).filter(([key]) => key));
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end('Method not allowed');
  securityHeaders(res);

  const session = getAdminSession(req);
  if (!session) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.status(401).send(loginPage());
  }

  const htmlPath = path.join(__dirname, '..', '..', 'private', 'admin-hub.html');
  const csrf = parseCookies(req)[CSRF_COOKIE] || '';
  const safeUserJson = JSON.stringify(session).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/</g, '\\u003c');
  const html = fs.readFileSync(htmlPath, 'utf8')
    .replace('__ADMIN_CSRF_TOKEN__', csrf)
    .replace('__ADMIN_USER_JSON__', safeUserJson);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send(html);
}
