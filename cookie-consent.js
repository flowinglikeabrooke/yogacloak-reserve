(function(){
var cookieName='yc_cookie_consent=';
function hasChoice(){
return document.cookie.split(';').some(function(item){return item.trim().indexOf(cookieName)===0});
}
function fallbackCookie(choice){
var payload=encodeURIComponent(JSON.stringify({choice:choice,analytics:choice==='all',marketing:choice==='all',updated_at:new Date().toISOString(),version:'cookie-consent-v1'}));
document.cookie='yc_cookie_consent='+payload+'; Path=/; Max-Age=15552000; SameSite=Lax';
}
async function saveChoice(choice,banner){
try{
var res=await fetch('/api/cookie-consent',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({choice:choice})});
if(!res.ok)throw new Error('cookie save failed');
}catch(e){
fallbackCookie(choice);
}
banner.classList.remove('show');
}
function buildBanner(){
var banner=document.createElement('div');
banner.className='yc-cookie-banner';
banner.setAttribute('role','dialog');
banner.setAttribute('aria-live','polite');
banner.setAttribute('aria-label','Cookie preferences');
banner.innerHTML='<div class="yc-cookie-inner"><p class="yc-cookie-copy">We use cookies to keep the site working, understand traffic, and improve launch updates.</p><div class="yc-cookie-actions"><button class="yc-cookie-btn primary" data-cookie-choice="all">Accept all</button><button class="yc-cookie-btn secondary" data-cookie-choice="essential">Reject non-essential</button><button class="yc-cookie-btn secondary" data-cookie-manage type="button">Manage</button></div></div><div class="yc-cookie-manage"><strong>Essential cookies</strong> keep the site working and remember this choice. Analytics and marketing stay off unless you accept all.</div>';
document.body.appendChild(banner);
banner.querySelector('[data-cookie-manage]').addEventListener('click',function(){banner.classList.toggle('manage-open')});
banner.querySelectorAll('[data-cookie-choice]').forEach(function(btn){
btn.addEventListener('click',function(){saveChoice(btn.getAttribute('data-cookie-choice'),banner)});
});
requestAnimationFrame(function(){banner.classList.add('show')});
}
if(document.readyState==='loading'){
document.addEventListener('DOMContentLoaded',function(){if(!hasChoice())buildBanner()});
}else if(!hasChoice()){
buildBanner();
}
})();
