(function(){
  function phoneDigits(value){
    var digits = String(value || '').replace(/\D/g, '');
    if(digits.length > 10 && digits.charAt(0) === '1') digits = digits.slice(1);
    return digits.slice(0, 10);
  }

  function formatUSPhone(value){
    var digits = phoneDigits(value);
    if(!digits) return '';
    if(digits.length < 4) return '+1 (' + digits;
    if(digits.length < 7) return '+1 (' + digits.slice(0, 3) + ') ' + digits.slice(3);
    return '+1 (' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6);
  }

  function isPhoneInput(el){
    return el && el.matches && el.matches('input[type="tel"], input[data-phone-format]');
  }

  function formatInput(el){
    var formatted = formatUSPhone(el.value);
    if(el.value !== formatted) el.value = formatted;
  }

  document.addEventListener('input', function(e){
    if(!isPhoneInput(e.target)) return;
    formatInput(e.target);
  });

  document.addEventListener('blur', function(e){
    if(!isPhoneInput(e.target)) return;
    formatInput(e.target);
  }, true);

  document.addEventListener('DOMContentLoaded', function(){
    document.querySelectorAll('input[type="tel"], input[data-phone-format]').forEach(formatInput);
  });
})();
