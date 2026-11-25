// ScareBooth iPad controller
(function () {
  'use strict';
  const { $, $$, api, esc, showScreen, tr } = SB;

  let state = null, settings = null, connected = false;
  let localPreview = -1, pending = false, doneTick = null;

  function toast(msg, ms = 4000) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), ms);
  }

  async function act(action, extra = {}, btn) {
    if (pending) return;
    pending = true; if (btn) btn.disabled = true;
    try {
      const r = await api('/api/control', { json: { action, ...extra } });
      if (r.state) render(r.state);
    } catch (e) {
      if (e.data && e.data.state) render(e.data.state);
      toast(e.message);
    } finally {
      pending = false; if (btn) btn.disabled = false;
      updateStatus();
    }
  }

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    e.preventDefault();
    const a = b.dataset.action;
    if (a === 'cancel' && !confirm('End this session? Photos taken so far stay saved on the PC.')) return;
    act(a, b.dataset.lang ? { lang: b.dataset.lang } : {}, b);
  });

  // ---- choose screen
  function buildThumbs(s) {
    const box = $('#thumbs');
    box.innerHTML = s.reactions.map((r, i) => `<button data-i="${i}" aria-label="Reaction ${i + 1}"><img src="${esc(r.thumb)}" alt="" loading="eager"><span>${i + 1}</span></button>`).join('');
    box.dataset.session = s.sessionId;
    box.style.gridTemplateColumns = `repeat(${Math.min(Math.max(s.reactions.length, 1), 8)}, minmax(0, 1fr))`;
    box.classList.toggle('few', s.reactions.length <= 8);
  }
  function selectPreview(i, tell) {
    if (!state || !state.reactions[i]) return;
    localPreview = i;
    $('#chooseImg').src = state.reactions[i].url;
    $$('#thumbs button').forEach((b, k) => b.classList.toggle('sel', k === i));
    const sel = $(`#thumbs button[data-i="${i}"]`);
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    if (tell) api('/api/control', { json: { action: 'preview', index: i } }).catch(() => {});
  }
  $('#thumbs').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-i]'); if (!b) return;
    selectPreview(Number(b.dataset.i), true);
  });
  // swipe on the big preview to step through reactions
  let sx = null;
  $('#chooseImg').addEventListener('touchstart', e => { sx = e.touches[0].clientX; }, { passive: true });
  $('#chooseImg').addEventListener('touchend', e => {
    if (sx === null) return; const dx = e.changedTouches[0].clientX - sx; sx = null;
    if (Math.abs(dx) > 50 && state) selectPreview(Math.max(0, Math.min(state.reactions.length - 1, localPreview + (dx < 0 ? 1 : -1))), true);
  });
  $('#confirmBtn').addEventListener('click', (e) => { if (localPreview >= 0) act('confirm', { index: localPreview }, e.currentTarget); });

  // ---- rendering
  function render(s) {
    const prev = state; state = s;
    const phase = s.phase;
    // the guests' language from the moment they pick it; the start screen shows both
    const lang = phase === 'idle' ? 'en' : (s.lang || 'en');
    if (SB.getLang() !== lang || !render.langSet) { SB.setLang(lang); render.langSet = true; }
    $('#idleWelcome').textContent = SB.themeText('welcome', 'en') + ' · ' + SB.themeText('welcome', 'zh');
    $('#cancelBtn').hidden = phase !== 'choose';
    clearInterval(doneTick); doneTick = null;

    switch (phase) {
      case 'idle': showScreen('s-idle'); $('#idleNote').dataset.msg = s.message || ''; break;
      case 'intro': {
        const text = settings && settings.instructions ? (settings.instructions[lang] || settings.instructions.en) : '';
        $('#introSteps').innerHTML = text.split('\n').map(l => l.trim()).filter(Boolean).map(l => `<li>${esc(l)}</li>`).join('');
        showScreen('s-intro'); break;
      }
      case 'warning':
        $('#warningText').textContent = settings ? settings.warning.text : '';
        showScreen('s-warning'); break;
      case 'shooting': showScreen('s-shooting'); break;
      case 'choose':
        if (!prev || prev.phase !== 'choose' || $('#thumbs').dataset.session !== s.sessionId || $('#thumbs').children.length !== s.reactions.length) {
          buildThumbs(s); localPreview = -1;
        }
        if (localPreview < 0) selectPreview(s.previewIndex >= 0 ? s.previewIndex : 0, false);
        $('#chooseMsg').textContent = s.message || '';
        {
          const end = s.updatedAt + (s.chooseTimeoutSec || 45) * 1000;
          const tick = () => { const left = Math.max(0, Math.round((end - Date.now()) / 1000)); $('#chooseTimer').textContent = tr('noPickIn', undefined, { n: left }); };
          tick(); doneTick = setInterval(tick, 1000);
        }
        showScreen('s-choose'); break;
      case 'composing': showScreen('s-composing'); break;
      case 'done': {
        renderDone(s);
        showScreen('s-done');
        break;
      }
    }
    updateStatus();
  }

  function renderDone(s) {
    const asking = s.printStatus === 'ask';
    $('#printAsk').hidden = !asking;
    $('#printEach').hidden = !(asking && s.stripsPerPrint === 2);
    if (asking && $('#copyBtns').dataset.max !== String(s.printMax)) {
      $('#copyBtns').dataset.max = s.printMax;
      $('#copyBtns').innerHTML = `<button class="btn ghost none" data-copies="0">${esc(tr('noPrints'))}</button>` +
        Array.from({ length: s.printMax }, (_, i) => `<button class="btn" data-copies="${i + 1}">${i + 1}</button>`).join('');
    }
    const strips = s.printCopies * (s.stripsPerPrint || 1);
    $('#printStatus').textContent = {
      ask: s.printDefault > 0 ? tr('ifNoChoice', undefined, { n: s.printDefault }) : '',
      printing: s.printFixed ? (strips === 1 ? tr('printingStrip1') : tr('printingStrips', undefined, { n: strips })) : (s.printCopies === 1 ? tr('printingCopy1') : tr('printingCopies', undefined, { n: s.printCopies })),
      printed: tr('printed'),
      error: tr('printError'),
    }[s.printStatus] || '';
    // QR codes appear once the print question is answered (or straight away when printing is off)
    const showQr = !asking && !!s.shareUrl;
    const share = settings && settings.share;
    const wifi = showQr && !s.shareOnline && share && share.wifiSsid ? SB.wifiQrText(share) : '';
    $('#qrNote').textContent = s.shareOnline ? ' · ' + tr('mobileData') : '';
    $('#qrDl').innerHTML = showQr ? SB.qrSvg(s.shareUrl) : ''; $('#qrDlBox').hidden = !showQr;
    $('#qrWifi').innerHTML = wifi ? SB.qrSvg(wifi) : ''; $('#qrWifiBox').hidden = !wifi;
    $('#qrWifiName').textContent = share ? share.wifiSsid : '';
    $('#qrStep').textContent = wifi ? '2' : '';
    $('#againBtn').hidden = asking;
    const end = s.updatedAt + ((settings && settings.timing.doneTimeoutSec) || 25) * 1000;
    const label = asking && s.printDefault > 0 ? 'autoPrintIn' : s.printStatus === 'printing' ? '' : 'resetsIn';
    const tick = () => { const left = Math.max(0, Math.round((end - Date.now()) / 1000)); $('#doneTimer').textContent = label ? tr(label, undefined, { n: left, d: s.printDefault }) : ''; };
    tick(); doneTick = setInterval(tick, 1000);
  }
  $('#copyBtns').addEventListener('click', (e) => {
    const b = e.target.closest('[data-copies]'); if (!b) return;
    act('print', { copies: Number(b.dataset.copies) }, b);
  });

  function updateStatus() {
    const pill = $('#status'), txt = $('#statusText');
    let ok = connected && state && state.displayOnline && state.cameraOk;
    let msg = tr(!connected ? 'reconnecting' : !state || !state.displayOnline ? 'displayOffline' : !state.cameraOk ? 'cameraNotReady' : 'ready');
    pill.className = 'pill ' + (ok ? 'ok' : 'bad');
    txt.textContent = msg;
    for (const b of $$('.lang-btn')) b.disabled = !ok || pending;
    if ($('#startBtn')) $('#startBtn').disabled = !ok || pending;
    const note = $('#idleNote');
    note.textContent = !ok ? tr('gettingReady', 'en') + ' · ' + tr('gettingReady', 'zh') : (note.dataset.msg || '');
  }

  SB.connect('controller', {
    settings: (p) => { settings = p.settings; SB.applyTheme(settings); SB.loveParticles($('#love'), 12); if (state) render(state); },
    state: render,
    connection: (on) => { connected = on; updateStatus(); },
  });

  // Prevent pinch-zoom & double-tap zoom on iPad
  document.addEventListener('gesturestart', e => e.preventDefault());
  let lastTouch = 0;
  document.addEventListener('touchend', e => { const now = Date.now(); if (now - lastTouch < 350 && !e.target.closest('a')) e.preventDefault(); lastTouch = now; }, { passive: false });
})();
