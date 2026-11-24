// ScareBooth operator console
(function () {
  'use strict';
  const { $, $$, api, esc, sleep } = SB;

  let payload = null, settings = null, status = null, profile = null, activeId = null, connected = false;
  const audio = new SBAudio();
  const renderer = new ScareRenderer($('#pvScare'), { audio });
  const pvCam = $('#pvCam'), pvStage = $('#pvStage'), pvScreen = $('#pvScreen');
  let pvStream = null, pvDemo = null, pvKey = '';

  // ------------------------------------------------------------------ helpers
  function toast(msg, good = false, ms = 5000) {
    const t = $('#toast'); t.textContent = msg; t.className = 'on' + (good ? ' good' : '');
    clearTimeout(toast._t); toast._t = setTimeout(() => (t.className = ''), ms);
  }
  function log(msg) {
    const el = $('#log'); const line = document.createElement('div');
    line.innerHTML = `<b>${new Date().toLocaleTimeString()}</b> ${esc(msg)}`;
    el.prepend(line); while (el.children.length > 40) el.lastChild.remove();
  }
  const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
  function nest(path, val) { const keys = path.split('.'); const out = {}; let cur = out; keys.forEach((k, i) => { if (i === keys.length - 1) cur[k] = val; else cur = cur[k] = {}; }); return out; }
  function fmt(v) { return typeof v === 'number' ? (Math.abs(v) < 10 ? v.toFixed(2) : String(Math.round(v))) : String(v); }

  async function savePatch(patch) {
    try {
      const r = await api('/api/settings', { json: patch });
      onSettings(r);
    } catch (e) { toast('Couldn’t save: ' + e.message); }
  }
  const throttles = {};
  function throttledSave(key, fn, ms = 120) {
    clearTimeout(throttles[key]); throttles[key] = setTimeout(fn, ms);
  }

  // ------------------------------------------------------------------ settings → form
  function readInput(el) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'range' || el.type === 'number') { const n = parseFloat(el.value); return Number.isFinite(n) ? n : undefined; }
    return el.value;
  }
  function writeInput(el, v) {
    if (document.activeElement === el && el.type !== 'range' && el.type !== 'checkbox') return;
    if (el.type === 'checkbox') el.checked = !!v; else if (v !== undefined && v !== null) el.value = v;
  }

  let lastLocalEdit = 0;
  function applyConsoleTitle(s) {
    const romance = s.theme.name === 'romance';
    const title = s.strip.title || (romance ? 'Till Death Do Us Part' : 'ScareBooth');
    $('#consoleTitle').textContent = title;
    document.title = title + ' — Operator console';
    document.body.classList.toggle('theme-romance', romance);
  }
  function onSettings(p) {
    applyConsoleTitle(p.settings);
    const keepLocal = drag || performance.now() - lastLocalEdit < 700;
    const sameScare = p.scare && activeId === p.scare.id;
    payload = p; settings = p.settings;
    $('#stripsPerPrintRow').hidden = settings.print.layout !== '4x6-double';
    $('#askRows').hidden = !settings.print.askGuests;
    $('#tplNote').hidden = settings.strip.style !== 'template';
    updateDnpNote();
    activeId = p.scare ? p.scare.id : null;
    if (!(keepLocal && sameScare && profile)) profile = p.scare ? p.scare.profile : null;
    else payload = { ...p, scare: { ...p.scare, profile } };
    for (const el of $$('[data-path]')) writeInput(el, getPath(settings, el.dataset.path));
    for (const o of $$('[data-for-path]')) o.textContent = fmt(getPath(settings, o.dataset.forPath));
    if (profile) {
      for (const el of $$('[data-profile]')) writeInput(el, getPath(profile, el.dataset.profile));
      for (const o of $$('output[data-for]')) o.textContent = fmt(getPath(profile, o.dataset.for));
    }
    // library
    $('#library').innerHTML = p.scares.map(s => `
      <div class="item ${s.id === activeId ? 'active' : ''}" data-id="${esc(s.id)}">
        <input type="radio" ${s.id === activeId ? 'checked' : ''}>
        <span class="name">${esc(s.name)}</span><span class="kind">${s.kind}</span>
        ${s.builtin ? '' : `<button title="Delete" data-del="${esc(s.id)}">🗑</button>`}
      </div>`).join('');
    // sting options
    const sel = $('#stingSelect');
    sel.innerHTML = `<option value="builtin">Built-in synthesized scream-sting</option><option value="none">None</option>` +
      p.sounds.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('');
    sel.value = settings.sound.sting;
    renderer.setAudioOptions({ useVideoAudio: settings.sound.useVideoAudio, stingKind: ['builtin', 'none'].includes(settings.sound.sting) ? settings.sound.sting : 'file' });
    audio.setVolume(settings.sound.volume);
    if (!['builtin', 'none'].includes(settings.sound.sting)) { const s = p.sounds.find(x => x.id === settings.sound.sting); if (s) audio.loadSting(s.url).catch(() => {}); }
    pvStage.classList.toggle('mirror', settings.camera.mirrorPreview);
    loadPreviewScare();
    startPreviewCamera(); sizePreview();
    renderCamSelect();
  }

  async function loadPreviewScare() {
    if (!payload.scare) return;
    try {
      await renderer.load(payload.scare, profile);
      if (renderer.mode === 'hidden') renderer.setPreview(true, true);
      $('#stScare').innerHTML = `${esc(payload.scare.name)}<div class="muted small">${renderer.webglError ? esc(renderer.webglError) : 'Loaded'}</div>`;
    } catch (e) {
      $('#stScare').innerHTML = `<span style="color:#ff9a9a">${esc(e.message)}</span>`;
    }
  }

  // ------------------------------------------------------------------ form → settings
  document.addEventListener('input', (e) => {
    const el = e.target;
    if (el.dataset.profile) {
      const v = readInput(el); if (v === undefined) return;
      const local = JSON.parse(JSON.stringify(profile));
      const keys = el.dataset.profile.split('.'); let cur = local; keys.slice(0, -1).forEach(k => (cur = cur[k])); cur[keys[keys.length - 1]] = v;
      profile = local; renderer.setProfile(profile); lastLocalEdit = performance.now();
      const o = $(`output[data-for="${el.dataset.profile}"]`); if (o) o.textContent = fmt(v);
      if (el.type === 'range' || el.type === 'color' || el.type === 'checkbox') throttledSave('p:' + el.dataset.profile, () => saveProfile(el.dataset.profile, v));
    } else if (el.dataset.path) {
      const o = $(`output[data-for-path="${el.dataset.path}"]`); if (o) o.textContent = fmt(readInput(el));
      if (el.type === 'range') throttledSave(el.dataset.path, () => savePath(el));
      else if (el.tagName === 'TEXTAREA' || el.type === 'text') throttledSave(el.dataset.path, () => savePath(el), 700);
    }
  });
  document.addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.profile && !['range', 'color', 'checkbox'].includes(el.type)) { const v = readInput(el); if (v !== undefined) saveProfile(el.dataset.profile, v); }
    else if (el.dataset.path && el.type !== 'range') savePath(el);
  });
  function saveProfile(path, v) { if (activeId) savePatch({ scares: { profiles: { [activeId]: nest(path, v) } } }); }
  function savePath(el) {
    const p = el.dataset.path;
    if (p.startsWith('prompts.')) return savePatch({ prompts: $$('[data-path^="prompts."]').map(t => t.value) });
    // per-question timing: save the whole list of four
    for (const key of ['answerSecs', 'countdownSecs']) {
      if (p.startsWith(`timing.${key}.`)) return savePatch({ timing: { [key]: [0, 1, 2, 3].map(i => Number($(`[data-path="timing.${key}.${i}"]`).value)) } });
    }
    const v = readInput(el); if (v === undefined) return;
    savePatch(nest(p, v));
  }

  // library actions
  $('#library').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) {
      e.stopPropagation();
      if (!confirm('Delete this scare file from the PC?')) return;
      try { onSettings(await api('/api/scares?id=' + encodeURIComponent(del.dataset.del), { method: 'DELETE' })); } catch (er) { toast(er.message); }
      return;
    }
    const item = e.target.closest('.item'); if (item && item.dataset.id !== activeId) savePatch({ scares: { active: item.dataset.id } });
  });

  function uploadFile(url, file) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest(); const bar = $('#upProgress');
      bar.classList.add('on');
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) bar.firstElementChild.style.width = (e.loaded / e.total * 100) + '%'; };
      xhr.onload = () => { bar.classList.remove('on'); let d = {}; try { d = JSON.parse(xhr.responseText); } catch (_) {} xhr.status < 300 && d.ok !== false ? resolve(d) : reject(new Error(d.error || 'Upload failed (' + xhr.status + ')')); };
      xhr.onerror = () => { bar.classList.remove('on'); reject(new Error('Upload failed — is the server running?')); };
      xhr.open('POST', url); xhr.send(file);
    });
  }
  $('#scareFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try {
      const r = await uploadFile('/api/scares?name=' + encodeURIComponent(f.name), f);
      onSettings(r);
      const isGreenGuess = f.type.startsWith('video/') && /\.(mp4|m4v|mov)$/i.test(f.name);
      toast(`Uploaded “${f.name}” and made it the active scare.` + (isGreenGuess ? ' MP4s have no transparency — if it has a green background, turn on Chroma key and press Auto-detect.' : ''), true, 8000);
    } catch (er) { toast(er.message); }
  });
  $('#soundFile').addEventListener('change', async (e) => {
    const f = e.target.files[0]; e.target.value = ''; if (!f) return;
    try { onSettings(await uploadFile('/api/sounds?name=' + encodeURIComponent(f.name), f)); toast('Sound uploaded and selected.', true); } catch (er) { toast(er.message); }
  });

  $('#autoKey').addEventListener('click', () => {
    const c = renderer.sampleCornerColor();
    if (!c) return toast('Load a scare first.');
    const inp = $('[data-profile="chroma.color"]'); inp.value = c;
    profile.chroma.color = c; profile.chroma.enabled = true; renderer.setProfile(profile);
    savePatch({ scares: { profiles: { [activeId]: { chroma: { color: c, enabled: true } } } } });
    toast('Key colour set to ' + c + ' from the scare’s corners.', true);
  });
  $('#resetProfile').addEventListener('click', () => {
    if (!activeId) return;
    savePatch({ scares: { profiles: { [activeId]: { placement: { x: 0.5, y: 0.56, scale: 0.95, flip: false }, edgeFeather: 0 } } } });
  });

  // ------------------------------------------------------------------ camera select
  function renderCamSelect() {
    const sel = $('#camSelect');
    const devs = (status && status.camera && status.camera.devices) || [];
    const cur = settings ? settings.camera.deviceId : '';
    const html = `<option value="">Default camera</option>` + devs.map(d => `<option value="${esc(d.deviceId)}">${esc(d.label)}</option>`).join('') +
      (cur && !devs.some(d => d.deviceId === cur) ? `<option value="${esc(cur)}">${esc(settings.camera.label || 'Saved camera (not connected)')}</option>` : '');
    if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
    sel.value = cur;
  }
  $('#camSelect').addEventListener('change', (e) => {
    const opt = e.target.selectedOptions[0];
    savePatch({ camera: { deviceId: e.target.value, label: e.target.value ? opt.textContent : '' } });
  });

  // ------------------------------------------------------------------ preview stage
  async function startPreviewCamera() {
    const key = JSON.stringify([settings.camera.demoMode, settings.camera.deviceId, settings.camera.rotation]);
    if (key === pvKey) return; pvKey = key;
    if (pvStream) { pvStream.getTracks().forEach(t => t.stop()); pvStream = null; }
    let note = '';
    if (!settings.camera.demoMode && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      try {
        const v = { width: { ideal: 1280 }, height: { ideal: 720 } };
        if (settings.camera.deviceId) v.deviceId = { ideal: settings.camera.deviceId };
        pvStream = await navigator.mediaDevices.getUserMedia({ video: v, audio: false });
        if (pvDemo) { pvDemo.stop(); pvDemo = null; }
        pvCam.srcObject = pvStream; note = 'Preview uses the live webcam.';
      } catch (e) { note = 'Webcam unavailable here (' + (e.name || e.message) + ') — the booth display may be using it. Showing the demo feed; use “Show placement on booth screen” to check against the real camera.'; }
    } else note = settings.camera.demoMode ? 'Demo camera mode.' : '';
    if (!pvStream) { if (pvDemo) pvDemo.stop(); pvDemo = new DemoCamera(1280, 720, camRot()); pvCam.srcObject = pvDemo.stream; }
    pvCam.play().catch(() => {});
    $('#pvSource').textContent = note;
  }
  function camRot() { const r = settings ? +settings.camera.rotation : 0; return [90, 180, 270].includes(r) ? r : 0; }
  // Preview as a landscape or a portrait (tall) main display. Remembered in this browser.
  let pvOrient = null;
  try { pvOrient = localStorage.getItem('sb.pvOrient'); } catch (_) {}
  function orient() { return pvOrient || (camRot() === 90 || camRot() === 270 ? 'portrait' : 'landscape'); }
  $('#pvOrient').addEventListener('click', (e) => {
    const b = e.target.closest('[data-orient]'); if (!b) return;
    pvOrient = b.dataset.orient; try { localStorage.setItem('sb.pvOrient', pvOrient); } catch (_) {}
    sizePreview();
  });

  function sizePreview() {
    const raw = pvCam.videoWidth && pvCam.videoHeight ? pvCam.videoWidth / pvCam.videoHeight : 16 / 9;
    const side = camRot() === 90 || camRot() === 270, a = side ? 1 / raw : raw;
    const portraitView = orient() === 'portrait';
    $$('#pvOrient [data-orient]').forEach(b => b.classList.toggle('on', b.dataset.orient === orient()));
    pvScreen.classList.toggle('portrait', portraitView);
    if (portraitView) {
      // Lay the camera picture out exactly as the portrait main display does (see display.js layout()).
      const fw = Math.round(Math.min(pvScreen.parentElement.clientWidth, window.innerHeight * 0.72 * 9 / 16));
      const fh = Math.round(fw * 16 / 9);
      pvScreen.style.width = fw + 'px';
      const cover = !settings || settings.camera.fit !== 'contain';
      const windowed = a > 1 && (!settings || settings.camera.portraitLayout !== 'fill');
      let w, h, top;
      if (windowed) { w = fw; h = fw / a; top = Math.round(Math.min(fh * 0.36, fh - h - fh * 0.30)); }
      else { if ((fw / fh > a) === cover) { w = fw; h = fw / a; } else { h = fh; w = fh * a; } top = (fh - h) / 2; }
      Object.assign(pvStage.style, { aspectRatio: '', width: w + 'px', height: h + 'px', left: (fw - w) / 2 + 'px', top: top + 'px', margin: '' });
    } else {
      pvScreen.style.width = '';
      Object.assign(pvStage.style, { aspectRatio: a, height: '', left: '', top: '' });
      // a tall (sideways camera) preview is kept to a sensible height
      pvStage.style.width = side ? Math.round(Math.min(pvScreen.parentElement.clientWidth, window.innerHeight * 0.7 * a)) + 'px' : '';
      pvStage.style.margin = side ? '0 auto' : '';
    }
    const r = pvStage.getBoundingClientRect(); renderer.resize(r.width, r.height);
    const mirror = settings && settings.camera.mirrorPreview ? 'scaleX(-1) ' : '';
    if (side) Object.assign(pvCam.style, { width: r.height + 'px', height: r.width + 'px', left: (r.width - r.height) / 2 + 'px', top: (r.height - r.width) / 2 + 'px', right: 'auto', bottom: 'auto', transform: `${mirror}rotate(${camRot()}deg)` });
    else Object.assign(pvCam.style, { width: '', height: '', left: '', top: '', right: '', bottom: '', transform: `${mirror}rotate(${camRot()}deg)` });
  }
  pvCam.addEventListener('loadedmetadata', sizePreview);
  new ResizeObserver(sizePreview).observe(pvScreen.parentElement);

  // drag to place, wheel to resize
  let drag = null;
  pvStage.addEventListener('pointerdown', (e) => {
    if (!profile) return;
    pvStage.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, y: e.clientY, px: profile.placement.x, py: profile.placement.y };
  });
  pvStage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = pvStage.getBoundingClientRect();
    profile.placement.x = +(drag.px + (e.clientX - drag.x) / r.width).toFixed(4);
    profile.placement.y = +(drag.py + (e.clientY - drag.y) / r.height).toFixed(4);
    renderer.setProfile(profile); syncPlacementInputs(); lastLocalEdit = performance.now();
    throttledSave('drag', () => saveProfile('placement', { x: profile.placement.x, y: profile.placement.y }), 100);
  });
  pvStage.addEventListener('pointerup', () => { drag = null; });
  pvStage.addEventListener('wheel', (e) => {
    if (!profile) return; e.preventDefault();
    profile.placement.scale = +Math.min(2.5, Math.max(0.1, profile.placement.scale * (1 - e.deltaY * 0.001))).toFixed(3);
    renderer.setProfile(profile); syncPlacementInputs(); lastLocalEdit = performance.now();
    throttledSave('wheel', () => saveProfile('placement', { scale: profile.placement.scale }), 120);
  }, { passive: false });
  function syncPlacementInputs() {
    for (const k of ['x', 'y', 'scale']) {
      const el = $(`[data-profile="placement.${k}"]`); el.value = profile.placement[k];
      $(`output[data-for="placement.${k}"]`).textContent = fmt(profile.placement[k]);
    }
  }

  $('#playHere').addEventListener('click', async () => {
    if (!renderer.ready) return toast('The scare hasn’t loaded yet.');
    await audio.resume();
    renderer.setPreview(false);
    try { const { done } = await renderer.show(); await done; } finally { renderer.setPreview(true, true); }
  });

  // ------------------------------------------------------------------ booth commands
  async function cmd(body) {
    try { await api('/api/admin/command', { json: body }); return true; } catch (e) { toast(e.message); return false; }
  }
  for (const b of $$('[data-cmd]')) b.addEventListener('click', () => cmd({ cmd: b.dataset.cmd }).then(ok => ok && log('Sent ' + b.dataset.cmd)));
  $('#testScare').addEventListener('click', async () => { if (await cmd({ cmd: 'testScare', capture: true })) log('Test scare sent to booth…'); });
  $('#pvOnDisplay').addEventListener('change', (e) => cmd({ cmd: 'previewOverlay', on: e.target.checked }));
  $('#openDisplay').addEventListener('click', () => window.open('/display', 'scarebooth-display', 'popup'));
  $('#cancelSession').addEventListener('click', async () => {
    if (!confirm('Cancel the guest session in progress? Photos already taken stay saved.')) return;
    try { await api('/api/admin/cancel', { json: {} }); log('Session cancelled'); } catch (e) { toast(e.message); }
  });
  $('#resetAll').addEventListener('click', async () => {
    if (!confirm('Reset every setting (prompts, timing, placement…) to the defaults? Uploaded files are kept.')) return;
    try { onSettings(await api('/api/settings/reset', { json: {} })); toast('Settings reset.', true); } catch (e) { toast(e.message); }
  });

  $('#stripPreviewBtn').addEventListener('click', async () => {
    const vw = pvCam.videoWidth || 1280, vh = pvCam.videoHeight || 720, rot = camRot(), side = rot === 90 || rot === 270;
    const c = document.createElement('canvas'); c.width = side ? vh : vw; c.height = side ? vw : vh;
    const shots = [];
    for (let i = 0; i < 4; i++) {
      if (pvDemo) pvDemo.setPose(i); if (i === 3 && pvDemo) pvDemo.scare();
      await sleep(i === 3 ? 450 : 250);
      const x = c.getContext('2d'); x.save();
      if (settings.camera.mirrorSaved) { x.translate(c.width, 0); x.scale(-1, 1); }
      x.translate(c.width / 2, c.height / 2); x.rotate(rot * Math.PI / 180); x.drawImage(pvCam, -vw / 2, -vh / 2, vw, vh); x.restore();
      shots.push(c.toDataURL('image/jpeg', 0.85));
    }
    if (pvDemo) pvDemo.setPose(0);
    try {
      const { canvas } = await SBStrip.buildStrip({ photos: shots.slice(0, 3), reaction: shots[3], strip: { ...settings.strip, theme: settings.theme.name } });
      $('#stripPreview').src = canvas.toDataURL('image/jpeg', 0.8);
    } catch (e) { toast(e.message); }
  });

  // ------------------------------------------------------------------ status
  function pill(id, ok, warn) { const p = $(id); p.className = 'pill ' + (ok ? 'ok' : warn ? '' : 'bad'); }
  function onStatus(s) {
    status = s;
    if (s.lastScarePerf) showScarePerf(s.lastScarePerf);
    pill('#pDisplay', s.displayOnline);
    pill('#pCamera', s.displayOnline && s.camera.ok);
    pill('#pIpad', s.clients.controller > 0, true);
    pill('#pSound', s.displayOnline && s.camera.audio, !s.displayOnline);
    $('#pIpad').lastChild.textContent = s.clients.controller > 1 ? `iPad ×${s.clients.controller}` : 'iPad';
    $('#stPhase').textContent = s.phase;
    $('#stSession').textContent = s.sessionId || '';
    const cam = s.camera;
    $('#stCamera').innerHTML = s.displayOnline
      ? `${esc(cam.label || '—')}${cam.width ? ` <span class="muted">${cam.width}×${cam.height}</span>` : ''}<div class="small ${cam.ok ? 'muted' : ''}" style="${cam.ok ? '' : 'color:#ff9a9a'}">${esc(cam.message || '')}</div>` +
        (cam.audio ? '' : '<div class="small" style="color:#f3d6a0">Sound is locked on the display — click the display window once (start-scarebooth.bat avoids this).</div>')
      : '<span style="color:#ff9a9a">Display window not open.</span> <span class="muted small">Click “Open display window”, or run start-scarebooth.bat.</span>';
    if (cam.scareMessage) $('#stScare').innerHTML += `<div class="small" style="color:#ff9a9a">Display: ${esc(cam.scareMessage)}</div>`;
    $('#stUrls').innerHTML = s.urls.length ? s.urls.map(u => `<a href="${esc(u.url)}" target="_blank">${esc(u.url)}</a>`).join('') : '<span class="muted">No network found — connect this PC to Wi-Fi.</span>';
    renderCamSelect();
    // QR host choices
    const hs = $('#shareHost');
    const hostHtml = `<option value="">Automatic (${esc(s.shareHost)})</option>` + s.urls.map(u => `<option value="${esc(u.ip)}">${esc(u.ip)} — ${esc(u.iface)}</option>`).join('');
    if (hs.dataset.html !== hostHtml) { hs.innerHTML = hostHtml; hs.dataset.html = hostHtml; if (settings) hs.value = settings.share.host; }
    $('#printCount').textContent = `Sheets printed: ${s.prints}`;
    renderLights(s.lights); renderWiz(s.wiz); renderMicSelect();
    const t = s.tunnel || {};
    const label = { online: 'Internet link online', starting: 'Connecting…', offline: 'Internet link offline', missing: 'Tunnel tool not installed', off: 'Internet link off (booth Wi-Fi only)' }[t.status] || t.status;
    const ts = $('#tunnelStatus');
    ts.className = 'tunnel-status ' + (t.status || '');
    ts.innerHTML = `<b><span class="dot"></span>${esc(label)}</b>` +
      (t.status === 'online' ? `<div class="muted small">Guests can download from any phone. Current address: <a href="${esc(t.url)}/healthz" target="_blank">${esc(t.url)}</a></div>` : '') +
      (t.message ? `<div class="muted small">${esc(t.message)}</div>` : '');
  }
  // ---- lights
  async function loadLightPorts() {
    try {
      const r = await api('/api/lights/ports');
      const sel = $('#lightsPort'), cur = settings ? settings.lights.port : 'auto';
      sel.innerHTML = r.ports.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('') +
        (cur && !r.ports.some(p => p.id === cur) ? `<option value="${esc(cur)}">${esc(cur)} (not found)</option>` : '');
      sel.value = cur;
    } catch (e) { toast(e.message); }
  }
  $('#lightsRefresh').addEventListener('click', loadLightPorts);
  $('#lightsReconnect').addEventListener('click', () => api('/api/lights/reconnect', { json: {} }).then(() => toast('Reconnecting to the lights…', true)).catch(e => toast(e.message)));
  for (const b of $$('[data-light]')) b.addEventListener('click', async () => {
    if (!settings.lights.enabled && !settings.wiz.enabled) return toast('Turn on the lights box or the WiZ bulb first.');
    const ms = b.dataset.light === 'scare' ? Math.round(settings.timing.burstDurationSec * 1000 + settings.lights.scareFlashExtraMs) : settings.timing.flashMs;
    try { await api('/api/lights/cue', { json: { cue: b.dataset.light, ms } }); } catch (e) { toast(e.message); }
    if (b.dataset.light === 'scare') setTimeout(() => api('/api/lights/cue', { json: { cue: 'session' } }).catch(() => {}), ms + settings.lights.revertDelayMs);
  });
  setTimeout(loadLightPorts, 600);
  function renderLights(L) {
    if (!L) return;
    const st = $('#lightsStatus');
    st.className = 'tunnel-status ' + (!L.enabled ? 'off' : L.connected ? 'online' : 'offline');
    st.innerHTML = `<b><span class="dot"></span>${!L.enabled ? 'Lights control is off' : L.connected ? 'Connected — ' + esc(L.device || '') + ' on ' + esc(L.port || '') : 'Not connected'}</b>` + (L.message ? `<div class="muted small">${esc(L.message)}</div>` : '');
    const k = L.look || {};
    let room = (k.room || 0) / 255;
    const ls = (settings && settings.lights) || {};
    if (ls.relayInvert) room = 1 - room;
    const rc = ls.relayMode === 'scare' ? '255, 40, 50' : '255, 236, 200';
    $('#lpRoom span').textContent = ls.relayMode === 'scare' ? 'Scare relay (pin 10)' : 'Room light';
    $('#lpRoom i').style.background = `rgba(${rc}, ${0.08 + 0.92 * room})`;
    $('#lpRoom i').style.boxShadow = room ? `0 0 ${Math.round(24 * room)}px rgba(${rc},${room})` : 'none';
    const [r, g, b] = k.strip || [0, 0, 0];
    $('#lpStrip i').style.background = `rgb(${r},${g},${b})`;
    $('#lpStrip i').style.boxShadow = (r + g + b) ? `0 0 18px rgb(${r},${g},${b})` : 'none';
    $('#lpStrip').classList.toggle('breathe', k.stripMode === 'breathe');
    const f = (k.flash || 0) / 255;
    $('#lpFlash i').style.background = f ? `rgba(255,255,255,${0.3 + 0.7 * f})` : '#1a1112';
    $('#lpFlash i').style.boxShadow = f ? '0 0 30px #fff' : 'none';
  }

  // ---- WiZ bulb
  function renderWiz(W) {
    if (!W) return;
    const st = $('#wizStatus'), on = W.bulbs.filter(b => b.online).length;
    st.className = 'tunnel-status ' + (!W.enabled ? 'off' : on ? 'online' : 'offline');
    st.innerHTML = `<b><span class="dot"></span>${!W.enabled ? 'WiZ control is off' : !W.bulbs.length ? 'No bulb set' : on === W.bulbs.length ? 'Connected — ' + W.bulbs.map(b => esc(b.ip)).join(', ') : `${on} of ${W.bulbs.length} bulb(s) answering`}</b>` +
      (W.bulbs.length > 1 || (W.enabled && on < W.bulbs.length) ? `<div class="muted small">${W.bulbs.map(b => `${esc(b.ip)}: ${b.online ? 'online' : 'not answering'}`).join(' · ')}</div>` : '') +
      (W.message && !(W.enabled && W.bulbs.length && on) ? `<div class="muted small">${esc(W.message)}</div>` : '');
    const k = W.look || {}, i = $('#lpWiz i');
    if (k.on && W.enabled) { const a = 0.35 + 0.65 * (k.dimming || 0) / 100; i.style.background = k.color; i.style.opacity = a; i.style.boxShadow = `0 0 26px ${k.color}`; }
    else { i.style.background = '#1a1112'; i.style.opacity = 1; i.style.boxShadow = 'none'; }
  }
  $('#wizFind').addEventListener('click', async (e) => {
    const btn = e.currentTarget, box = $('#wizFound');
    btn.disabled = true; btn.textContent = 'Searching…';
    try {
      const r = await api('/api/wiz/discover', { json: {} });
      box.hidden = false;
      box.innerHTML = r.bulbs.length
        ? r.bulbs.map(b => `<div><b>${esc(b.ip)}</b> <span class="muted small">${esc(b.module || '')} ${esc(b.mac || '')}</span> <button class="btn small ghost" data-wiz-ip="${esc(b.ip)}">Use</button></div>`).join('')
        : '<span class="muted small">No WiZ bulbs answered. Check the bulb is on, set up in the WiZ app, and on the same router as this PC (not a guest network).</span>';
      for (const u of $$('[data-wiz-ip]', box)) u.addEventListener('click', () => {
        const cur = (settings.wiz.bulbs || '').split(/[\s,;]+/).filter(Boolean);
        if (!cur.includes(u.dataset.wizIp)) cur.push(u.dataset.wizIp);
        savePatch({ wiz: { bulbs: cur.join(', '), enabled: true } });
        toast('Bulb added — press “Test jump-scare lights”.', true);
      });
    } catch (err) { toast(err.message); }
    btn.disabled = false; btn.textContent = 'Find bulbs';
  });

  // ---- microphones (listed by the display page)
  function renderMicSelect() {
    const sel = $('#micSelect');
    const mics = (status && status.camera && status.camera.mics) || [];
    const cur = settings ? settings.record.micId : '';
    const html = `<option value="">Default microphone</option>` + mics.map(m => `<option value="${esc(m.deviceId)}">${esc(m.label)}</option>`).join('') +
      (cur && !mics.some(m => m.deviceId === cur) ? `<option value="${esc(cur)}">${esc(settings.record.micLabel || 'Saved microphone (not connected)')}</option>` : '');
    if (sel.dataset.html !== html) { sel.innerHTML = html; sel.dataset.html = html; }
    sel.value = cur;
  }
  $('#micSelect').addEventListener('change', (e) => {
    const opt = e.target.selectedOptions[0];
    savePatch({ record: { micId: e.target.value, micLabel: e.target.value ? opt.textContent : '' } });
  });

  $('#restartLink').addEventListener('click', async () => { try { await api('/api/admin/restart-link', { json: {} }); toast('Restarting the internet link…', true); } catch (e) { toast(e.message); } });
  $('#resetPrints').addEventListener('click', async () => { if (confirm('Reset the printed-sheets counter to 0?')) { try { await api('/api/admin/reset-prints', { json: {} }); } catch (e) { toast(e.message); } } });

  SB.connect('admin', {
    settings: onSettings,
    status: onStatus,
    testResult: (r) => {
      if (r.kind === 'print') { toast(r.message, r.ok !== false); log(r.message); return; }
      if (!r.ok) { toast('Test scare failed: ' + r.error); log('Test failed: ' + r.error); return; }
      const msg = `Test scare OK — visible ${r.scareStartToVisibleMs} ms after trigger; ${r.frames} reaction frames over ${(r.burstSpanMs / 1000).toFixed(2)} s` +
        (r.frames ? ` (saved in data\\tests\\${r.run})` : '') + (r.soundEnabled ? '' : ' — SOUND IS LOCKED on the display');
      toast(msg, r.soundEnabled, 9000); log(msg);
    },
    scarePerf: showScarePerf,
    connection: (on) => { connected = on; pill('#pServer', on); if (!on) toast('Lost connection to the ScareBooth server. Is its window still open?'); },
  });

  /** How smoothly the last scare played on the booth screen, with a plain-language reason if it lagged. */
  function showScarePerf(p) {
    const el = $('#scarePerf'); if (!p || !p.at) return;
    const smooth = p.fps >= 45 && p.stalls <= 2, ok = p.fps >= 28 && p.stalls <= 6;
    const tips = [];
    if (p.software) tips.push('<b>Graphics acceleration is OFF in the browser</b>, so the processor draws everything. In Chrome or Edge: Settings → System → turn on <i>Use graphics acceleration when available</i>, then restart ScareBooth.');
    if (!p.software && p.dropped > 3) tips.push(`The scare clip itself is hard to decode (${p.dropped} frames dropped${p.clip && p.clip !== 'image' ? ', clip ' + esc(p.clip) : ''}). Use a smaller clip (720p–1080p, 30 fps) or a green-screen MP4 with chroma key.`);
    if (!ok && !p.software && p.recording) tips.push('The PC is busy during the scare. Set <i>Session video size</i> to 720p (Session video card), plug the laptop into power, close other apps, and set Windows power mode to <i>Best performance</i>.');
    if (!ok && !tips.length) tips.push('The PC is struggling to draw the screen. Plug the laptop into power, close other apps, and set Windows power mode to <i>Best performance</i>.');
    el.hidden = false;
    el.className = 'scare-perf ' + (smooth ? 'good' : ok ? '' : 'bad');
    el.innerHTML = `<b>Last ${p.test ? 'test ' : ''}scare: ${smooth ? 'smooth' : ok ? 'a little uneven' : 'laggy'}</b> — screen ${Math.round(p.fps)} fps, ` +
      `clip ${Math.round(p.videoFps)} fps, longest pause ${Math.round(p.worstMs)} ms.<br><span class="muted">Graphics: ${esc(p.gpu || 'unknown')}</span>` +
      (smooth ? '' : '<br>' + tips.join('<br>'));
  }

  let lastPrinters = null;
  function updateDnpNote() {
    const name = (settings && settings.print.printerName) || (lastPrinters && lastPrinters.default) || '';
    const el = $('#dnpNote'); if (el) el.hidden = !/dnp|ds-?rx1|ds-?620|ds-?40|ds-?820/i.test(name);
  }
  async function loadPrinters() {
    const sel = $('#printerSelect'), note = $('#printerNote');
    note.textContent = 'Looking for printers…';
    try {
      const r = await api('/api/printers');
      const cur = settings ? settings.print.printerName : '';
      sel.innerHTML = `<option value="">Windows default printer${r.default ? ' (' + esc(r.default) + ')' : ''}</option>` +
        r.printers.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('') +
        (cur && !r.printers.includes(cur) ? `<option value="${esc(cur)}">${esc(cur)} (not found)</option>` : '');
      sel.value = cur;
      const pdfDefault = !cur && /pdf|xps|onenote|fax/i.test(r.default || '');
      lastPrinters = r;
      updateDnpNote();
      note.innerHTML = pdfDefault ? '<span style="color:#f3d6a0">The Windows default is a PDF/virtual printer — pick your photo printer above.</span>' : `${r.printers.length} printer(s) found.`;
    } catch (e) {
      sel.innerHTML = `<option value="${esc(settings ? settings.print.printerName : '')}">${esc((settings && settings.print.printerName) || 'Windows default printer')}</option>`;
      note.textContent = e.message;
    }
  }
  $('#refreshPrinters').addEventListener('click', loadPrinters);
  setTimeout(loadPrinters, 800);

  api('/api/sessions').then(r => { $('#dataDir').textContent = 'Photos are stored in: ' + r.sessionsDir; }).catch(() => {});
  window.__admin = { renderer };
})();
