// ScareBooth photo-strip composer (runs in the browser on the PC; result uploaded to the server).
// Output: 1200 × 3600 JPEG (a 2×6 inch strip at 600 dpi).
(function () {
  'use strict';

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not load ' + url));
      img.src = /^(data|blob):/.test(url) ? url : url + (url.includes('?') ? '&' : '?') + 'v=' + Date.now();
    });
  }

  /** Fill the box with the image, cropping what doesn't fit. `focus` (0–1 of the image) keeps that point in view. */
  function drawCover(ctx, img, x, y, w, h, focus) {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    const s = Math.max(w / iw, h / ih);
    const sw = w / s, sh = h / s;
    let sx = (iw - sw) / 2, sy = (ih - sh) / 2;
    if (focus) {
      const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
      sx = clamp(focus.x * iw - sw / 2, 0, iw - sw);
      sy = clamp(focus.y * ih - sh * (focus.anchor ?? 0.5), 0, ih - sh);
    }
    ctx.drawImage(img, sx, sy, sw, sh, x, y, w, h);
  }

  /**
   * Tall photos (webcam mounted on its side) are cropped to the strip's landscape shape around the couple's faces:
   * faces sit a little above the middle so heads are never cut off. Without face detection, the upper-middle is used.
   */
  async function faceBox(img) {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    if (ih <= iw) return null;
    try { if (window.SBBest && SBBest.faceReady) return await SBBest.faceFocus(img); } catch (_) {}
    return null;
  }
  /** Crop positions for all 4 photos. A photo where no face is found (e.g. hands over faces in the scare photo)
   *  borrows the face position from the others — the camera doesn't move during a session. */
  async function cropFocusAll(imgs) {
    const boxes = await Promise.all(imgs.map(faceBox));
    const found = boxes.filter(Boolean);
    const avg = found.length ? {
      x: found.reduce((a, f) => a + f.x, 0) / found.length, y: found.reduce((a, f) => a + f.y, 0) / found.length,
      top: Math.min(...found.map(f => f.top)), bottom: Math.max(...found.map(f => f.bottom)),
    } : null;
    return imgs.map((img, i) => cropFocus(img, boxes[i] || avg));
  }
  function cropFocus(img, f) {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    if (ih <= iw) return null; // landscape photo: centred, exactly as before
    if (f) {
      // crop height (as a share of the photo height) for a 3:2 box at full photo width
      const cropH = (iw * 720 / 1080) / ih;
      const span = f.bottom - f.top;
      // faces at ~42% of the crop; if several faces at different heights, centre on them all
      return span > cropH * 0.6 ? { x: 0.5, y: (f.top + f.bottom) / 2, anchor: 0.5 } : { x: 0.5, y: f.y, anchor: 0.42 };
    }
    return { x: 0.5, y: 0.36, anchor: 0.5 };
  }

  /** Where the 4 photos go on the 1200 × 3600 strip: stacked, full width (tall photos are cropped to fit, see cropFocus). */
  function layoutPhotos(imgs, TOP, W, H, M) {
    const PW = 1080, PH = 720, GAP = 40;
    return { rects: imgs.map((_, i) => ({ x: M, y: TOP + i * (PH + GAP), w: PW, h: PH })), fy: TOP + 4 * PH + 3 * GAP };
  }

  function noiseTile() {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const x = c.getContext('2d'); const d = x.createImageData(256, 256);
    for (let i = 0; i < d.data.length; i += 4) { const v = Math.random() * 255; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = Math.random() * 22; }
    x.putImageData(d, 0, 0); return c;
  }

  function spaced(ctx, text, x, y, spacing) {
    // draw centred text with letter spacing (canvas letterSpacing isn't universal)
    const chars = [...text]; const widths = chars.map(ch => ctx.measureText(ch).width);
    const total = widths.reduce((a, b) => a + b, 0) + spacing * (chars.length - 1);
    let cx = x - total / 2;
    const align = ctx.textAlign; ctx.textAlign = 'left';
    chars.forEach((ch, i) => { ctx.fillText(ch, cx, y); cx += widths[i] + spacing; });
    ctx.textAlign = align;
  }

  // ------------------------------------------------------------------ romance strip
  function heartPath(x, cx, cy, size) {
    const s = size / 32;
    x.beginPath();
    x.moveTo(cx, cy + 12 * s);
    x.bezierCurveTo(cx - 4 * s, cy + 6 * s, cx - 16 * s, cy, cx - 16 * s, cy - 8 * s);
    x.bezierCurveTo(cx - 16 * s, cy - 16 * s, cx - 8 * s, cy - 19 * s, cx - 4 * s, cy - 18 * s);
    x.bezierCurveTo(cx - 1.5 * s, cy - 17 * s, cx, cy - 15 * s, cx, cy - 13 * s);
    x.bezierCurveTo(cx, cy - 15 * s, cx + 1.5 * s, cy - 17 * s, cx + 4 * s, cy - 18 * s);
    x.bezierCurveTo(cx + 8 * s, cy - 19 * s, cx + 16 * s, cy - 16 * s, cx + 16 * s, cy - 8 * s);
    x.bezierCurveTo(cx + 16 * s, cy, cx + 4 * s, cy + 6 * s, cx, cy + 12 * s);
    x.closePath();
  }
  function seeded(seed) { let t = seed; return () => { t = (t * 9301 + 49297) % 233280; return t / 233280; }; }

  async function buildRomanceStrip(imgs, opts, focus = []) {
    try {
      await Promise.all([document.fonts.load('120px "Great Vibes"'), document.fonts.load('italic 34px "Playfair Display"'), document.fonts.load('700 26px Quicksand')]);
    } catch (_) {}
    let floral = null;
    try { floral = await loadImage('/assets/florals-corner.svg?v=red-roses'); } catch (_) {}
    const W = 1200, H = 3600, M = 60, TOP = 400, MAT = 14;
    const L = layoutPhotos(imgs, TOP, W, H, M);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d');
    const rose = '#c2185b', deep = '#5b1a35';

    // background: blush gradient, soft paper texture, scattered hearts
    const bg = x.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, '#fff4f7'); bg.addColorStop(0.5, '#fde3eb'); bg.addColorStop(1, '#f9cddb');
    x.fillStyle = bg; x.fillRect(0, 0, W, H);
    x.save(); x.globalAlpha = 0.45; x.fillStyle = x.createPattern(noiseTile(), 'repeat'); x.fillRect(0, 0, W, H); x.restore();
    const rnd = seeded(7);
    x.save();
    for (let i = 0; i < 70; i++) {
      x.globalAlpha = 0.08 + rnd() * 0.12; x.fillStyle = rnd() > 0.5 ? '#ec5f8c' : '#f8a5c2';
      heartPath(x, rnd() * W, rnd() * H, 18 + rnd() * 34); x.fill();
    }
    x.restore();

    // flowers in the corners
    if (floral) {
      const f = 330, fb = 280;
      x.drawImage(floral, 0, 0, f, f);
      x.save(); x.translate(W, 0); x.scale(-1, 1); x.drawImage(floral, 0, 0, f, f); x.restore();
      x.save(); x.translate(0, H); x.scale(1, -1); x.drawImage(floral, 0, 0, fb, fb); x.restore();
      x.save(); x.translate(W, H); x.scale(-1, -1); x.drawImage(floral, 0, 0, fb, fb); x.restore();
    }

    // title: two balanced lines when long
    x.textAlign = 'center'; x.textBaseline = 'alphabetic';
    const words = String(opts.title || '').trim().split(/\s+/);
    let lines = [opts.title];
    if (opts.title.length > 14 && words.length > 1) {
      let best = 1, bestDiff = Infinity;
      for (let i = 1; i < words.length; i++) { const d = Math.abs(words.slice(0, i).join(' ').length - words.slice(i).join(' ').length); if (d < bestDiff) { bestDiff = d; best = i; } }
      lines = [words.slice(0, best).join(' '), words.slice(best).join(' ')];
    }
    let size = lines.length > 1 ? 128 : 150;
    const fontFor = (n) => `${n}px "Great Vibes", cursive`;
    x.font = fontFor(size);
    while (lines.some(l => x.measureText(l).width > 700) && size > 60) { size -= 4; x.font = fontFor(size); }
    x.save();
    x.shadowColor = 'rgba(0,0,0,0.18)'; x.shadowBlur = 14; x.shadowOffsetY = 4;
    const tg = '#111'; // title in black
    x.fillStyle = tg;
    if (lines.length > 1) { x.fillText(lines[0], W / 2, 175); x.fillText(lines[1], W / 2, 175 + size * 0.95); }
    else x.fillText(lines[0], W / 2, 230);
    x.restore();
    // date + little heart divider
    const dateY = lines.length > 1 ? 175 + size * 0.95 + 62 : 300;
    if (opts.showDate) {
      x.font = 'italic 32px "Playfair Display", serif'; x.fillStyle = deep;
      const d = new Date();
      x.fillText(d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }), W / 2, dateY);
      x.fillStyle = '#e8557f';
      heartPath(x, W / 2 - 210, dateY - 10, 22); x.fill(); heartPath(x, W / 2 + 210, dateY - 10, 22); x.fill();
    }

    // photos on white mats
    imgs.forEach((img, i) => {
      const { x: px, y: py, w: PW, h: PH } = L.rects[i];
      const last = i === 3;
      x.save();
      x.shadowColor = 'rgba(122,24,56,0.22)'; x.shadowBlur = 26; x.shadowOffsetY = 8;
      x.fillStyle = '#fff';
      x.beginPath(); x.roundRect ? x.roundRect(px - MAT, py - MAT, PW + MAT * 2, PH + MAT * 2, 10) : x.rect(px - MAT, py - MAT, PW + MAT * 2, PH + MAT * 2); x.fill();
      x.restore();
      drawCover(x, img, px, py, PW, PH, focus[i]);
      // soft rosy vignette on the photo edges (faces stay clear)
      const vg = x.createRadialGradient(px + PW / 2, py + PH / 2, Math.min(PW, PH) * 0.5, px + PW / 2, py + PH / 2, Math.max(PW, PH) * 0.7);
      vg.addColorStop(0, 'rgba(255,192,210,0)'); vg.addColorStop(1, 'rgba(255,170,195,0.22)');
      x.fillStyle = vg; x.fillRect(px, py, PW, PH);
      if (last) {
        x.lineWidth = 6; x.strokeStyle = '#e8557f';
        x.strokeRect(px - MAT - 3, py - MAT - 3, PW + MAT * 2 + 6, PH + MAT * 2 + 6);
        // "till death…" tag
        const tag = 'TILL DEATH…';
        x.font = '700 26px Quicksand, sans-serif';
        const tw = x.measureText(tag).width + 26 * 2 + 30;
        const tx = px + 22, ty = py + PH - 64;
        x.fillStyle = '#fff';
        x.beginPath(); x.roundRect ? x.roundRect(tx, ty, tw, 46, 23) : x.rect(tx, ty, tw, 46); x.fill();
        x.fillStyle = '#e8557f'; heartPath(x, tx + 30, ty + 26, 22); x.fill();
        x.fillStyle = rose; x.textAlign = 'left'; x.fillText(tag, tx + 50, ty + 32); x.textAlign = 'center';
      }
      // tiny heart on each mat corner
      x.fillStyle = '#f48fb1'; heartPath(x, px + PW - 4, py + PH + 2, 18); x.fill();
    });

    // footer
    const fy = L.fy;
    if (opts.footer) {
      x.fillStyle = rose;
      let fs = 76; x.font = fontFor(fs);
      while (x.measureText(opts.footer).width > 760 && fs > 36) { fs -= 2; x.font = fontFor(fs); }
      x.fillText(opts.footer, W / 2, fy + 120);
    }
    x.fillStyle = '#e8557f';
    for (const dx of [-40, 0, 40]) { heartPath(x, W / 2 + dx, fy + 168, dx ? 18 : 26); x.fill(); }

    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', opts.jpegQuality || 0.92));
    if (!blob) throw new Error('Strip encoding failed');
    return { blob, canvas: c };
  }

  async function buildStrip({ photos, reaction, strip }) {
    const opts = Object.assign({ title: 'ScareBooth', footer: '', showDate: true, jpegQuality: 0.92 }, strip || {});
    if (opts.theme !== 'horror') {
      const imgs = await Promise.all([...photos.slice(0, 3), reaction].map(loadImage));
      const focus = await cropFocusAll(imgs);
      return buildRomanceStrip(imgs, opts, focus);
    }
    try {
      await Promise.all([document.fonts.load('150px Eater'), document.fonts.load('40px "Special Elite"'), document.fonts.load('500 24px Oswald')]);
    } catch (_) {}
    const imgs = await Promise.all([...photos.slice(0, 3), reaction].map(loadImage));
    const focus = await cropFocusAll(imgs);

    const W = 1200, H = 3600, M = 60, TOP = 360;
    const L = layoutPhotos(imgs, TOP, W, H, M);
    const c = document.createElement('canvas'); c.width = W; c.height = H;
    const x = c.getContext('2d');

    // background
    x.fillStyle = '#0a0607'; x.fillRect(0, 0, W, H);
    let g = x.createRadialGradient(W / 2, 140, 20, W / 2, 140, 900);
    g.addColorStop(0, 'rgba(140,14,22,0.45)'); g.addColorStop(1, 'rgba(140,14,22,0)');
    x.fillStyle = g; x.fillRect(0, 0, W, 1000);
    g = x.createRadialGradient(W / 2, H - 120, 20, W / 2, H - 120, 700);
    g.addColorStop(0, 'rgba(110,10,18,0.35)'); g.addColorStop(1, 'rgba(110,10,18,0)');
    x.fillStyle = g; x.fillRect(0, H - 900, W, 900);
    x.fillStyle = x.createPattern(noiseTile(), 'repeat'); x.fillRect(0, 0, W, H);

    // title
    x.textAlign = 'center'; x.textBaseline = 'alphabetic';
    let size = 150; x.font = `${size}px Eater, fantasy`;
    while (x.measureText(opts.title).width > W - 140 && size > 60) { size -= 6; x.font = `${size}px Eater, fantasy`; }
    x.save();
    x.shadowColor = 'rgba(0,0,0,0.9)'; x.shadowBlur = 30; x.shadowOffsetY = 8;
    const tg = x.createLinearGradient(0, 120, 0, 240); tg.addColorStop(0, '#ff3b44'); tg.addColorStop(1, '#8e0c14');
    x.fillStyle = tg; x.fillText(opts.title, W / 2, 230);
    x.restore();
    if (opts.showDate) {
      x.font = '34px "Special Elite", monospace'; x.fillStyle = '#a89d94';
      const d = new Date();
      const txt = d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase();
      spaced(x, txt, W / 2, 300, 6);
    }

    // photos
    const labels = ['I', 'II', 'III', 'IV'];
    imgs.forEach((img, i) => {
      const { x: px, y: py, w: PW, h: PH } = L.rects[i];
      const last = i === 3;
      x.save();
      x.shadowColor = last ? 'rgba(200,20,30,0.55)' : 'rgba(0,0,0,0.85)'; x.shadowBlur = last ? 40 : 30; x.shadowOffsetY = last ? 0 : 10;
      x.fillStyle = '#000'; x.fillRect(px - 8, py - 8, PW + 16, PH + 16);
      x.restore();
      drawCover(x, img, px, py, PW, PH, focus[i]);
      // gentle edge vignette (keeps faces clear)
      const vg = x.createRadialGradient(px + PW / 2, py + PH / 2, Math.min(PW, PH) * 0.45, px + PW / 2, py + PH / 2, Math.max(PW, PH) * 0.68);
      vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.38)');
      x.fillStyle = vg; x.fillRect(px, py, PW, PH);
      x.lineWidth = last ? 8 : 5; x.strokeStyle = last ? '#c4141e' : '#ddd3c2';
      x.strokeRect(px - 4, py - 4, PW + 8, PH + 8);
      // label tag
      const tag = last ? 'IV · CAUGHT' : labels[i];
      x.font = '500 26px Oswald, sans-serif';
      const tw = x.measureText(tag).width + 34 + (tag.length - 1) * 4;
      x.fillStyle = last ? '#c4141e' : 'rgba(10,6,7,0.85)';
      x.fillRect(px + 18, py + PH - 58, tw, 42);
      x.fillStyle = last ? '#fff' : '#ddd3c2';
      spaced(x, tag, px + 18 + tw / 2, py + PH - 28, 4);
    });

    // footer
    const fy = L.fy;
    if (opts.footer) {
      x.textAlign = 'center'; x.fillStyle = '#e8dfcf';
      let fs = 48; x.font = `${fs}px "Special Elite", monospace`;
      while (x.measureText(opts.footer).width > W - 120 && fs > 24) { fs -= 2; x.font = `${fs}px "Special Elite", monospace`; }
      x.fillText(opts.footer, W / 2, fy + 120);
    }
    x.font = '500 24px Oswald, sans-serif'; x.fillStyle = '#8a3036';
    spaced(x, 'S C A R E B O O T H', W / 2, fy + 190, 2);

    const blob = await new Promise(r => c.toBlob(r, 'image/jpeg', opts.jpegQuality || 0.92));
    if (!blob) throw new Error('Strip encoding failed');
    return { blob, canvas: c };
  }

  window.SBStrip = { buildStrip, loadImage };
})();
