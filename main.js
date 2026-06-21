const topbar=document.getElementById('topbar'),floatR=document.getElementById('floatReserve'),closing=document.querySelector('.closing');

function checkClose(){if(!closing)return;const r=closing.getBoundingClientRect(),visible=r.top<window.innerHeight*.92&&r.bottom>0;floatR.classList.toggle('show',window.scrollY>600&&!visible)}

window.addEventListener('scroll',()=>{topbar.classList.toggle('solid',window.scrollY>40);checkClose()},{passive:true});

const io=new IntersectionObserver(entries=>{entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target)}})},{threshold:0.2});
const ioPhoto=new IntersectionObserver(entries=>{entries.forEach(e=>{if(e.isIntersecting){e.target.classList.add('in');ioPhoto.unobserve(e.target)}})},{threshold:0.2,rootMargin:'0px 0px 10% 0px'});

document.querySelectorAll('.reveal').forEach(el=>io.observe(el));
document.querySelectorAll('.pphoto').forEach(el=>ioPhoto.observe(el));

(function(){var ov=document.getElementById('loopOv'),card=document.getElementById('loopCard'),closeBtn=document.getElementById('loopClose'),submitBtn=document.getElementById('loopSubmit'),phone=document.getElementById('loopPhone');if(!ov)return;var KEY='yc_loop_seen';function seen(){try{return localStorage.getItem(KEY)==='1'}catch(e){return false}}function mark(){try{localStorage.setItem(KEY,'1')}catch(e){}}function open(){ov.classList.add('show');ov.setAttribute('aria-hidden','false');setTimeout(function(){try{phone.focus()}catch(e){}},320)}function close(){ov.classList.remove('show');ov.setAttribute('aria-hidden','true');mark()}closeBtn.addEventListener('click',close);ov.addEventListener('click',function(e){if(e.target===ov)close()});document.addEventListener('keydown',function(e){if(e.key==='Escape'&&ov.classList.contains('show'))close()});function go(){var v=(phone.value||'').trim(),digits=v.replace(/\D/g,'');if(digits.length<7){phone.style.borderColor='#a06860';phone.focus();return}mark();try{fetch('/api/subscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone:v,source:'loop-popup'})}).catch(function(){})}catch(e){}card.classList.add('done');setTimeout(close,2000)}submitBtn.addEventListener('click',go);phone.addEventListener('keydown',function(e){if(e.key==='Enter')go()})})();
