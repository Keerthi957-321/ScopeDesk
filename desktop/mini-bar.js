'use strict';
// Control bar page. Talks to the desktop app only through the tiny API in mini-preload.js.
(function () {
  const api = window.scopedeskMini;
  const $ = (id) => document.getElementById(id);
  if (!api) return;
  $('show').addEventListener('click', () => api.action('show'));
  $('stop').addEventListener('click', () => api.action('stop'));
  $('end').addEventListener('click', () => api.action('terminate'));
  let endsAt = 0, apps = '';
  const paint = () => {
    const left = endsAt ? Math.max(0, Math.round((endsAt - Date.now()) / 1000)) : 0;
    const mm = Math.floor(left / 60), ss = String(left % 60).padStart(2, '0');
    $('sub').textContent = `${apps || 'Only the approved apps'}${endsAt ? ` · ${mm}:${ss} left` : ''}`;
  };
  api.onInfo((info) => { endsAt = Number(info && info.endsAt) || 0; apps = String((info && info.apps) || '').slice(0, 80); paint(); });
  setInterval(paint, 1000);
})();
