// Shows which version of ScopeDesk this page is, bottom-right. If this stamp is missing, or red, old files are being served.
(function () {
  var EXPECTED = '2026-10-24-b';
  function stamp(text, bad) {
    var d = document.createElement('div');
    d.id = 'buildStamp';
    d.textContent = text;
    d.style.cssText = 'position:fixed;right:8px;bottom:6px;z-index:2147483000;font:11px system-ui,sans-serif;pointer-events:none;border-radius:6px;'
      + (bad ? 'color:#fff;background:#a12b2b;padding:6px 10px;max-width:420px' : 'color:#8aa0ad');
    document.body.appendChild(d);
  }
  window.addEventListener('load', function () {
    setTimeout(function () {
      var page = window.SCOPEDESK_BUILD;
      if (page !== EXPECTED) return stamp('Old files are loaded (page build ' + (page || 'unknown') + ', expected ' + EXPECTED + '). Close every old ScopeDesk window, then press Ctrl+Shift+R.', true);
      fetch('/api/health', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
        var sb = d && d.build;
        if (sb && sb !== EXPECTED) stamp('build ' + EXPECTED + ' | server build ' + sb + ': an old server is running', true);
        else stamp('build ' + EXPECTED);
      }).catch(function () { stamp('build ' + EXPECTED); });
    }, 600);
  });
})();
