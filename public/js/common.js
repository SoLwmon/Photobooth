// ScareBooth shared client helpers
(function () {
  'use strict';

  /** Connect to the server's event stream. EventSource reconnects automatically. */
  function connect(role, handlers) {
    let es = null;
    let online = false;
    const setOnline = (v) => { if (v !== online) { online = v; handlers.connection && handlers.connection(v); } };
    function open() {
      es = new EventSource('/events?role=' + encodeURIComponent(role));
      es.addEventListener('open', () => setOnline(true));
      es.addEventListener('error', () => { setOnline(false); });
      for (const ev of ['hello', 'state', 'settings', 'command', 'status', 'testResult']) {
        es.addEventListener(ev, (e) => {
          setOnline(true);
          let data; try { data = JSON.parse(e.data); } catch (_) { return; }
          handlers[ev] && handlers[ev](data);
        });
      }
    }
    open();
    // Safari/iPad can silently drop the stream when the device sleeps: reopen when visible again.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && es && es.readyState === 2) open();
    });
    setInterval(() => { if (es && es.readyState === 2) open(); }, 4000);
    return { close: () => es && es.close() };
  }

  async function api(url, opts = {}) {
    const init = { method: opts.method || 'GET', headers: {} };
    if (opts.json !== undefined) { init.method = opts.method || 'POST'; init.headers['Content-Type'] = 'application/json'; init.body = JSON.stringify(opts.json); }
    if (opts.body !== undefined) { init.method = opts.method || 'POST'; init.body = opts.body; if (opts.type) init.headers['Content-Type'] = opts.type; }
    let res;
    try { res = await fetch(url, init); }
    catch (e) { throw new Error('Can’t reach the ScareBooth PC. Check that the server window is open and you are on the same Wi-Fi.'); }
    let data = null;
    try { data = await res.json(); } catch (_) {}
    if (!res.ok || (data && data.ok === false)) {
      const err = new Error((data && data.error) || ('Request failed (' + res.status + ')'));
      err.status = res.status; err.data = data; throw err;
    }
    return data;
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
  function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function showScreen(id) {
    for (const el of $$('.screen')) {
      const on = el.id === id;
      if (on && !el.classList.contains('active')) { el.classList.add('active'); }
      else if (!on) el.classList.remove('active');
    }
  }

  /** QR code as an SVG string (black on white, quiet zone included). Needs /js/vendor/qrcode.js. */
  function qrSvg(text) {
    if (!window.qrcode) return '';
    const q = window.qrcode(0, 'M'); q.addData(text); q.make();
    const n = q.getModuleCount(), m = 3; let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + m},${r + m}h1v1h-1z`;
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n + 2 * m} ${n + 2 * m}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }
  /** Standard "join Wi-Fi" QR payload understood by iPhone and Android cameras. */
  function wifiQrText(share) {
    const e = (v) => String(v || '').replace(/([\\;,:"])/g, '\\$1');
    const t = share.wifiSecurity === 'nopass' ? 'nopass' : share.wifiSecurity;
    return `WIFI:T:${t};S:${e(share.wifiSsid)};${t === 'nopass' ? '' : `P:${e(share.wifiPassword)};`};`;
  }

  // ---------------------------------------------------------------- themes
  // Wording that changes with the theme. Elements opt in with data-t="key" (text) or data-th="key" (HTML).
  const THEME_TEXT = {
    horror: {
      attractLine: 'Step inside. Strike a pose. Try to stay calm.',
      chooseEyebrow: 'Your reaction was captured',
      developing: 'Developing your strip',
      doneEyebrow: 'You survived',
      welcome: 'Welcome, brave souls',
      lead: 'Four photos. Follow the questions on the big screen.<br>Keep your eyes on it… whatever happens.',
      warnEyebrow: 'Before you enter',
      ipadDoneEyebrow: 'You survived',
      warningAttract: 'Please read the warning on the iPad…',
    },
    romance: {
      attractLine: 'Strike a pose with your one true love…',
      chooseEyebrow: 'Your moment was captured',
      developing: 'Writing your love story',
      doneEyebrow: 'Happily ever after',
      welcome: 'Welcome, lovebirds',
      lead: 'Four photos together. Follow the questions on the big screen.<br>Keep your eyes on it… whatever happens.',
      warnEyebrow: 'Before you say “I do”',
      ipadDoneEyebrow: 'Happily ever after',
      warningAttract: 'Please read the note on the iPad…',
    },
  };
  let currentTheme = null;
  function themeText(key) { return (THEME_TEXT[currentTheme || 'romance'] || THEME_TEXT.romance)[key] || ''; }
  /** Apply the theme class, the booth title and themed wording to the page. */
  function applyTheme(settings) {
    const name = (settings && settings.theme && settings.theme.name) || 'romance';
    const title = (settings && settings.strip && settings.strip.title) || (name === 'romance' ? 'Till Death Do Us Part' : 'ScareBooth');
    currentTheme = name;
    for (const el of [document.documentElement, document.body]) {
      el.classList.toggle('theme-romance', name === 'romance');
      el.classList.toggle('theme-horror', name === 'horror');
    }
    document.body.classList.toggle('grain', name === 'horror');
    for (const el of $$('[data-title]')) el.textContent = title;
    for (const el of $$('[data-t]')) el.textContent = themeText(el.dataset.t);
    for (const el of $$('[data-th]')) el.innerHTML = themeText(el.dataset.th);
    if (!document.title.includes('Operator')) document.title = title;
    try { localStorage.setItem('sb-theme', name); } catch (_) {}
  }
  /** Gentle floating hearts and falling petals, kept to the left and right edges so faces stay clear. */
  function loveParticles(container, count = 16) {
    if (!container || container.childElementCount) return;
    for (let i = 0; i < count; i++) {
      const el = document.createElement('i');
      const left = i % 2 ? 2 + Math.random() * 16 : 82 + Math.random() * 16;
      const petal = i % 3 === 0;
      if (petal) el.className = 'petal'; else el.textContent = '♥';
      el.style.left = left + 'vw';
      if (!petal) el.style.fontSize = (14 + Math.random() * 22) + 'px';
      el.style.animationDuration = (12 + Math.random() * 14) + 's';
      el.style.animationDelay = (-Math.random() * 24) + 's';
      container.appendChild(el);
    }
  }
  // Use the last theme straight away to avoid a flash of the wrong colours before settings arrive.
  try {
    const t = localStorage.getItem('sb-theme') || 'romance';
    document.documentElement.classList.add('theme-' + t);
    document.addEventListener('DOMContentLoaded', () => { if (!currentTheme) { document.body.classList.add('theme-' + t); document.body.classList.toggle('grain', t === 'horror'); } });
  } catch (_) {}

  window.SB = { connect, api, sleep, $, $$, esc, showScreen, qrSvg, wifiQrText, applyTheme, themeText, loveParticles };
})();
