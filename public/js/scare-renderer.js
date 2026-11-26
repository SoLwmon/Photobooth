// ScareBooth — scare compositing + audio.
// Renders the scare (image / transparent video / green-screen video) into a transparent WebGL canvas
// that sits exactly on top of the live camera <video>. The camera keeps playing underneath; the
// overlay never touches captured photos because captures read the <video> element directly.
(function () {
  'use strict';

  const VERT = `
    attribute vec2 aPos;
    uniform vec4 uRect;   // left, top, right, bottom in clip space
    uniform float uFlip;
    varying vec2 vUv;
    void main() {
      gl_Position = vec4(mix(uRect.x, uRect.z, aPos.x), mix(uRect.y, uRect.w, aPos.y), 0.0, 1.0);
      vUv = vec2(uFlip > 0.5 ? 1.0 - aPos.x : aPos.x, aPos.y);
    }`;

  // Chroma key in YUV chroma space (same approach as common streaming tools), with smooth edge and
  // spill suppression. Output is premultiplied alpha.
  const FRAG = `
    precision mediump float;
    varying vec2 vUv;
    uniform sampler2D uTex;
    uniform float uKey;
    uniform vec3 uKeyColor;
    uniform float uSim;
    uniform float uSmooth;
    uniform float uSpill;
    uniform float uFeather;
    uniform float uAlpha;
    uniform float uOutline;
    vec2 chromaUV(vec3 c) {
      return vec2(c.r * -0.169 + c.g * -0.331 + c.b * 0.5 + 0.5, c.r * 0.5 + c.g * -0.419 + c.b * -0.081 + 0.5);
    }
    void main() {
      vec4 c = texture2D(uTex, vUv);
      float a = c.a;
      vec3 rgb = c.rgb;
      if (uKey > 0.5) {
        float d = distance(chromaUV(rgb), chromaUV(uKeyColor));
        float base = d - uSim;
        float m = pow(clamp(base / max(uSmooth, 0.001), 0.0, 1.0), 1.5);
        a *= m;
        float spill = pow(clamp(base / max(uSpill, 0.001), 0.0, 1.0), 1.5);
        float lum = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
        rgb = mix(vec3(lum), rgb, spill);
      }
      if (uFeather > 0.0) {
        vec2 e = min(vUv, 1.0 - vUv);
        a *= smoothstep(0.0, uFeather, min(e.x, e.y));
      }
      a *= uAlpha;
      vec4 col = vec4(rgb * a, a);
      if (uOutline > 0.5) {
        vec2 e = min(vUv, 1.0 - vUv);
        if (min(e.x, e.y) < 0.004) col = mix(col, vec4(0.88, 0.14, 0.18, 1.0), 0.85);
      }
      gl_FragColor = col;
    }`;

  function hexToRgb(h) {
    const n = parseInt(String(h || '#00ff00').slice(1), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  }
  const easeOutCubic = k => 1 - Math.pow(1 - k, 3);
  const easeOutBack = k => { const c1 = 1.9, c3 = c1 + 1; return 1 + c3 * Math.pow(k - 1, 3) + c1 * Math.pow(k - 1, 2); };
  const once = (el, ev) => new Promise(r => el.addEventListener(ev, r, { once: true }));
  const raf = () => new Promise(r => requestAnimationFrame(r));

  // -------------------------------------------------------------------------------------------
  class SBAudio {
    constructor() {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = AC ? new AC({ latencyHint: 'interactive' }) : null;
      this.volume = 0.85;
      if (this.ctx) {
        this.master = this.ctx.createGain();
        this.master.gain.value = this.volume;
        this.master.connect(this.ctx.destination);
      }
      this.stingBuffer = null; this.stingUrl = null;
    }
    get running() { return !!this.ctx && this.ctx.state === 'running'; }
    async resume() { if (this.ctx && this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch (_) {} } return this.running; }
    setVolume(v) { this.volume = v; if (this.master) this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }
    async loadSting(url) {
      if (!this.ctx || !url) { this.stingBuffer = null; this.stingUrl = null; return; }
      if (url === this.stingUrl && this.stingBuffer) return;
      const res = await fetch(url);
      if (!res.ok) throw new Error('Scare sound file not found');
      this.stingBuffer = await this.ctx.decodeAudioData(await res.arrayBuffer());
      this.stingUrl = url;
    }
    playSting(kind) {
      if (!this.ctx || kind === 'none') return;
      if (kind === 'file' && this.stingBuffer) {
        const s = this.ctx.createBufferSource(); s.buffer = this.stingBuffer; s.connect(this.master); s.start(); return;
      }
      this._synthSting();
    }
    _noise(seconds) {
      const len = Math.floor(this.ctx.sampleRate * seconds);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const s = this.ctx.createBufferSource(); s.buffer = buf; return s;
    }
    _synthSting() {
      const ctx = this.ctx, t = ctx.currentTime + 0.003;
      const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -10; comp.ratio.value = 6;
      const out = ctx.createGain(); out.gain.value = 1.0; comp.connect(out); out.connect(this.master);
      // shriek of noise
      const n = this._noise(1.6), bp = ctx.createBiquadFilter(), ng = ctx.createGain();
      bp.type = 'bandpass'; bp.Q.value = 0.9; bp.frequency.setValueAtTime(3200, t); bp.frequency.exponentialRampToValueAtTime(500, t + 1.3);
      ng.gain.setValueAtTime(0, t); ng.gain.linearRampToValueAtTime(0.9, t + 0.008); ng.gain.exponentialRampToValueAtTime(0.001, t + 1.5);
      n.connect(bp); bp.connect(ng); ng.connect(comp); n.start(t); n.stop(t + 1.6);
      // dissonant orchestral-ish stab
      const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 3200; lp.connect(comp);
      for (const f of [146.8, 155.6, 207.7, 220.0, 311.1, 329.6]) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = (Math.random() - 0.5) * 30;
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.13, t + 0.012); g.gain.exponentialRampToValueAtTime(0.001, t + 2.3);
        o.connect(g); g.connect(lp); o.start(t); o.stop(t + 2.4);
      }
      // screech
      const sc = ctx.createOscillator(), sg = ctx.createGain(), hp = ctx.createBiquadFilter(), lfo = ctx.createOscillator(), lg = ctx.createGain();
      sc.type = 'sawtooth'; sc.frequency.setValueAtTime(1300, t); sc.frequency.exponentialRampToValueAtTime(2600, t + 0.35);
      lfo.frequency.value = 9; lg.gain.value = 70; lfo.connect(lg); lg.connect(sc.frequency);
      hp.type = 'highpass'; hp.frequency.value = 900;
      sg.gain.setValueAtTime(0, t); sg.gain.linearRampToValueAtTime(0.16, t + 0.02); sg.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
      sc.connect(hp); hp.connect(sg); sg.connect(comp); sc.start(t); lfo.start(t); sc.stop(t + 1.3); lfo.stop(t + 1.3);
      // sub boom
      const b = ctx.createOscillator(), bg = ctx.createGain();
      b.type = 'sine'; b.frequency.setValueAtTime(95, t); b.frequency.exponentialRampToValueAtTime(32, t + 0.6);
      bg.gain.setValueAtTime(0, t); bg.gain.linearRampToValueAtTime(1.0, t + 0.01); bg.gain.exponentialRampToValueAtTime(0.001, t + 1.0);
      b.connect(bg); bg.connect(comp); b.start(t); b.stop(t + 1.1);
    }
    click() {
      if (!this.ctx) return;
      const t = this.ctx.currentTime + 0.002, n = this._noise(0.08), hp = this.ctx.createBiquadFilter(), g = this.ctx.createGain();
      hp.type = 'highpass'; hp.frequency.value = 1800;
      g.gain.setValueAtTime(0.5, t); g.gain.exponentialRampToValueAtTime(0.001, t + 0.07);
      n.connect(hp); hp.connect(g); g.connect(this.master); n.start(t); n.stop(t + 0.08);
    }
    heartbeat(strength = 0.6) {
      if (!this.ctx) return;
      const ctx = this.ctx;
      for (const [dt, amp] of [[0, 1], [0.16, 0.7]]) {
        const t = ctx.currentTime + 0.005 + dt, o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sine'; o.frequency.setValueAtTime(70, t); o.frequency.exponentialRampToValueAtTime(38, t + 0.14);
        g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(strength * amp, t + 0.012); g.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
        o.connect(g); g.connect(this.master); o.start(t); o.stop(t + 0.22);
      }
    }
  }

  // -------------------------------------------------------------------------------------------
  class ScareRenderer {
    constructor(canvas, opts = {}) {
      this.canvas = canvas;
      this.audio = opts.audio || null;
      this.mode = 'hidden';   // hidden | showing | fading | preview
      this.scare = null; this.profile = null; this.ready = false;
      this.media = null; this.video = null; this.aspect = 1;
      this.useVideoAudio = true; this.stingKind = 'builtin';
      this._looping = false; this._fadeStart = 0; this._showStart = 0; this._loadToken = 0;
      this.gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' });
    // Which graphics chip draws the scare. "SwiftShader"/"Basic Render" means the browser has no graphics
    // acceleration and draws everything with the processor (slow).
    try {
      const ext = this.gl && this.gl.getExtension('WEBGL_debug_renderer_info');
      this.gpu = ext ? String(this.gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : (this.gl ? String(this.gl.getParameter(this.gl.RENDERER)) : 'none');
    } catch (_) { this.gpu = 'unknown'; }
    this.softwareGpu = /swiftshader|llvmpipe|basic render|software/i.test(this.gpu || '');
      if (this.gl) this._initGL(); else this.ctx2d = canvas.getContext('2d');
      this.webglError = this.gl ? null : 'WebGL is unavailable in this browser — chroma key is disabled. Use Chrome or Edge with hardware acceleration on.';
    }

    _initGL() {
      const gl = this.gl;
      const sh = (type, src) => { const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
      const p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, VERT)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, FRAG)); gl.linkProgram(p);
      gl.useProgram(p);
      this.prog = p;
      const buf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
      const loc = gl.getAttribLocation(p, 'aPos'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      this.u = {};
      for (const n of ['uRect', 'uFlip', 'uTex', 'uKey', 'uKeyColor', 'uSim', 'uSmooth', 'uSpill', 'uFeather', 'uAlpha', 'uOutline']) this.u[n] = gl.getUniformLocation(p, n);
      this.tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
      gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1i(this.u.uTex, 0);
      if (!this._lostHandlers) {
        this._lostHandlers = true;
        this.canvas.addEventListener('webglcontextlost', e => { e.preventDefault(); this.ready = false; });
        this.canvas.addEventListener('webglcontextrestored', () => { this._initGL(); if (this.scare) { const s = this.scare; this.scare = null; this.load(s, this.profile).catch(() => {}); } });
      }
    }

    resize(cssW, cssH) {
      // The scare video is far smaller than the screen, so drawing it at 4K adds GPU work and no detail.
      // Keep the drawing surface at most 1280 px on its long side (plenty for scare clips, which are usually
      // 1080p or smaller); the browser scales it up smoothly.
      let dpr = Math.min(1, window.devicePixelRatio || 1);
      const long = Math.max(cssW, cssH) * dpr;
      if (long > 1280) dpr *= 1280 / long;
      const w = Math.max(2, Math.round(cssW * dpr)), h = Math.max(2, Math.round(cssH * dpr));
      if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
      this._drawNow();
    }

    setProfile(profile) { this.profile = profile; this._drawNow(); }
    setAudioOptions({ useVideoAudio, stingKind }) { this.useVideoAudio = !!useVideoAudio; this.stingKind = stingKind || 'builtin'; }

    /** Preload a scare so that showing it is instant. Resolves when the first frame is uploaded to the GPU. */
    async load(scare, profile) {
      this.profile = profile;
      if (this.scare && scare && this.scare.url === scare.url && this.ready) { this._drawNow(); return; }
      const token = ++this._loadToken;
      this.ready = false; this._teardownMedia(); this.scare = scare;
      if (!scare) return;
      if (scare.kind === 'video') {
        const v = document.createElement('video');
        v.preload = 'auto'; v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.loop = false;
        v.crossOrigin = 'anonymous';
        v.src = scare.url;
        const err = once(v, 'error').then(() => { throw new Error(`The scare video “${scare.name}” can’t be played by this browser (codec unsupported or file damaged). Try an H.264 MP4 or VP9 WebM.`); });
        const can = Promise.race([once(v, 'canplaythrough'), once(v, 'loadeddata'), new Promise(r => setTimeout(r, 25000)).then(() => { if (v.readyState < 2) throw new Error('The scare video took too long to load.'); })]);
        v.load();
        await Promise.race([can, err]);
        if (token !== this._loadToken) return;
        // Prime the decoder: play a moment silently, then rewind, so playback starts instantly later.
        try { await v.play(); await raf(); await raf(); } catch (_) {}
        v.pause();
        if (v.currentTime !== 0) { v.currentTime = 0; await Promise.race([once(v, 'seeked'), new Promise(r => setTimeout(r, 1500))]); }
        if (this.audio && this.audio.ctx) {
          try {
            this._vSrc = this.audio.ctx.createMediaElementSource(v);
            this._vSrc.connect(this.audio.master);
          } catch (_) { this._vSrc = null; }
        }
        this.video = v; this.media = v; this.aspect = (v.videoWidth || 16) / (v.videoHeight || 9);
        // Copy a frame to the GPU only when the video has actually decoded a new one (30 fps), not on every
        // screen refresh (60+ Hz).
        this._rvfc = 'requestVideoFrameCallback' in v;
        this._newFrame = true;
        if (this._rvfc) { const onFrame = () => { if (this.video !== v) return; this._newFrame = true; v.requestVideoFrameCallback(onFrame); }; v.requestVideoFrameCallback(onFrame); }
        v.addEventListener('ended', () => { if (this.mode === 'showing') this.hide(); });
        this._upload(v);
      } else {
        const img = new Image();
        img.decoding = 'async';
        img.src = scare.url;
        try { await img.decode(); } catch (_) { throw new Error(`The scare image “${scare.name}” couldn’t be loaded.`); }
        if (token !== this._loadToken) return;
        // Rasterise (SVGs especially) at a generous resolution once, then reuse the GPU texture.
        const nw = img.naturalWidth || 800, nh = img.naturalHeight || 1000;
        const targetH = Math.min(2048, Math.max(nh, 1600));
        const scale = Math.min(targetH / nh, 4096 / nw);
        const c = document.createElement('canvas'); c.width = Math.round(nw * scale); c.height = Math.round(nh * scale);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        this.media = c; this.aspect = c.width / c.height;
        this._upload(c);
      }
      this.ready = true;
      this._drawNow();
    }

    _teardownMedia() {
      if (this.video) { try { this.video.pause(); this.video.removeAttribute('src'); this.video.load(); } catch (_) {} }
      if (this._vSrc) { try { this._vSrc.disconnect(); } catch (_) {} this._vSrc = null; }
      this.video = null; this.media = null;
    }

    _upload(src) {
      if (!this.gl) return;
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      try { gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src); } catch (_) {}
    }

    /** Box of the scare in normalised stage coordinates (for the placement guide). */
    rect(animScale = 1, dx = 0, dy = 0) {
      const p = (this.profile && this.profile.placement) || { x: 0.5, y: 0.5, scale: 0.9 };
      const W = this.canvas.width, H = this.canvas.height;
      const hPx = p.scale * H * animScale, wPx = hPx * this.aspect;
      const cx = (p.x + dx) * W, cy = (p.y + dy) * H;
      return { left: (cx - wPx / 2) / W, top: (cy - hPx / 2) / H, width: wPx / W, height: hPx / H };
    }

    _anim(t) {
      const ent = (this.profile && this.profile.entrance) || 'none';
      let s = 1, a = 1, dx = 0, dy = 0;
      if (ent === 'lunge') {
        const k = Math.min(1, t / 210);
        s = 0.68 + 0.32 * easeOutBack(k);
        a = Math.min(1, t / 45);
        if (t > 210) { s *= 1 + 0.05 * Math.min(1, (t - 210) / 2500); dx = Math.sin(t * 0.07) * 0.0025 + Math.sin(t * 0.131) * 0.0018; dy = Math.cos(t * 0.09) * 0.002; }
      } else if (ent === 'fade') {
        a = Math.min(1, t / 280);
      } else if (ent === 'rise') {
        dy = (1 - easeOutCubic(Math.min(1, t / 320))) * 0.45; a = Math.min(1, t / 80);
      }
      return { s, a, dx, dy };
    }

    _drawNow() { if (this.mode === 'preview' || this.mode === 'hidden') this._draw(performance.now()); }

    _draw(now) {
      const gl = this.gl;
      const W = this.canvas.width, H = this.canvas.height;
      if (!gl) return this._draw2d(now);
      gl.viewport(0, 0, W, H);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      if (!this.ready || this.mode === 'hidden') return;
      let an = { s: 1, a: 1, dx: 0, dy: 0 };
      if (this.mode === 'showing' || this.mode === 'fading') an = this._anim(now - this._showStart);
      if (this.mode === 'fading') {
        const fo = (this.profile && this.profile.fadeOutMs) || 0;
        an.a *= fo ? Math.max(0, 1 - (now - this._fadeStart) / fo) : 0;
      }
      if (this.video && this.video.readyState >= 2 && (this._newFrame || !this._rvfc)) { this._newFrame = false; this._upload(this.video); }
      const p = this.profile || {}, ck = p.chroma || {};
      const r = this.rect(an.s, an.dx, an.dy);
      const L = r.left * 2 - 1, R = (r.left + r.width) * 2 - 1, T = 1 - r.top * 2, B = 1 - (r.top + r.height) * 2;
      gl.useProgram(this.prog);
      gl.uniform4f(this.u.uRect, L, T, R, B);
      gl.uniform1f(this.u.uFlip, p.placement && p.placement.flip ? 1 : 0);
      gl.uniform1f(this.u.uKey, ck.enabled ? 1 : 0);
      gl.uniform3fv(this.u.uKeyColor, hexToRgb(ck.color));
      gl.uniform1f(this.u.uSim, ck.similarity ?? 0.3);
      gl.uniform1f(this.u.uSmooth, ck.smoothness ?? 0.1);
      gl.uniform1f(this.u.uSpill, ck.spill ?? 0.5);
      gl.uniform1f(this.u.uFeather, p.edgeFeather || 0);
      gl.uniform1f(this.u.uAlpha, an.a);
      gl.uniform1f(this.u.uOutline, this.mode === 'preview' && this.showOutline ? 1 : 0);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    _draw2d(now) {
      const c = this.ctx2d; if (!c) return;
      c.clearRect(0, 0, this.canvas.width, this.canvas.height);
      if (!this.ready || this.mode === 'hidden' || !this.media) return;
      let an = { s: 1, a: 1, dx: 0, dy: 0 };
      if (this.mode !== 'preview') an = this._anim(now - this._showStart);
      if (this.mode === 'fading') an.a *= Math.max(0, 1 - (now - this._fadeStart) / ((this.profile && this.profile.fadeOutMs) || 1));
      const r = this.rect(an.s, an.dx, an.dy), W = this.canvas.width, H = this.canvas.height;
      c.save(); c.globalAlpha = an.a;
      if (this.profile && this.profile.placement.flip) { c.translate((r.left * 2 + r.width) * W, 0); c.scale(-1, 1); }
      c.drawImage(this.media, r.left * W, r.top * H, r.width * W, r.height * H);
      c.restore();
    }

    _loop() {
      if (this._looping) return;
      this._looping = true;
      const tick = (now) => {
        this._draw(now);
        if (this.mode === 'fading') {
          const fo = (this.profile && this.profile.fadeOutMs) || 0;
          if (now - this._fadeStart >= fo) { this._finishHide(); }
        }
        if (this.mode === 'hidden') { this._looping = false; this._draw(now); return; }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    }

    /**
     * Show the scare. Resolves once the first scare frame has actually been painted, returning
     * { visibleAt, done } where `done` resolves after it has faded away.
     */
    async show() {
      if (!this.ready) throw new Error('Scare not loaded');
      if (this.mode === 'showing') return { visibleAt: performance.now(), done: this._donePromise };
      this._donePromise = new Promise(r => (this._doneResolve = r));
      const v = this.video;
      if (v) {
        v.loop = false;
        if (v.currentTime > 0.05) { v.currentTime = 0; await Promise.race([once(v, 'seeked'), new Promise(r => setTimeout(r, 800))]); }
        const wantSound = this.useVideoAudio && this.audio && this.audio.running;
        v.muted = !wantSound;
        try { await v.play(); } catch (_) { v.muted = true; try { await v.play(); } catch (e) { console.warn('scare video play failed', e); } }
        if ('requestVideoFrameCallback' in v) await Promise.race([new Promise(r => v.requestVideoFrameCallback(() => r())), new Promise(r => setTimeout(r, 250))]);
      }
      this.mode = 'showing';
      this._showStart = performance.now();
      this._loop();
      await raf(); await raf(); // drawn + composited
      const visibleAt = performance.now();
      if (this.audio && this.stingKind !== 'none') this.audio.playSting(this.stingKind);
      const p = this.profile || {};
      clearTimeout(this._hideTimer);
      this._hideTimer = setTimeout(() => this.hide(), (v ? p.maxVideoSec || 8 : p.holdSec || 2.5) * 1000);
      return { visibleAt, done: this._donePromise };
    }

    hide(immediate = false) {
      clearTimeout(this._hideTimer);
      if (this.mode === 'hidden') return;
      if (immediate || this.mode === 'preview') { this._finishHide(); return; }
      if (this.mode === 'fading') return;
      this.mode = 'fading'; this._fadeStart = performance.now();
      this._loop();
    }

    _finishHide() {
      this.mode = 'hidden';
      const v = this.video;
      if (v) { v.pause(); v.muted = true; try { v.currentTime = 0; } catch (_) {} }
      this._draw(performance.now());
      if (this._doneResolve) { this._doneResolve(); this._doneResolve = null; }
    }

    /** Placement preview: scare shown (looping, silent) with an outline, no entrance animation. */
    setPreview(on, outline = true) {
      this.showOutline = outline;
      if (on) {
        if (this.mode === 'showing' || this.mode === 'fading') return;
        this.mode = 'preview';
        if (this.video) { this.video.muted = true; this.video.loop = true; this.video.play().catch(() => {}); }
        this._loop();
      } else if (this.mode === 'preview') {
        if (this.video) this.video.loop = false;
        this._finishHide();
      }
    }

    /** Sample average colour from the corners of the scare's first frame — for auto-detecting the key colour. */
    sampleCornerColor() {
      if (!this.media) return null;
      const w = this.video ? this.video.videoWidth : this.media.width, h = this.video ? this.video.videoHeight : this.media.height;
      const c = document.createElement('canvas'); c.width = 64; c.height = Math.max(1, Math.round(64 * h / w));
      const x = c.getContext('2d', { willReadFrequently: true }); x.drawImage(this.media, 0, 0, c.width, c.height);
      const pts = [[1, 1], [c.width - 2, 1], [1, c.height - 2], [c.width - 2, c.height - 2], [c.width >> 1, 1]];
      let r = 0, g = 0, b = 0;
      for (const [px, py] of pts) { const d = x.getImageData(px, py, 1, 1).data; r += d[0]; g += d[1]; b += d[2]; }
      const hx = v => Math.round(v / pts.length).toString(16).padStart(2, '0');
      return '#' + hx(r) + hx(g) + hx(b);
    }
  }

  window.SBAudio = SBAudio;
  window.ScareRenderer = ScareRenderer;
})();
