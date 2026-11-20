// ScareBooth demo camera: a synthetic animated "webcam" so the whole flow can be tested without hardware.
// Two cartoon guests pose for each photo and visibly react when the scare fires.
(function () {
  'use strict';

  class DemoCamera {
    /** `rotation` (0/90/180/270) simulates a webcam mounted on its side: the scene is drawn upright, then
     *  turned the other way, so the booth's "Camera rotation" setting has to turn it back. */
    constructor(width = 1280, height = 720, rotation = 0) {
      this.rotation = rotation;
      const side = rotation === 90 || rotation === 270;
      this.canvas = document.createElement('canvas');          // the upright scene
      this.canvas.width = side ? height : width; this.canvas.height = side ? width : height;
      this.ctx = this.canvas.getContext('2d');
      this.out = this.canvas;
      if (rotation) { this.out = document.createElement('canvas'); this.out.width = width; this.out.height = height; this.octx = this.out.getContext('2d'); }
      this.pose = 0; this.scareAt = 0; this.t0 = performance.now();
      this.label = 'Demo camera (simulated)';
      this._running = true;
      const loop = () => { if (!this._running) return; this.frame(performance.now()); this._raf = requestAnimationFrame(loop); };
      loop();
      // rAF pauses in background tabs; keep frames flowing for captureStream with a timer as backup.
      this._timer = setInterval(() => { if (document.hidden) this.frame(performance.now()); }, 66);
      this.stream = this.out.captureStream(30);
    }
    frame(now) {
      this.draw(now);
      if (!this.rotation) return;
      const o = this.octx, W = this.out.width, H = this.out.height;
      o.save(); o.translate(W / 2, H / 2); o.rotate(-this.rotation * Math.PI / 180);
      o.drawImage(this.canvas, -this.canvas.width / 2, -this.canvas.height / 2); o.restore();
    }
    setPose(i) { this.pose = i; }
    scare() { this.scareAt = performance.now(); }
    /** Simulate the screen flash hitting a webcam: blown out at first, then auto-exposure catches up. */
    flash(ms) { this.flashAt = performance.now(); this.flashMs = ms; }
    stop() { this._running = false; cancelAnimationFrame(this._raf); clearInterval(this._timer); this.stream.getTracks().forEach(t => t.stop()); }

    draw(now) {
      const c = this.ctx, W = this.canvas.width, H = this.canvas.height, t = (now - this.t0) / 1000;
      // room
      const g = c.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, '#2b2420'); g.addColorStop(0.72, '#3a302a'); g.addColorStop(0.73, '#1d1714'); g.addColorStop(1, '#120e0c');
      c.fillStyle = g; c.fillRect(0, 0, W, H);
      c.globalAlpha = 0.07; c.fillStyle = '#c9b48f';
      for (let x = 0; x < W; x += 64) for (let y = 0; y < H * 0.72; y += 64) { c.beginPath(); c.arc(x + 32, y + 32, 6, 0, 7); c.fill(); }
      c.globalAlpha = 1;
      // portrait frame on wall
      c.fillStyle = '#4a3420'; c.fillRect(W * 0.08, H * 0.12, 150, 190); c.fillStyle = '#1a1512'; c.fillRect(W * 0.08 + 14, H * 0.12 + 14, 122, 162);
      c.fillStyle = '#5c544b'; c.beginPath(); c.ellipse(W * 0.08 + 75, H * 0.12 + 80, 30, 38, 0, 0, 7); c.fill();
      // candle glow
      const fl = 0.85 + Math.sin(t * 9) * 0.05 + Math.sin(t * 23) * 0.04;
      const cg = c.createRadialGradient(W * 0.88, H * 0.5, 4, W * 0.88, H * 0.5, 260 * fl);
      cg.addColorStop(0, 'rgba(255,190,110,0.55)'); cg.addColorStop(1, 'rgba(255,170,90,0)');
      c.fillStyle = cg; c.fillRect(0, 0, W, H);
      c.fillStyle = '#e9e1cf'; c.fillRect(W * 0.88 - 8, H * 0.5, 16, 70);
      c.fillStyle = '#ffcf7a'; c.beginPath(); c.ellipse(W * 0.88, H * 0.5 - 10, 6, 13 * fl, 0, 0, 7); c.fill();

      const since = this.scareAt ? (now - this.scareAt) / 1000 : 99;
      const react = since < 3.2 ? Math.min(1, since / 0.35) * (since > 2.6 ? Math.max(0, 1 - (since - 2.6) / 0.6) : 1) : 0;
      this._guest(c, W * 0.37, H, t, 0, '#6d2b30', '#e3b897', react, since);
      this._guest(c, W * 0.63, H, t + 1.3, 1, '#28394f', '#b98466', react, since);

      // flash: over-exposed for ~150 ms, then auto-exposure settles to a slightly brighter picture
      if (this.flashAt) {
        const ft = now - this.flashAt;
        if (ft >= 0 && ft < this.flashMs + 250) {
          const a = ft < 160 ? 0.82 : ft < this.flashMs ? Math.max(0.12, 0.82 - (ft - 160) / 300) : 0.12 * (1 - (ft - this.flashMs) / 250);
          c.fillStyle = `rgba(255,255,255,${a})`; c.fillRect(0, 0, W, H);
        }
      }
      // timestamp proves successive burst frames differ
      c.font = '600 22px Oswald, sans-serif'; c.fillStyle = 'rgba(255,255,255,0.75)';
      c.fillText('DEMO CAMERA', 24, 40);
      c.font = '18px monospace'; c.fillText(new Date().toLocaleTimeString() + '.' + String(Math.floor(now % 1000)).padStart(3, '0'), 24, 66);
    }

    _guest(c, x, H, t, idx, shirt, skin, react, since) {
      const pose = this.pose;
      const sway = Math.sin(t * 1.4) * 6 * (1 - react);
      const jump = react ? -Math.abs(Math.sin(Math.min(since, 2.6) * 7)) * 40 * react - 30 * react : 0;
      const lean = react ? (idx === 0 ? -1 : 1) * 18 * react : 0;
      const by = H * 0.55 + jump, bx = x + sway + lean;
      c.save();
      // body
      c.fillStyle = shirt;
      c.beginPath(); c.moveTo(bx - 95, H); c.quadraticCurveTo(bx - 100, by + 40, bx - 60, by + 10); c.lineTo(bx + 60, by + 10); c.quadraticCurveTo(bx + 100, by + 40, bx + 95, H); c.fill();
      // arms
      c.strokeStyle = shirt; c.lineWidth = 34; c.lineCap = 'round';
      const arm = (sx, dir) => {
        c.beginPath(); c.moveTo(bx + sx, by + 40);
        let ex, ey, hx, hy;
        if (react > 0.2) { ex = bx + sx + dir * 70; ey = by - 40; hx = bx + sx + dir * 60; hy = by - 150; }
        else if (pose === 1) { ex = bx + sx + dir * 40; ey = by + 20; hx = bx + dir * 45; hy = by - 75; }       // hands to cheeks
        else if (pose === 2) { ex = bx + sx + dir * 10; ey = by + 120; hx = bx - dir * 40; hy = by + 95; }      // arms crossed
        else if (pose === 3) { ex = bx + sx + dir * 90; ey = by + 30; hx = bx + sx + dir * 95; hy = by - 60; }  // flex
        else { ex = bx + sx + dir * 75; ey = by + 110; hx = bx + sx + dir * 35; hy = by + 150; }               // hand on hip
        c.quadraticCurveTo(ex, ey, hx, hy); c.stroke();
        c.fillStyle = skin; c.beginPath(); c.arc(hx, hy, 17, 0, 7); c.fill();
      };
      arm(-62, -1); arm(62, 1);
      // neck + head
      c.fillStyle = skin; c.fillRect(bx - 18, by - 30, 36, 45);
      const hy = by - 85;
      c.beginPath(); c.ellipse(bx, hy, 62, 74, 0, 0, 7); c.fill();
      c.fillStyle = idx ? '#1b130f' : '#4a2a17';
      c.beginPath(); c.ellipse(bx, hy - 42, 66, 40, 0, Math.PI, 0); c.fill();
      // eyes
      const eyeR = 7 + react * 9;
      for (const ex of [-22, 22]) {
        c.fillStyle = '#fff'; c.beginPath(); c.ellipse(bx + ex, hy - 6, eyeR + 4, eyeR + 2 + react * 4, 0, 0, 7); c.fill();
        c.fillStyle = '#1a1a1a'; c.beginPath(); c.arc(bx + ex, hy - 6, 5 - react * 2, 0, 7); c.fill();
      }
      // brows
      c.strokeStyle = '#2a1a12'; c.lineWidth = 5;
      for (const ex of [-22, 22]) { c.beginPath(); c.moveTo(bx + ex - 12, hy - 26 - react * 14 + (pose === 2 && !react ? 4 : 0)); c.lineTo(bx + ex + 12, hy - 26 - react * 14); c.stroke(); }
      // mouth
      c.fillStyle = '#3a0d0d';
      if (react > 0.1) { c.beginPath(); c.ellipse(bx, hy + 34, 14 + react * 8, 10 + react * 22, 0, 0, 7); c.fill(); }
      else if (pose === 1) { c.beginPath(); c.ellipse(bx, hy + 34, 12, 16, 0, 0, 7); c.fill(); }
      else { c.strokeStyle = '#5a1d1d'; c.lineWidth = 5; c.beginPath(); c.arc(bx, hy + 24, 20, 0.15 * Math.PI, 0.85 * Math.PI); c.stroke(); }
      c.restore();
    }
  }

  window.DemoCamera = DemoCamera;
})();
