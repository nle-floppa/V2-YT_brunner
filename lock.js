// Password protection for the dashboard
// Change PASSWORD to whatever you want
var PASSWORD = 'qwer';

(function() {
  'use strict';
  
  const PASS_KEY = 'dash_pass_ok';
  const MAX_PASS_AGE = 24 * 60 * 60 * 1000; // 24 hours
  
  function checkPassword() {
    const stored = localStorage.getItem(PASS_KEY);
    if (!stored) return false;
    
    try {
      const parsed = JSON.parse(stored);
      if (!parsed.time || !parsed.ok) return false;
      const age = Date.now() - parsed.time;
      return age < MAX_PASS_AGE && parsed.ok === true;
    } catch (e) {
      return false;
    }
  }
  
  function storePassword() {
    localStorage.setItem(PASS_KEY, JSON.stringify({
      ok: true,
      time: Date.now()
    }));
  }
  
  if (!checkPassword()) {
    const pass = prompt('Enter password:');
    if (pass !== PASSWORD) {
      alert('Wrong password');
      window.location.href = 'about:blank';
      return;
    }
    storePassword();
  }
})();
