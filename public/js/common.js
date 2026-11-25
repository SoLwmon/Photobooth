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
  // Chinese wording for the same theme keys
  const THEME_TEXT_ZH = {
    horror: {
      attractLine: '走进来，摆个姿势，尽量保持冷静。', chooseEyebrow: '你的反应已被拍下', developing: '正在冲洗你的照片条',
      doneEyebrow: '你活下来了', welcome: '欢迎，勇敢的人', lead: '跟着大屏幕上的问题，一共拍四张照片。<br>无论发生什么……都要一直看着屏幕。',
      warnEyebrow: '进入之前', ipadDoneEyebrow: '你活下来了', warningAttract: '请先阅读 iPad 上的提示……',
    },
    romance: {
      attractLine: '和你的真爱一起摆个姿势吧……', chooseEyebrow: '美好瞬间已被拍下', developing: '正在书写你们的爱情故事',
      doneEyebrow: '从此幸福快乐', welcome: '欢迎，甜蜜的爱侣', lead: '跟着大屏幕上的问题，一起拍四张照片。<br>无论发生什么……都要一直看着屏幕。',
      warnEyebrow: '在说“我愿意”之前', ipadDoneEyebrow: '从此幸福快乐', warningAttract: '请先阅读 iPad 上的说明……',
    },
  };
  let currentTheme = null, currentLang = 'en';
  function themeText(key, lang = currentLang) {
    const set = lang === 'zh' ? THEME_TEXT_ZH : THEME_TEXT;
    return (set[currentTheme || 'romance'] || set.romance)[key] || themeTextEn(key);
  }
  function themeTextEn(key) { return (THEME_TEXT[currentTheme || 'romance'] || THEME_TEXT.romance)[key] || ''; }

  // ---------------------------------------------------------------- guest-facing wording, English and Chinese
  // {n}, {total}… are filled in by tr(). Staff/operator messages stay in English.
  const STRINGS = {
    en: {
      chooseLang: 'Choose your language', english: 'English', chinese: '中文',
      pressStart: 'Press Start on the iPad to begin', pickLang: 'Choose your language on the iPad to begin',
      howItWorks: 'How it works', start: 'Start', back: 'Back',
      readyWhenYouAre: 'Press Start when you’re ready', introDisplayCta: 'Press Start on the iPad when you’re ready',
      question: 'Question {n} of {total}', answerNow: 'Answer now…', strikePose: 'Now strike a pose!',
      lookBig: 'Look at the big screen', lookBigSub: 'Your questions and countdowns are up there.',
      developingIpad: 'Developing your strip…', stripReady: 'Your strip is ready',
      howManyPrints: 'How many prints would you like?', eachPrint2: 'Each print is 2 photo strips', noPrints: 'No prints',
      ifNoChoice: 'If you don’t choose, we’ll print {n} for you.',
      printingStrips: 'Printing your {n} photo strips…', printingStrip1: 'Printing your photo strip…',
      printingCopies: 'Printing {n} copies…', printingCopy1: 'Printing 1 copy…',
      printed: 'Printed! Collect your strips from the printer.', printedDisplay: 'Your prints are on the way!',
      printError: 'There was a printing problem — please ask a staff member.',
      askPrintsDisplay: 'How many prints? Choose on the iPad.', askPrintsDisplayDefault: 'How many prints? Choose on the iPad (otherwise we’ll print {n}).',
      joinWifi: 'Join Wi-Fi', scanDownload: 'Scan to download', scanDownloadLong: 'Scan to download<br>your photos', mobileData: 'Works on mobile data',
      newSession: 'Start a new session', resetsIn: 'The booth resets in {n}s', autoPrintIn: 'Printing {d} automatically in {n}s',
      chooseScream: 'Choose your favourite scream on the iPad', finalPhoto: 'The final photo', pickReaction: 'Pick your best reaction',
      pickHint: 'Tap a photo to see it bigger, then tap <b>Use this one</b>.', useThis: 'Use this one',
      noPickIn: 'No pick in {n}s? We’ll choose the biggest reaction for you.',
      ready: 'Ready', reconnecting: 'Reconnecting to booth…', displayOffline: 'Booth screen offline', cameraNotReady: 'Camera not ready',
      gettingReady: 'The booth is getting ready… please ask a staff member if this doesn’t clear.',
      warnTitle: 'Sudden visuals & loud sound', noThanks: 'No thanks', iUnderstand: 'I understand — Start',
    },
    zh: {
      chooseLang: '请选择语言', english: 'English', chinese: '中文',
      pressStart: '请在 iPad 上按“开始”', pickLang: '请在 iPad 上选择语言开始',
      howItWorks: '玩法说明', start: '开始', back: '返回',
      readyWhenYouAre: '准备好了就按“开始”', introDisplayCta: '准备好了，请在 iPad 上按“开始”',
      question: '第 {n} 题 / 共 {total} 题', answerNow: '请回答……', strikePose: '摆个姿势吧！',
      lookBig: '请看大屏幕', lookBigSub: '问题和倒数都会出现在大屏幕上。',
      developingIpad: '正在冲洗你们的照片条……', stripReady: '你们的照片条完成了',
      howManyPrints: '要打印几张？', eachPrint2: '每张打印出来是两条照片条', noPrints: '不打印',
      ifNoChoice: '如果不选择，我们会为你打印 {n} 张。',
      printingStrips: '正在打印你们的 {n} 条照片条……', printingStrip1: '正在打印你们的照片条……',
      printingCopies: '正在打印 {n} 张……', printingCopy1: '正在打印 1 张……',
      printed: '打印好了！请到打印机领取照片条。', printedDisplay: '照片正在打印中！',
      printError: '打印出了点问题，请联系工作人员。',
      askPrintsDisplay: '要打印几张？请在 iPad 上选择。', askPrintsDisplayDefault: '要打印几张？请在 iPad 上选择（否则将打印 {n} 张）。',
      joinWifi: '连接 Wi-Fi', scanDownload: '扫码下载', scanDownloadLong: '扫码下载<br>你们的照片', mobileData: '用手机流量也可以',
      newSession: '重新开始', resetsIn: '{n} 秒后返回开始画面', autoPrintIn: '{n} 秒后自动打印 {d} 张',
      chooseScream: '请在 iPad 上选出最喜欢的一张', finalPhoto: '最后一张照片', pickReaction: '选出你们最好的反应',
      pickHint: '点一张照片放大，再点 <b>就用这张</b>。', useThis: '就用这张',
      noPickIn: '{n} 秒内没有选择？我们会帮你选反应最大的一张。',
      ready: '准备就绪', reconnecting: '正在重新连接……', displayOffline: '大屏幕未连接', cameraNotReady: '相机未就绪',
      gettingReady: '拍照亭正在准备中……如果一直没好，请联系工作人员。',
      warnTitle: '突然的画面和巨大声响', noThanks: '不了，谢谢', iUnderstand: '我明白了——开始',
    },
  };
  function tr(key, lang = currentLang, vars = {}) {
    let t = (STRINGS[lang] || STRINGS.en)[key];
    if (t == null) t = STRINGS.en[key] || key;
    return t.replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : ''));
  }
  /** Switch the page's guest-facing language: elements with data-i18n (text) / data-i18n-html (HTML), plus themed text. */
  function setLang(lang) {
    currentLang = lang === 'zh' ? 'zh' : 'en';
    document.documentElement.lang = currentLang === 'zh' ? 'zh-Hans' : 'en';
    document.body.classList.toggle('lang-zh', currentLang === 'zh');
    for (const el of $$('[data-i18n]')) el.textContent = tr(el.dataset.i18n);
    for (const el of $$('[data-i18n-html]')) el.innerHTML = tr(el.dataset.i18nHtml);
    for (const el of $$('[data-t]')) el.textContent = themeText(el.dataset.t);
    for (const el of $$('[data-th]')) el.innerHTML = themeText(el.dataset.th);
  }
  function getLang() { return currentLang; }
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

  window.SB = { connect, api, sleep, $, $$, esc, showScreen, qrSvg, wifiQrText, applyTheme, themeText, loveParticles, tr, setLang, getLang };
})();
