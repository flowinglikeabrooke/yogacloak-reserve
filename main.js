// yogacloak homepage interactions: sticky topbar, floating Reserve button, scroll reveals.
// NOTE: the "Be the first to know" SMS popup is handled by the inline script in
// index.html (which posts to /api/sms-optin and saves to Airtable). Do not add popup
// logic here too, or the submit handler will fire twice.

const topbar = document.getElementById('topbar');
const floatR = document.getElementById('floatReserve');
const closing = document.querySelector('.closing');

function checkClose(){
  if(!floatR) return;
  if(!closing){ floatR.classList.toggle('show', window.scrollY > 600); return; }
  const r = closing.getBoundingClientRect();
  const visible = r.top < window.innerHeight * 0.92 && r.bottom > 0;
  floatR.classList.toggle('show', window.scrollY > 600 && !visible);
}

window.addEventListener('scroll', function(){
  if(topbar) topbar.classList.toggle('solid', window.scrollY > 40);
  checkClose();
}, { passive: true });

// Reveal-on-scroll: add `.in` to each `.reveal` element when it enters the viewport.
// This is what makes the product cards (and other reveal content) fade in.
if('IntersectionObserver' in window){
  const io = new IntersectionObserver(function(entries){
    entries.forEach(function(e){
      if(e.isIntersecting){ e.target.classList.add('in'); io.unobserve(e.target); }
    });
  }, { threshold: 0.2 });
  document.querySelectorAll('.reveal').forEach(function(el){ io.observe(el); });
} else {
  // Older browsers without IntersectionObserver: just show everything.
  document.querySelectorAll('.reveal').forEach(function(el){ el.classList.add('in'); });
}
