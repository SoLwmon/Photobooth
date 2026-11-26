// ScareBooth display (booth monitor). Owns the camera, countdowns, the scare and all captures.
(function () {
  'use strict';
  const { $, $$, api, sleep, esc } = SB;

  const video = $('#cam');
  const stage = $('#stage');
  const audio = new SBAudio();
  const renderer = new ScareRenderer($('#scare'), { audio });

  let settings = null, scareDesc = null, sounds = [], state = { phase: 'idle' };
  let stream = null, demo = null, camToken = 0, camRetryTimer = null;
  let camera = { ok: false, message: 'Starting camera…', label: '', devices: [] };
  let busy = false, runToken = 0, previewOn = false;
  let scareMessage = '';

  // ------------------------------------------------------------------ layout
  /** Camera rotation (clockwise degrees) that turns a sideways-mounted webcam's picture upright. */
  function camRot() { const r = settings ? +settings.camera.rotation : 0; return [90, 180, 270].includes(r) ? r : 0; }
  const sideways = () => camRot() === 90 || camRot() === 270;

  function layout() {
    const vw = window.innerWidth, vh = window.innerHeight;
    const raw = (video.videoWidth && video.videoHeight) ? video.videoWidth / video.videoHeight : 16 / 9;
    const aspect = sideways() ? 1 / raw : raw; // shape of the picture after turning it upright
    const cover = !settings || settings.camera.fit !== 'contain';
    let w, h, top;
    // Portrait monitor + landscape camera: the camera picture spans the screen width, with the
    // question above it and the countdown on the picture (settings.camera.fit 'cover' crops it to fill instead).
    const tall = vh > vw * 1.15;
    // a landscape picture on a tall screen sits in a window across the middle (unless "fill" is chosen);
    // an upright (sideways-mounted) camera simply fills the screen.
    const windowed = tall && aspect > 1 && (!settings || settings.camera.portraitLayout !== 'fill');
    document.body.classList.toggle('portrait', tall);
    document.body.classList.toggle('cam-window', windowed);
    if (windowed) {
      w = vw; h = vw / aspect;
      top = Math.round(Math.min(vh * 0.36, vh - h - vh * 0.30));
    } else {
      if ((vw / vh > aspect) === cover) { w = vw; h = vw / aspect; } else { h = vh; w = vh * aspect; }
      top = (vh - h) / 2;
    }
    Object.assign(stage.style, { width: w + 'px', height: h + 'px', left: (vw - w) / 2 + 'px', top: top + 'px' });
    // The <video> keeps the camera's own (sideways) shape and is turned upright with CSS.
    const mirror = settings && settings.camera.mirrorPreview ? 'scaleX(-1) ' : '';
    if (sideways()) Object.assign(video.style, { width: h + 'px', height: w + 'px', left: (w - h) / 2 + 'px', top: (h - w) / 2 + 'px', right: 'auto', bottom: 'auto', transform: `${mirror}rotate(${camRot()}deg)` });
    else Object.assign(video.style, { width: '', height: '', left: '', top: '', right: '', bottom: '', transform: `${mirror}rotate(${camRot()}deg)` });
    document.body.classList.toggle('cam-tall', aspect < 1);
    document.body.style.setProperty('--stage-top', top + 'px');
    document.body.style.setProperty('--stage-bottom', (top + h) + 'px');
    document.body.style.setProperty('--stage-h', h + 'px');
    renderer.resize(w, h);
  }
  window.addEventListener('resize', layout);
  video.addEventListener('loadedmetadata', layout);
  video.addEventListener('resize', layout);

  // ------------------------------------------------------------------ reporting
  function report(body) { return api('/api/display/report', { json: body }).catch(e => console.warn('report failed', e)); }
  function logRemote(message) { report({ type: 'log', message }); }
  async function reportCamera() {
    let devices = camera.devices;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      devices = all.filter(d => d.kind === 'videoinput').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Camera ${i + 1}` }));
      camera.devices = devices;
      camera.mics = all.filter(d => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications').map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Microphone ${i + 1}` }));
    } catch (_) {}
    report({ type: 'camera', ok: camera.ok, message: camera.message, label: camera.label, width: video.videoWidth, height: video.videoHeight, demo: !!demo, devices, mics: camera.mics || [], scareMessage, audio: audio.running });
  }

  // ------------------------------------------------------------------ camera
  const RES = { '720p': [1280, 720], '1080p': [1920, 1080], '4k': [3840, 2160] };

  function cameraErrorMessage(e) {
    switch (e && e.name) {
      case 'NotAllowedError': case 'SecurityError':
        return 'Camera permission was denied. Click the camera icon in the browser’s address bar, choose “Allow”, then press Retry. (Starting with start-scarebooth.bat grants this automatically.)';
      case 'NotReadableError': case 'TrackStartError': case 'AbortError':
        return 'The webcam is busy or blocked — another app (Zoom, Teams, OBS, the Windows Camera app) may be using it, or Windows privacy settings block camera access for desktop apps. Close other apps, then press Retry.';
      case 'NotFoundError': case 'DevicesNotFoundError':
        return 'No webcam was found. Plug in the camera and press Retry, or switch on “Demo camera” in the operator console to test without one.';
      case 'OverconstrainedError':
        return 'The camera doesn’t support the requested resolution. Pick a lower resolution in the operator console.';
      default:
        return (e && e.message) || 'Unknown camera error.';
    }
  }

  function stopStream() {
    if (stream) { stream.getTracks().forEach(t => { t.onended = null; t.stop(); }); stream = null; }
  }

  async function startCamera() {
    if (typeof demotedNow !== 'undefined' && demotedNow) return; // a newer display window has the webcam
    const token = ++camToken;
    clearTimeout(camRetryTimer);
    stopStream();
    camera.ok = false; camera.message = 'Starting camera…';
    try {
      if (settings.camera.demoMode) {
        if (!demo) demo = new DemoCamera(1280, 720, camRot());
        video.srcObject = demo.stream;
        await video.play().catch(() => {});
        camera = { ...camera, ok: true, message: 'Demo camera active', label: demo.label };
      } else {
        if (demo) { demo.stop(); demo = null; }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
          throw new Error('This browser blocks camera access on this address. Open the display on the booth PC at http://localhost:' + location.port + '/display (not the network IP).');
        }
        const [w, h] = RES[settings.camera.resolution] || RES['1080p'];
        const vc = { width: { ideal: w }, height: { ideal: h }, frameRate: { ideal: 30 } };
        let warn = '';
        let s;
        if (settings.camera.deviceId) {
          try { s = await navigator.mediaDevices.getUserMedia({ video: { ...vc, deviceId: { exact: settings.camera.deviceId } }, audio: false }); }
          catch (e) {
            if (['OverconstrainedError', 'NotFoundError'].includes(e.name)) { warn = 'The selected camera wasn’t found — using the default camera instead. '; }
            else throw e;
          }
        }
        if (!s) s = await navigator.mediaDevices.getUserMedia({ video: vc, audio: false });
        if (token !== camToken) { s.getTracks().forEach(t => t.stop()); return; }
        stream = s;
        video.srcObject = s;
        await video.play().catch(() => {});
        const track = s.getVideoTracks()[0];
        track.onended = () => {
          camera.ok = false; camera.message = 'The camera was disconnected. Reconnecting…';
          showCameraError(camera.message); reportCamera();
          camRetryTimer = setTimeout(() => startCamera(), 3000);
        };
        camera = { ...camera, ok: true, message: warn + 'Camera running', label: track.label || 'Webcam' };
      }
      if (video.readyState < 2) await Promise.race([new Promise(r => video.addEventListener('loadeddata', r, { once: true })), sleep(5000)]);
      if (!video.videoWidth) throw new Error('The camera started but isn’t sending any picture. Try another USB port or camera.');
      showCameraError(null);
      layout();
    } catch (e) {
      if (token !== camToken) return;
      camera.ok = false; camera.message = cameraErrorMessage(e);
      console.error('camera', e);
      showCameraError(camera.message);
      if (!['NotAllowedError', 'SecurityError', 'OverconstrainedError'].includes(e.name)) camRetryTimer = setTimeout(() => startCamera(), 6000);
    }
    reportCamera();
  }
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => { reportCamera(); if (!camera.ok && settings && !settings.camera.demoMode) startCamera(); });
  }
  function showCameraError(msg) {
    $('#sysCamera').classList.toggle('on', !!msg);
    $('#sysCameraMsg').textContent = msg || '';
  }
  $('#retryCam').addEventListener('click', () => startCamera());

  // ------------------------------------------------------------------ settings / scare preload
  function stingKind() {
    const s = settings.sound.sting;
    if (s === 'builtin' || s === 'none') return s;
    return sounds.some(x => x.id === s) ? 'file' : 'builtin';
  }

  let scareRetryTimer = 0, scareFails = 0, demotedNow = false;
  async function applyScare() {
    if (!scareDesc) { scareMessage = 'No scare selected.'; return; }
    if (demotedNow) return;
    clearTimeout(scareRetryTimer);
    try {
      await renderer.load(scareDesc, scareDesc.profile);
      scareMessage = renderer.webglError || ''; scareFails = 0;
    } catch (e) {
      scareMessage = e.message + ' Retrying…'; console.error(e);
      if (scareFails++ < 3 || scareFails % 10 === 0) logRemote('Scare load failed: ' + e.message);
      scareRetryTimer = setTimeout(applyScare, Math.min(30000, 3000 * scareFails)); // try again on its own
    }
    $('#sysScare').textContent = scareMessage; $('#sysScare').classList.toggle('on', !!scareMessage);
    reportCamera();
  }

  async function onSettings(p) {
    const prev = settings;
    settings = p.settings; sounds = p.sounds || [];
    SB.applyTheme(settings); SB.loveParticles($('#love'));
    if (state.phase === 'idle') $('#attractLine').textContent = SB.themeText('attractLine', 'en') + '\n' + SB.themeText('attractLine', 'zh');
    else SB.setLang(SB.getLang());
    const prevScare = scareDesc; scareDesc = p.scare;
    audio.setVolume(settings.sound.volume);
    audio.setScareVolume(settings.sound.scareVolume ?? 1);
    renderer.setAudioOptions({ useVideoAudio: settings.sound.useVideoAudio, stingKind: stingKind() });
    stage.classList.toggle('mirror', settings.camera.mirrorPreview);
    let camChanged = !prev || ['deviceId', 'resolution', 'demoMode'].some(k => prev.camera[k] !== settings.camera[k]);
    if (prev && demo && prev.camera.rotation !== settings.camera.rotation) { demo.stop(); demo = null; camChanged = true; } // demo follows the rotation
    if (camChanged && !busy) startCamera();
    else if (camChanged) setTimeout(() => onSettings(p), 1500);
    layout();
    if (!prevScare || !scareDesc || prevScare.url !== scareDesc.url) await applyScare();
    else renderer.setProfile(scareDesc.profile);
    if (stingKind() === 'file') {
      const s = sounds.find(x => x.id === settings.sound.sting);
      audio.loadSting(s.url).catch(e => logRemote('Sound load failed: ' + e.message));
    }
    const mu = musicUrl();
    if (mu && !demotedNow) audio.loadMusic(mu).then(() => syncMusic()).catch(e => logRemote('Music load failed: ' + e.message));
    syncMusic();
  }

  // ------------------------------------------------------------------ background music
  // Loops all the time. Each stage has its own level (Console → Sound → Music levels): normal while waiting, quieter
  // from Start, fading to nothing by the last question; it cuts out the moment the scare hits and comes back to
  // normal after the scare — then the next couple, and it repeats.
  let musicDoneFor = null; // the session whose scare has happened (music silent until the scare is over)
  function musicUrl() {
    const m = settings && settings.music;
    if (!m || !m.enabled || m.track === 'none') return null;
    if (m.track === 'builtin') return '/assets/music-box-waltz.wav';
    const s = sounds.find(x => x.id === m.track);
    return s ? s.url : '/assets/music-box-waltz.wav';
  }
  function musicStage() {
    const p = state.phase;
    if (p === 'idle') return 'idle';
    if (p === 'intro' || p === 'warning') return 'intro';
    if (p === 'shooting') return musicDoneFor && musicDoneFor === state.sessionId ? null : 'q' + Math.min(5, Math.max(1, (state.shot ?? 0) + 1));
    return 'after'; // composing, choosing, the QR screen
  }
  let musicStageNow = null, musicStarting = false;
  function syncMusic() {
    const m = settings && settings.music;
    // music switched off (or this window handed over to a newer display): silence, even during a test
    if (demotedNow || !musicUrl()) {
      musicTest = false; musicStageNow = null;
      if (audio.musicPlaying) { audio.stopMusic(0.5); logRemote('Music stopped (' + (demotedNow ? 'another display window took over' : 'background music is off') + ')'); }
      return;
    }
    if (musicTest) return;
    const stage = musicUrl() ? musicStage() : null;
    const level = stage ? m.volume * ((m.levels && m.levels[stage]) ?? 100) / 100 : 0;
    if (stage && !audio.musicPlaying) {
      if (musicStarting) return; // already on its way (the sound system is waking up)
      musicStarting = true;
      audio.resume().then(() => {
        musicStarting = false;
        if (demotedNow || !musicUrl() || audio.musicPlaying) return;
        const st = musicStage(); if (!st) return;
        const lv = m.volume * ((m.levels && m.levels[st]) ?? 100) / 100;
        if (audio.playMusic(lv, st === 'after' ? 1.5 : 1)) { musicStageNow = st; logRemote(`Music started (${st}, ${Math.round(lv / (m.volume || 1) * 100)}%)`); }
      });
    } else if (stage && audio.musicPlaying) {
      if (stage !== musicStageNow) audio.setMusicLevel(level, 1.5); // glide to this stage's level
      else audio.setMusicLevel(level, 0.3);
    } else if (!stage && audio.musicPlaying) { audio.stopMusic(0.8); }
    musicStageNow = stage;
  }
  let musicTest = false;
  // the music dips during each countdown and comes back once the photo is taken
  function musicDuck(on) {
    const m = settings && settings.music;
    if (!m || !m.duckCountdown) { audio.duckMusic(false, 1, 0.3); return; }
    if (on) audio.duckMusic(true, m.duckLevel || 0, 0.7); else audio.duckMusic(false, 1, 1.2);
  }
  function musicAtScare() { musicDoneFor = state.sessionId; musicTest = false; musicStageNow = null; if (audio.musicPlaying) logRemote('Music stopped at the jump scare'); audio.stopMusic(0.06); }

  // ------------------------------------------------------------------ UI per phase
  function layerOn(...ids) { for (const el of $$('.layer')) el.classList.toggle('on', ids.includes(el.id)); }
  function showQuestion(question, total, prompt, promptZh) {
    $('#shotNo').textContent = SB.questionLabel(question, total || 5, !!(settings && settings.flow && settings.flow.linkFirstTwo));
    // English question, with the Chinese underneath
    $('#promptText').textContent = prompt || '';
    $('#promptZh').textContent = promptZh || ''; $('#promptZh').hidden = !promptZh;
    const lower = $('#lower');
    lower.classList.remove('counting', 'answering', 'pop'); void lower.offsetWidth; lower.classList.add('pop');
  }

  function onState(s) {
    const prev = state; state = s;
    // the session video ends when the booth goes back to waiting (no QR scan) or a new session begins
    if (rec.mr && (s.phase === 'idle' || (rec.sessionId && s.sessionId && s.sessionId !== rec.sessionId))) { logRemote('Session video stopped (' + (s.phase === 'idle' ? 'back to waiting' : 'new session') + ')'); stopRecording(); }
    if (s.sessionId !== prev.sessionId) musicDoneFor = null;
    syncMusic();
    document.body.className = document.body.className.replace(/\bphase-\S+/g, '').trim() + ' phase-' + s.phase;
    // English and Chinese together (a session could still ask for just one)
    const lang = s.phase === 'idle' ? 'both' : (s.lang || 'both');
    if (SB.getLang() !== lang || !onState.langSet) { SB.setLang(lang); onState.langSet = true; }
    // The live camera is only shown once Start is pressed (it keeps running hidden so the start is instant).
    document.body.classList.toggle('cam-off', ['idle', 'intro', 'warning', 'done'].includes(s.phase));
    if (demo) demo.setPose(Math.max(0, (s.shot || 1) - 1));
    switch (s.phase) {
      case 'idle':
        layerOn('attract');
        $('#attractLine').textContent = SB.themeText('attractLine', 'en') + '\n' + SB.themeText('attractLine', 'zh');
        $('#attractCta').innerHTML = `<span class="l-en">${SB.esc(SB.tr('pressStart', 'en'))}</span><span class="l-zh">${SB.esc(SB.tr('pressStart', 'zh'))}</span>`;
        break;
      case 'intro': {
        const ins = SB.instructionsHtml(settings && settings.instructions, lang);
        $('#introSteps').innerHTML = ins.html;
        for (const el of $$('#intro .intro-default')) el.hidden = ins.hasHeading; // their own heading replaces the default title
        $('#introCta').hidden = ins.hasCta;                                     // and their own "tap to start" line replaces ours
        layerOn('intro'); break;
      }
      case 'warning': layerOn('attract'); $('#attractLine').textContent = SB.themeText('warningAttract'); break;
      case 'shooting':
        // Between photos (before the next shoot command arrives) keep the upcoming question on screen.
        if (!busy) { showQuestion(s.question || s.shot + 1, s.totalQuestions, s.prompt, s.promptZh); layerOn('lower'); }
        break;
      case 'choose': renderChoose(s, prev.phase !== 'choose'); layerOn('choose'); break;
      case 'composing': layerOn('developing'); break;
      case 'done': renderDone(s); layerOn('done'); break;
    }
  }

  function renderDone(s) {
    const src = s.stripUrl + '?v=' + encodeURIComponent(s.sessionId);
    if ($('#stripImg').dataset.src !== src) { $('#stripImg').src = src; $('#stripImg').dataset.src = src; }
    const share = settings && settings.share;
    $('#qrDl').innerHTML = s.shareUrl ? SB.qrSvg(s.shareUrl) : '';
    $('#qrDlBox').hidden = !s.shareUrl;
    // With the internet link up, any phone can open it — no need to join the booth Wi-Fi first.
    const wifi = !s.shareOnline && share && share.wifiSsid && s.shareUrl ? SB.wifiQrText(share) : '';
    $('#qrNote').textContent = s.shareOnline ? ' · ' + SB.tr('mobileData') : '';
    $('#qrWifi').innerHTML = wifi ? SB.qrSvg(wifi) : '';
    $('#qrWifiBox').hidden = !wifi;
    $('#qrWifiName').textContent = share && share.wifiSsid ? share.wifiSsid : '';
    $('#qrStep').textContent = wifi ? '2' : '';
    const strips = s.printCopies * (s.stripsPerPrint || 1), tr = SB.tr;
    const lines = {
      ask: s.printDefault > 0 ? tr('askPrintsDisplayDefault', undefined, { n: s.printDefault }) : tr('askPrintsDisplay'),
      printing: s.printFixed ? (strips === 1 ? tr('printingStrip1') : tr('printingStrips', undefined, { n: strips })) : (s.printCopies === 1 ? tr('printingCopy1') : tr('printingCopies', undefined, { n: s.printCopies })),
      printed: tr('printedDisplay'),
      error: tr('printError'),
    };
    $('#printLine').textContent = lines[s.printStatus] || '';
  }

  // ------------------------------------------------------------------ printing
  // Uses the browser's print system. Launched by start-scarebooth.bat with --kiosk-printing, Chrome/Edge print
  // straight to the Windows default printer with no dialog.
  const PRINT_LAYOUTS = {
    '4x6-double': { size: '4in 6in', w: '4in', perSheet: 2 },  // two strips side by side, cut down the middle
    '4x6-single': { size: '4in 6in', w: '4in', perSheet: 1 },  // one strip centred on 4x6
    '2x6': { size: '2in 6in', w: '2in', perSheet: 1 },         // printers with native 2x6 paper
  };
  function printSheet(url, layout) {
    const L = PRINT_LAYOUTS[layout] || PRINT_LAYOUTS['4x6-double'];
    return new Promise((resolve, reject) => {
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
      document.body.appendChild(f);
      const d = f.contentDocument;
      const imgs = Array.from({ length: L.perSheet }, () => `<img src="${url}">`).join('');
      d.open();
      d.write(`<!doctype html><html><head><style>@page{size:${L.size};margin:0}html,body{margin:0;padding:0;background:#fff}
        .sheet{width:${L.w};height:6in;display:flex;justify-content:center;overflow:hidden}
        img{width:2in;height:6in;object-fit:cover;display:block}</style></head><body><div class="sheet">${imgs}</div></body></html>`);
      d.close();
      const pics = Array.from(d.images);
      const timer = setTimeout(() => reject(new Error('The strip image didn’t load for printing.')), 15000);
      Promise.all(pics.map(im => im.complete ? Promise.resolve() : new Promise((r, j) => { im.onload = r; im.onerror = j; }))).then(() => {
        clearTimeout(timer);
        let finished = false;
        const done = () => { if (finished) return; finished = true; setTimeout(() => f.remove(), 500); resolve(); };
        f.contentWindow.addEventListener('afterprint', done);
        f.contentWindow.focus();
        f.contentWindow.print();
        setTimeout(done, 2500);
      }).catch(() => { clearTimeout(timer); f.remove(); reject(new Error('The strip image didn’t load for printing.')); });
    });
  }
  // Print jobs (guest prints, gallery reprints, test pages) run one after another.
  let printQueue = Promise.resolve();
  function runPrint(cmd) { printQueue = printQueue.then(() => doPrint(cmd)); return printQueue; }
  async function doPrint(cmd) {
    const L = PRINT_LAYOUTS[cmd.layout] || PRINT_LAYOUTS['4x6-double'];
    // 4x6-double: each print is a whole sheet (2 strips, cut by the printer) unless strips are counted singly
    const per = cmd.layout === '4x6-double' && !(settings && settings.print && settings.print.stripsPerPrint === 1) ? 1 : L.perSheet;
    const sheets = Math.ceil(cmd.copies / per);
    try {
      for (let i = 0; i < sheets; i++) { await printSheet(cmd.stripUrl, cmd.layout); await sleep(800); }
      if (cmd.cmd === 'testPrint') report({ type: 'testResult', ok: true, kind: 'print', message: 'Test page sent to the default printer.' });
      else if (cmd.cmd === 'reprint') report({ type: 'reprinted', jobId: cmd.jobId, copies: cmd.copies, sheets });
      else report({ type: 'printed', cmdId: cmd.cmdId, sheets });
    } catch (e) {
      if (cmd.cmd === 'testPrint') report({ type: 'testResult', ok: false, kind: 'print', message: 'Test print failed: ' + e.message, error: e.message });
      else if (cmd.cmd === 'reprint') report({ type: 'reprintFailed', jobId: cmd.jobId, error: e.message });
      else report({ type: 'printFailed', cmdId: cmd.cmdId, error: e.message });
    }
  }

  function renderChoose(s, rebuild) {
    const fs = $('#filmstrip');
    if (rebuild || fs.children.length !== s.reactions.length) {
      fs.innerHTML = s.reactions.map((r, i) => `<img src="${esc(r.thumb)}" data-i="${i}" alt="">`).join('');
    }
    $$('img', fs).forEach((im, i) => im.classList.toggle('sel', i === s.previewIndex));
    const r = s.reactions[s.previewIndex];
    if (r) $('#choosePreview').src = r.url;
  }

  // ------------------------------------------------------------------ capture helpers

  function cameraReady() { return camera.ok && video.readyState >= 2 && video.videoWidth > 0; }

  async function grabFrame() {
    if (!cameraReady()) throw new Error('The camera isn’t ready: ' + camera.message);
    return upright(await createImageBitmap(video));
  }

  /** Turn a captured frame upright (Camera rotation setting). Every saved photo and the best-shot check use this. */
  async function upright(bmp) {
    const r = camRot();
    if (!r) return bmp;
    const side = r === 90 || r === 270, c = document.createElement('canvas');
    c.width = side ? bmp.height : bmp.width; c.height = side ? bmp.width : bmp.height;
    const x = c.getContext('2d');
    x.translate(c.width / 2, c.height / 2); x.rotate(r * Math.PI / 180); x.drawImage(bmp, -bmp.width / 2, -bmp.height / 2);
    bmp.close && bmp.close();
    return createImageBitmap(c);
  }

  async function encode(bmp, quality = 0.92, withThumb = true) {
    const mirror = settings.camera.mirrorSaved;
    const encCanvas = document.createElement('canvas'), thumbCanvas = document.createElement('canvas');
    encCanvas.width = bmp.width; encCanvas.height = bmp.height;
    const c = encCanvas.getContext('2d');
    c.save(); if (mirror) { c.translate(bmp.width, 0); c.scale(-1, 1); } c.drawImage(bmp, 0, 0); c.restore();
    const full = await new Promise(r => encCanvas.toBlob(r, 'image/jpeg', quality));
    let thumb = null;
    if (withThumb) {
      const tw = 480, th = Math.round(480 * bmp.height / bmp.width);
      thumbCanvas.width = tw; thumbCanvas.height = th;
      thumbCanvas.getContext('2d').drawImage(encCanvas, 0, 0, tw, th);
      thumb = await new Promise(r => thumbCanvas.toBlob(r, 'image/jpeg', 0.8));
    }
    bmp.close && bmp.close();
    if (!full) throw new Error('Could not encode the photo.');
    return { full, thumb };
  }

  async function upload(sessionId, name, blob) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try { return await api(`/api/upload?session=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(name)}`, { body: blob, type: 'image/jpeg' }); }
      catch (e) { lastErr = e; await sleep(300 * (attempt + 1)); }
    }
    throw new Error('Saving a photo failed: ' + lastErr.message);
  }

  // While the display is working on a command (including best-shot analysis), keep telling the
  // server it's alive so a slow computer never trips the server's "display stopped responding" timer.
  let workingCmd = null;
  setInterval(() => { if (workingCmd) report({ type: 'alive', cmdId: workingCmd }); }, 4000);

  class Aborted extends Error {}
  function check(token) { if (token !== runToken) throw new Aborted('aborted'); }
  async function wait(ms, token) {
    const end = performance.now() + ms;
    while (performance.now() < end) { await sleep(Math.min(50, end - performance.now())); check(token); }
  }

  /**
   * Countdown over the live feed. If `interruptAt` (a performance.now() time) arrives first, the countdown stops
   * right there and returns true — that's how the final photo's scare cuts in early.
   */
  async function countdown(sec, token, interruptAt = Infinity) {
    layerOn('countdown', 'lower');
    $('#lower').classList.add('counting');
    const num = $('#cdNum'), ring = $('#countdown .ring');
    for (let n = sec; n >= 1; n--) {
      num.textContent = n;
      num.classList.remove('beat'); ring.classList.remove('tick'); void num.offsetWidth;
      num.classList.add('beat'); ring.classList.add('tick');
      audio.heartbeat(0.45);
      const end = performance.now() + 1000;
      while (performance.now() < end) {
        if (performance.now() >= interruptAt) return true;
        await sleep(Math.max(1, Math.min(15, end - performance.now(), interruptAt - performance.now())));
        check(token);
      }
    }
    layerOn('lower');
    return false;
  }

  /** Remove every overlay instantly (no fade), so the scare lands on a clean camera picture. */
  function snapClear() {
    document.body.classList.add('snap');
    layerOn();
    setTimeout(() => document.body.classList.remove('snap'), 700);
  }

  /** The main display flashes full-screen white (or black, see console) for `ms` when the photo is taken, then fades back. */
  function screenFlash(ms) {
    const f = $('#flash');
    f.classList.remove('go', 'shutter');
    if (!settings.timing.shutterFlash) return;
    f.classList.toggle('black', settings.timing.flashColor === 'black');
    f.classList.add('hold');
    setTimeout(() => f.classList.remove('hold'), ms);
  }

  /** Ask the PC to switch the room light / LED strip / flash device (see Lights in the console). */
  function lightCue(cue, extra = {}) { return api('/api/lights/cue', { json: { cue, ...extra } }).catch(() => {}); }

  // Best-shot analysis and uploads for photos 1–3 run in the background while the next question plays.
  // The strip waits for them.
  let pendingWork = Promise.resolve();
  function queueWork(fn) {
    const p = pendingWork.then(fn);
    pendingWork = p.catch(e => { console.error(e); logRemote('Background photo work failed: ' + e.message); });
    return p;
  }

  // ---------------------------------------------------------------- session video (saved on this PC only)
  const rec = { mr: null, sessionId: null, seq: 0, chain: Promise.resolve(), mic: null, ext: 'webm' };
  async function startRecording(sessionId) {
    const R = settings.record || {};
    if (!R.enabled || rec.mr || !video.srcObject || typeof MediaRecorder === 'undefined') return;
    try {
      // The session video is recorded at 720p by default: a quarter of the work of 1080p, which keeps the PC
      // free for the jump scare. (Console → Session video → size.)
      const small = R.size !== 'full';
      let tracks, audioTracks = [];
      if (R.audio) {
        try {
          rec.mic = await navigator.mediaDevices.getUserMedia({ audio: R.micId ? { deviceId: { exact: R.micId } } : true, video: false });
          audioTracks = rec.mic.getAudioTracks();
        } catch (e) { logRemote('Microphone unavailable for the session video: ' + (e.name || e.message)); }
      }
      if (camRot()) tracks = uprightVideoTracks(small);
      else {
        const t = video.srcObject.getVideoTracks()[0];
        if (small && (video.videoHeight > 720 || video.videoWidth > 1280)) {
          const c = t.clone(); rec.clone = c;
          try { await c.applyConstraints({ width: { max: 1280 }, height: { max: 720 }, resizeMode: 'crop-and-scale' }); } catch (_) {}
          tracks = [c];
        } else tracks = [t];
      }
      tracks.push(...audioTracks);
      // H.264 MP4 plays everywhere (Windows Photos, phones); fall back to WebM (open with Chrome or VLC)
      const type = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1.42E01E,opus', 'video/mp4;codecs=avc1', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
        .find(t => MediaRecorder.isTypeSupported(t));
      // a full picture (keyframe) every second, so skipping / fast-forwarding in a video player doesn't smear the picture
      const mr = new MediaRecorder(new MediaStream(tracks), { mimeType: type, videoBitsPerSecond: (R.videoKbps || 4000) * 1000, audioBitsPerSecond: 128000, videoKeyFrameIntervalDuration: 1000 });
      rec.mr = mr; rec.sessionId = sessionId; rec.seq = 0; rec.ext = /mp4/.test(type || '') ? 'mp4' : 'webm';
      const sid = sessionId, ext = rec.ext;
      mr.ondataavailable = (e) => {
        if (!e.data || !e.data.size) return;
        const seq = rec.seq++;
        rec.chain = rec.chain.then(() => api(`/api/video?session=${encodeURIComponent(sid)}&seq=${seq}&ext=${ext}`, { body: e.data, type: 'application/octet-stream' }))
          .catch(err => logRemote('Video chunk upload failed: ' + err.message));
      };
      mr.onstop = () => {
        rec.chain = rec.chain.then(() => api(`/api/video/end?session=${encodeURIComponent(sid)}&ext=${ext}`, { json: {} })).catch(() => {});
        if (rec.mic) { rec.mic.getTracks().forEach(t => t.stop()); rec.mic = null; }
      };
      mr.start(2000);
      if (rec.rot && rec.rot.go) rec.rot.go(); // the upright picture starts flowing now, together with the sound
    } catch (e) { rec.mr = null; logRemote('Could not start the session video: ' + e.message); }
  }
  /** Watch how smoothly the scare plays for `ms` and tell the console (frame rate, stalls, graphics chip). */
  function measureScare(ms, test) {
    const v = renderer.video, q0 = v && v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().droppedVideoFrames : 0;
    let frames = 0, vframes = 0, worst = 0, stalls = 0, last = performance.now(), on = true;
    const t0 = last;
    const tick = (now) => { if (!on) return; const g = now - last; last = now; frames++; if (g > worst) worst = g; if (g > 50) stalls++; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    if (v && v.requestVideoFrameCallback) { const vf = () => { if (!on) return; vframes++; v.requestVideoFrameCallback(vf); }; v.requestVideoFrameCallback(vf); }
    setTimeout(() => {
      on = false;
      const sec = (performance.now() - t0) / 1000;
      const dropped = v && v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().droppedVideoFrames - q0 : 0;
      const prof = settings.scares && settings.scares.active || '';
      report({ type: 'scarePerf', test: !!test, fps: frames / sec, videoFps: v ? vframes / sec : 0, worstMs: worst, stalls, dropped,
        clip: v ? `${v.videoWidth}×${v.videoHeight}` : 'image', gpu: renderer.gpu, software: renderer.softwareGpu, recording: !!rec.mr });
    }, ms);
  }

  function stopRecording() {
    if (rec.mr && rec.mr.state !== 'inactive') { try { rec.mr.requestData(); rec.mr.stop(); } catch (_) {} }
    rec.mr = null;
    if (rec.rot) { const r = rec.rot; rec.rot = null; setTimeout(() => r.stop(), 1200); } // let the recorder take the last frames first
    if (rec.clone) { const c = rec.clone; rec.clone = null; setTimeout(() => c.stop(), 3000); }
  }
  /** With a sideways camera the session video is recorded from an upright copy of the picture. */
  function uprightVideoTracks(small) {
    // Best: turn the frames upright in a background worker, keeping the camera's timestamps
    // (smooth video, sound in sync, unaffected by how busy this page is). Chrome / Edge / Brave.
    try {
      if (window.MediaStreamTrackProcessor && window.MediaStreamTrackGenerator && window.VideoFrame && window.OffscreenCanvas) {
        const r = camRot(), side = r === 90 || r === 270;
        const vw = video.videoWidth, vh = video.videoHeight;
        const k = small ? Math.min(1, 1280 / Math.max(vw, vh)) : 1;
        const outW = Math.round((side ? vh : vw) * k / 2) * 2, outH = Math.round((side ? vw : vh) * k / 2) * 2;
        const src = video.srcObject.getVideoTracks()[0].clone();
        const processor = new MediaStreamTrackProcessor({ track: src });
        const generator = new MediaStreamTrackGenerator({ kind: 'video' });
        const worker = new Worker('/js/rotate-worker.js');
        worker.onmessage = (e) => { if (e.data && e.data.error) logRemote('Session video rotate: ' + e.data.error); };
        worker.postMessage({ readable: processor.readable, writable: generator.writable, rot: r, outW, outH }, [processor.readable, generator.writable]);
        rec.rot = { go() { worker.postMessage({ go: true, at: performance.now() }); }, stop() { try { src.stop(); } catch (_) {} try { generator.stop(); } catch (_) {} setTimeout(() => worker.terminate(), 1500); } };
        return [generator];
      }
    } catch (e) { logRemote('Background video rotation unavailable, using the page: ' + e.message); }
    const r = camRot(), side = r === 90 || r === 270, c = document.createElement('canvas');
    const vw = video.videoWidth, vh = video.videoHeight;
    const k = small ? Math.min(1, 1280 / Math.max(vw, vh)) : 1; // 720 × 1280 for a sideways 1080p camera
    c.width = Math.round((side ? vh : vw) * k); c.height = Math.round((side ? vw : vh) * k);
    const x = c.getContext('2d');
    let on = true, handle = 0;
    const draw = () => {
      if (!on) return;
      x.setTransform(1, 0, 0, 1, 0, 0); x.translate(c.width / 2, c.height / 2); x.rotate(r * Math.PI / 180);
      x.drawImage(video, -vw * k / 2, -vh * k / 2, vw * k, vh * k);
      handle = video.requestVideoFrameCallback ? video.requestVideoFrameCallback(draw) : requestAnimationFrame(draw);
    };
    draw();
    const stream = c.captureStream(30);
    rec.rot = { stop() { on = false; stream.getTracks().forEach(t => t.stop()); } };
    return stream.getVideoTracks();
  }
  window.addEventListener('beforeunload', stopRecording);

  /** The question's answer time: a draining bar under the question. */
  async function answerTime(sec, token) {
    const lower = $('#lower'), fill = $('#answerFill');
    lower.classList.add('answering'); lower.classList.remove('counting');
    fill.style.transition = 'none'; fill.style.transform = 'scaleX(1)'; void fill.offsetWidth;
    fill.style.transition = `transform ${sec}s linear`; fill.style.transform = 'scaleX(0)';
    await wait(sec * 1000, token);
    lower.classList.remove('answering');
  }

  /** Capture `count` frames evenly over `durMs` starting at t0 (performance.now()). */
  async function captureBurst(count, durMs, t0, token, deferUpright = false) {
    const step = count > 1 ? durMs / (count - 1) : 0;
    const shots = [];
    for (let i = 0; i < count; i++) {
      const due = t0 + i * step - performance.now();
      if (due > 1) await sleep(due);
      check(token);
      const offset = performance.now() - t0;
      shots.push(deferUpright ? createImageBitmap(video).then(bmp => ({ bmp, offset })) : createImageBitmap(video).then(upright).then(bmp => ({ bmp, offset })));
    }
    return Promise.all(shots);
  }

  /** How much each burst frame differs from the first one (scare onset): the biggest jump scores highest. */
  function reactionScores(frames) {
    try {
      const w = 64, h = 36, c = document.createElement('canvas'); c.width = w; c.height = h;
      const x = c.getContext('2d', { willReadFrequently: true });
      const gray = (bmp) => { x.drawImage(bmp, 0, 0, w, h); const d = x.getImageData(0, 0, w, h).data; const g = new Float32Array(w * h); for (let i = 0; i < g.length; i++) g[i] = d[i * 4] * 0.3 + d[i * 4 + 1] * 0.59 + d[i * 4 + 2] * 0.11; return g; };
      const base = gray(frames[0].bmp);
      return frames.map((f, k) => { if (!k) return 0; const g = gray(f.bmp); let sum = 0; for (let i = 0; i < g.length; i++) sum += Math.abs(g[i] - base[i]); return Math.round(sum / g.length * 100) / 100; });
    } catch (_) { return []; }
  }

  async function uploadPool(items, worker, size = 3) {
    let i = 0;
    const run = async () => { while (i < items.length) { const k = i++; await worker(items[k], k); } };
    await Promise.all(Array.from({ length: Math.min(size, items.length) }, run));
  }

  // ------------------------------------------------------------------ commands
  async function runShot(cmd) {
    if (busy) { report({ type: 'failed', cmdId: cmd.cmdId, error: 'The display was busy.' }); return; }
    busy = true; const token = ++runToken;
    workingCmd = cmd.cmdId;
    musicDuck(false); // (in case an earlier countdown was interrupted) the music plays while they answer
    if (previewOn) { renderer.setPreview(false); previewOn = false; document.body.classList.remove('previewing'); }
    const t = settings.timing;
    try {
      if (!cameraReady()) throw new Error('The camera isn’t ready (' + camera.message + ').');
      if (cmd.final && !renderer.ready) throw new Error('The scare hasn’t loaded (' + (scareMessage || 'still loading') + ').');
      const question = cmd.question || cmd.shot + 1;
      if (cmd.shot === 0 || (cmd.shot === 1 && !rec.mr)) { pendingWork = Promise.resolve(); startRecording(cmd.sessionId); }
      // 1) the question pops up at the top, 2) answer time, 3) countdown (the question goes away), 4) flash + photo burst
      showQuestion(question, cmd.totalQuestions, cmd.prompt || state.prompt, cmd.promptZh ?? state.promptZh);
      layerOn('lower');
      await wait(700, token); // let the question land before the timer starts
      const answerSec = cmd.answerSec ?? (t.answerSecs ? t.answerSecs[question - 1] : t.answerSec) ?? 0;
      const countdownSec = cmd.countdownSec ?? (t.countdownSecs ? t.countdownSecs[question - 1] : t.countdownSec) ?? 3;
      await answerTime(answerSec, token);
      if (cmd.noPhoto) {
        // question 1: just talk, no photo
        check(token);
        report({ type: 'shotDone', cmdId: cmd.cmdId, shot: 0 });
        return;
      }
      let scareAtMs = 0;
      if (cmd.final) {
        // finish the background best-photo check for photo 3 first, so the scare has the PC to itself
        await Promise.race([pendingWork, sleep(8000)]); check(token);
        // on a countdown number (e.g. while “2” shows), or at a random moment in the range
        const onNum = t.scareOnNumber || 0;
        scareAtMs = onNum > 0 && onNum <= countdownSec
          ? (countdownSec - onNum) * 1000 + (t.scareIntoNumberMs ?? 300)
          : (t.scareAtMinSec + Math.random() * (t.scareAtMaxSec - t.scareAtMinSec)) * 1000;
        const strikeAt = performance.now() + scareAtMs;
        musicDuck(true); // countdown: the music fades out
        const interrupted = await countdown(countdownSec, token, strikeAt);
        if (!interrupted) {
          while (performance.now() < strikeAt) { await sleep(Math.min(15, strikeAt - performance.now())); check(token); }
        }
      } else {
        musicDuck(true); // countdown: the music fades out
        await countdown(countdownSec, token);
      }

      if (!cmd.final) {
        // ---- photos 1–3: burst of frames before, during and after the screen flash; the best one is kept
        const n = Math.max(1, t.shotBurstCount || 8), pre = t.preFlashMs ?? 250, fl = t.flashMs || 700, post = t.postFlashMs ?? 300;
        const t0 = performance.now();
        setTimeout(() => {
          screenFlash(fl); audio.click(); if (demo) demo.flash(fl);
          if (settings.lights && settings.lights.flashOnPhotos) lightCue('flash', { ms: fl });
        }, pre);
        const frames = await captureBurst(n, pre + fl + post, t0, token);
        musicDuck(false); // photo taken: the music comes back
        check(token);
        report({ type: 'shotDone', cmdId: cmd.cmdId, shot: cmd.shot });
        const shot = cmd.shot, sid = cmd.sessionId;
        queueWork(async () => {
          // best moment: right when the countdown reached zero (the shutter), before people relax
          const pick = await SBBest.pick(frames.map(f => f.bmp), { times: frames.map(f => f.offset), idealMs: pre });
          const order = [pick.best, ...frames.map((_, i) => i).filter(i => i !== pick.best)];
          for (const i of order) {
            const { full, thumb } = await encode(frames[i].bmp, i === pick.best ? 0.92 : 0.85, i === pick.best);
            if (i === pick.best) {
              await upload(sid, `photo${shot}.jpg`, full);
              await upload(sid, `thumbs/photo${shot}.jpg`, thumb);
            }
            if (settings.record && settings.record.keepCandidates !== false) await upload(sid, `candidates/photo${shot}_${String(i + 1).padStart(2, '0')}.jpg`, full);
          }
          report({ type: 'shotChosen', sessionId: sid, shot, best: pick.best, offsets: frames.map(f => Math.round(f.offset - pre)), details: pick.details, faceAnalysis: pick.faceAnalysis });
        });
        return;
      }

      // ---- final photo: the scare cuts into the countdown; room light off, LED strip red, flash device on
      check(token);
      const t0 = performance.now();
      const L = settings.lights || {};
      // The screen cuts to black for a moment, then the scare is there when it comes back (0 = no black:
      // the countdown number stays up until the scare's first frame is ready underneath it, then it's gone).
      const blackMs = t.scareBlackoutMs ?? 0, fl = $('#flash');
      if (blackMs > 0) snapClear();
      if (blackMs > 0) { fl.classList.remove('go', 'shutter'); fl.classList.add('black', 'cut', 'hold'); }
      musicAtScare(); // the music cuts out the moment the scare hits
      lightCue('scare', { ms: Math.round(blackMs + (t.burstStartMs ?? 300) + t.burstDurationSec * 1000 + (L.scareFlashExtraMs ?? 400)) });
      // the scare starts loading at the same moment the screen goes black, so the black only lasts `blackMs`
      const shown = renderer.show();
      if (blackMs > 0) await sleep(blackMs);
      const { done } = await shown; // first scare frame is painted (still behind the black)
      if (blackMs > 0) {
        fl.classList.remove('hold'); setTimeout(() => fl.classList.remove('cut'), 150);
        renderer._showStart = performance.now(); // entrance animation (lunge…) starts as the black lifts
        await new Promise(r => requestAnimationFrame(r));
      } else {
        snapClear(); // the countdown vanishes in the same frame the scare is there
        renderer._showStart = performance.now();
        await new Promise(r => requestAnimationFrame(r));
      }
      const visibleAt = performance.now();
      measureScare(Math.min(2500, t.burstDurationSec * 1000), false);
      if (demo) demo.scare();
      // Only grab raw frames while the scare plays (turning them upright waits until it's over), so nothing
      // competes with the scare video for the graphics card.
      // the photos start a moment after the scare appears (people need ~0.3 s to react) and run through the scare
      const frames = await captureBurst(t.burstCount, t.burstDurationSec * 1000, visibleAt + (t.burstStartMs ?? 300), token, true);
      // the last picture is taken: put the lights back to normal. The session video keeps recording through the
      // strip and QR screen; it stops a moment after the guests open the QR link (or when the booth goes back to waiting).
      setTimeout(() => lightCue('session'), L.revertDelayMs ?? 300);
      await Promise.race([done, sleep(4000)]); // let the scare finish playing smoothly first
      for (const f of frames) f.bmp = await upright(f.bmp);
      const offsets = frames.map(f => Math.round(f.offset));
      const reaction = reactionScores(frames);
      // prefer one reaction shot (Console → Timing: reaction 4 by default) when it is sharp, well lit and shows everyone
      const pick = await SBBest.pick(frames.map(f => f.bmp), { reaction, prefer: (t.preferReaction || 0) - 1 });
      await uploadPool(frames, async (f, i) => {
        const name = `reaction_${String(i + 1).padStart(2, '0')}.jpg`;
        const { full, thumb } = await encode(f.bmp);
        await upload(cmd.sessionId, name, full);
        await upload(cmd.sessionId, 'thumbs/' + name, thumb);
      });
      await Promise.race([done, sleep(10000)]);
      check(token);
      report({
        type: 'reactionsDone', cmdId: cmd.cmdId, count: frames.length, offsets, scores: pick.scores, best: pick.best, details: pick.details, faceAnalysis: pick.faceAnalysis, preferred: pick.preferred,
        timing: { scareAtMsIntoCountdown: Math.round(scareAtMs), scareStartToVisibleMs: Math.round(visibleAt - t0), burstSpanMs: offsets[offsets.length - 1] },
      });
    } catch (e) {
      if (e instanceof Aborted) return;
      console.error(e);
      report({ type: 'failed', cmdId: cmd.cmdId, error: e.message });
    } finally {
      if (workingCmd === cmd.cmdId) workingCmd = null;
      if (token === runToken) { busy = false; layerOn(null); onState(state); }
    }
  }

  async function runCompose(cmd) {
    if (busy) { report({ type: 'failed', cmdId: cmd.cmdId, error: 'The display was busy.' }); return; }
    busy = true; const token = ++runToken;
    workingCmd = cmd.cmdId;
    try {
      layerOn('developing');
      await pendingWork;
      check(token);
      const { blob } = await SBStrip.buildStrip({ photos: cmd.photos, reaction: cmd.reaction, strip: cmd.strip });
      check(token);
      await upload(cmd.sessionId, 'strip.jpg', blob);
      check(token);
      report({ type: 'stripDone', cmdId: cmd.cmdId });
    } catch (e) {
      if (e instanceof Aborted) return;
      console.error(e);
      report({ type: 'failed', cmdId: cmd.cmdId, error: e.message });
    } finally {
      if (workingCmd === cmd.cmdId) workingCmd = null;
      if (token === runToken) busy = false;
    }
  }

  async function runTestScare(cmd) {
    if (busy) { report({ type: 'testResult', ok: false, error: 'The display is busy — try again in a moment.' }); return; }
    if (!renderer.ready) { report({ type: 'testResult', ok: false, error: 'The scare hasn’t loaded: ' + (scareMessage || 'still loading') }); return; }
    busy = true; const token = ++runToken;
    const wasPreview = previewOn;
    if (previewOn) { renderer.setPreview(false); previewOn = false; document.body.classList.remove('previewing'); }
    document.body.classList.add('testing');
    layerOn(null);
    try {
      await audio.resume();
      const t0 = performance.now();
      const L = settings.lights || {};
      musicTest = false; audio.stopMusic(0.06);
      lightCue('scare', { ms: Math.round(settings.timing.burstDurationSec * 1000 + (L.scareFlashExtraMs ?? 400)) });
      setTimeout(() => lightCue('session'), settings.timing.burstDurationSec * 1000 + (L.revertDelayMs ?? 300));
      const { visibleAt, done } = await renderer.show();
      measureScare(2500, true);
      if (demo) demo.scare();
      let frames = [];
      if (cmd.capture !== false && cameraReady()) frames = await captureBurst(settings.timing.burstCount, settings.timing.burstDurationSec * 1000, visibleAt, token);
      const run = new Date().toISOString().replace(/[:.]/g, '-');
      if (frames.length) {
        await uploadPool(frames, async (f, i) => {
          const { full } = await encode(f.bmp, 0.85);
          await api(`/api/test-upload?run=${run}&name=reaction_${String(i + 1).padStart(2, '0')}.jpg`, { body: full, type: 'image/jpeg' });
        });
      }
      await Promise.race([done, sleep(10000)]);
      const offsets = frames.map(f => Math.round(f.offset));
      report({ type: 'testResult', ok: true, scareStartToVisibleMs: Math.round(visibleAt - t0), frames: frames.length, burstSpanMs: offsets[offsets.length - 1] || 0, run, soundEnabled: audio.running, cameraReady: cameraReady() });
    } catch (e) {
      if (!(e instanceof Aborted)) report({ type: 'testResult', ok: false, error: e.message });
    } finally {
      document.body.classList.remove('testing');
      if (token === runToken) { busy = false; onState(state); }
      if (wasPreview) { renderer.setPreview(true); previewOn = true; document.body.classList.add('previewing'); }
    }
  }

  function abort() {
    musicDuck(false);
    stopRecording();
    lightCue('session');
    runToken++;
    busy = false;
    renderer.hide(true);
    layerOn(null);
    onState(state);
  }

  function onCommand(cmd) {
    switch (cmd.cmd) {
      case 'shoot': runShot(cmd); break;
      case 'compose': runCompose(cmd); break;
      case 'abort': abort(); break;
      case 'testScare': runTestScare(cmd); break;
      case 'previewOverlay':
        previewOn = !!cmd.on && !busy;
        renderer.setPreview(previewOn, true);
        document.body.classList.toggle('previewing', previewOn);
        break;
      case 'print': case 'reprint': runPrint(cmd); break;
      case 'testPrint': runPrint({ ...cmd, stripUrl: cmd.stripUrl || '/assets/test-strip.jpg' }); break;
      case 'qrScanned':
        // the guests opened their QR link: record a little longer for their reaction, then finish the session video
        if (rec.mr && (!cmd.sessionId || cmd.sessionId === rec.sessionId)) {
          const sid = rec.sessionId;
          setTimeout(() => { if (rec.mr && rec.sessionId === sid) { logRemote('Session video stopped (QR code scanned)'); stopRecording(); } }, Math.max(0, (settings.timing.recordAfterScanSec ?? 3) * 1000));
        }
        break;
      case 'testSound': audio.resume().then(() => audio.playSting(stingKind())); break;
      case 'testMusic': {
        const mu = musicUrl();
        if (!mu) { logRemote('Music is off or no track is chosen.'); break; }
        musicTest = true;
        audio.resume().then(() => audio.loadMusic(mu)).then(() => audio.playMusic(settings.music.volume)).catch(e => logRemote('Music load failed: ' + e.message));
        break;
      }
      case 'stopMusic': musicTest = false; audio.stopMusic(0.4); musicStageNow = null; setTimeout(syncMusic, 600); break;
      case 'reloadCamera': startCamera(); break;
      case 'reloadDisplay': location.reload(); break;
      case 'demoted':
        // a newer display window took over: release the webcam so the new window can use it
        runToken++; busy = true; renderer.hide(true);
        demotedNow = true; clearTimeout(camRetryTimer); clearTimeout(scareRetryTimer); camToken++;
        syncMusic(); // this window goes quiet: only the newest display plays music
        try { stopRecording(); } catch (_) {}
        try { stopStream(); video.srcObject = null; } catch (_) {}
        $('#sysDemoted').classList.add('on');
        break;
    }
  }

  // ------------------------------------------------------------------ audio unlock, wake lock, cursor
  async function checkAudio() {
    await audio.resume();
    $('#sysAudio').classList.toggle('on', !audio.running);
  }
  $('#sysAudio').addEventListener('click', async () => { await checkAudio(); reportCamera(); });
  document.addEventListener('pointerdown', () => { if (!audio.running) checkAudio(); });
  document.addEventListener('keydown', (e) => {
    if (!audio.running) checkAudio();
    // F11 / F: one press toggles full screen. The page handles it itself, so the browser's own F11
    // full screen and the page's full screen don't fight (that made it take several presses).
    if (e.key === 'F11' || ((e.key === 'f' || e.key === 'F') && !e.ctrlKey && !e.metaKey && !e.altKey)) {
      const browserFull = !document.fullscreenElement && window.matchMedia('(display-mode: fullscreen)').matches;
      if (browserFull) return; // already full screen from the browser (kiosk / F11): let the browser leave it
      e.preventDefault();
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
    }
  });
  // Double-click anywhere also toggles full screen.
  document.addEventListener('dblclick', () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (!window.matchMedia('(display-mode: fullscreen)').matches) document.documentElement.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
  });
  setTimeout(checkAudio, 300);

  let wakeLock = null;
  async function keepAwake() { try { if ('wakeLock' in navigator && document.visibilityState === 'visible') wakeLock = await navigator.wakeLock.request('screen'); } catch (_) {} }
  document.addEventListener('visibilitychange', keepAwake); keepAwake();

  let cursorTimer;
  document.addEventListener('mousemove', () => { document.body.classList.remove('hide-cursor'); clearTimeout(cursorTimer); cursorTimer = setTimeout(() => document.body.classList.add('hide-cursor'), 2500); });

  // ------------------------------------------------------------------ connect
  SB.connect('display', {
    settings: onSettings,
    state: onState,
    command: onCommand,
    connection: (on) => {
      $('#sysOffline').classList.toggle('on', !on);
      if (on && settings) reportCamera();
    },
  });
  layout();
  if (window.SBBest) SBBest.load().then(() => logRemote(SBBest.faceReady ? 'Best-shot face analysis ready' : 'Best-shot face analysis unavailable — using exposure and sharpness only'));

  // test hook (used by automated tests)
  window.__sb = { renderer, audio, get busy() { return busy; }, get camera() { return camera; } };
})();
