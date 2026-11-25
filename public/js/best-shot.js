// ScareBooth best-shot picker.
// Scores a burst of candidate frames and picks the best one:
//   - eyes open (eye aspect ratio from 68-point face landmarks)
//   - faces well exposed (not blown out by the flash, not too dark)
//   - sharp (no motion blur)
//   - everyone's faces found
//   - for the jump-scare photo: the most scared faces (surprised/fearful expression, mouth open, eyes wide)
// Runs fully offline in the browser (face-api + bundled models). If the face models can't load,
// it still scores exposure and sharpness.
(function () {
  'use strict';

  const MODEL_URL = '/vendor/face-api/model';
  const AW = 512; // analysis width
  const FACE_TOP_K = 4; // run the (slower) face check on this many of the best-looking frames
  let loadPromise = null, faceReady = false, loadError = null, exprReady = false;

  function load() {
    if (loadPromise) return loadPromise;
    loadPromise = (async () => {
      if (!window.faceapi) throw new Error('face-api library missing');
      const fa = window.faceapi;
      try { await fa.tf.setBackend('webgl'); } catch (_) { try { await fa.tf.setBackend('cpu'); } catch (_) {} }
      await fa.tf.ready();
      await fa.nets.tinyFaceDetector.loadFromUri(MODEL_URL);
      await fa.nets.faceLandmark68Net.loadFromUri(MODEL_URL);
      faceReady = true;
      // facial expressions (surprised / fearful) for picking the most scared jump-scare photo; optional
      try { await fa.nets.faceExpressionNet.loadFromUri(MODEL_URL); exprReady = true; } catch (e) { console.warn('Expression model unavailable:', e); }
    })().catch(e => { loadError = e; faceReady = false; console.warn('Face analysis unavailable:', e); });
    return loadPromise;
  }

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  /** Eye aspect ratio: ~0.3 open, < ~0.18 closed. */
  function ear(pts) {
    if (!pts || pts.length < 6) return null;
    const h = dist(pts[0], pts[3]);
    return h ? (dist(pts[1], pts[5]) + dist(pts[2], pts[4])) / (2 * h) : null;
  }
  const clamp01 = v => Math.max(0, Math.min(1, v));
  /** Mouth opening: inner-lip gap ÷ mouth width (closed ≈ 0, a scream ≈ 0.4+). */
  function mouthOpen(m) {
    if (!m || m.length < 20) return null;
    const w = dist(m[12], m[16]);
    return w ? (dist(m[13], m[19]) + dist(m[14], m[18]) + dist(m[15], m[17])) / (3 * w) : null;
  }

  function grayAndStats(ctx, x, y, w, h) {
    x = Math.max(0, Math.floor(x)); y = Math.max(0, Math.floor(y));
    w = Math.max(4, Math.floor(Math.min(w, ctx.canvas.width - x))); h = Math.max(4, Math.floor(Math.min(h, ctx.canvas.height - y)));
    const d = ctx.getImageData(x, y, w, h).data;
    const g = new Float32Array(w * h);
    let sum = 0, clipped = 0, dark = 0;
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      const l = 0.2126 * r + 0.7152 * gg + 0.0722 * b;
      g[j] = l; sum += l;
      if (Math.max(r, gg, b) > 242) clipped++;
      if (l < 18) dark++;
    }
    // sharpness: variance of the Laplacian
    let lsum = 0, lsq = 0, n = 0;
    for (let yy = 1; yy < h - 1; yy++) for (let xx = 1; xx < w - 1; xx++) {
      const k = yy * w + xx;
      const lap = 4 * g[k] - g[k - 1] - g[k + 1] - g[k - w] - g[k + w];
      lsum += lap; lsq += lap * lap; n++;
    }
    const lmean = n ? lsum / n : 0;
    const mean = sum / (w * h);
    let gv = 0; for (let k = 0; k < g.length; k++) gv += (g[k] - mean) * (g[k] - mean);
    gv /= g.length;
    // contrast-normalised sharpness, so brightening a picture doesn't make it look "sharper"
    const lapVar = n ? lsq / n - lmean * lmean : 0;
    return { mean: mean / 255, clipped: clipped / (w * h), dark: dark / (w * h), sharp: gv > 1 ? lapVar / gv : 0 };
  }

  async function analyzeFrame(src, withFaces = true) {
    const sw = src.width || src.videoWidth, sh = src.height || src.videoHeight;
    const c = document.createElement('canvas');
    c.width = AW; c.height = Math.round(AW * sh / sw);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(src, 0, 0, c.width, c.height);
    const out = { faces: [], whole: grayAndStats(ctx, 0, 0, c.width, c.height) };
    out.ctx = ctx;
    if (faceReady && withFaces) await addFaces(out);
    return out;
  }

  async function addFaces(out, withExpr = false) {
    const ctx = out.ctx, c = ctx.canvas;
    out.faceChecked = true;
    {
      try {
        const fa = window.faceapi;
        let q = fa.detectAllFaces(c, new fa.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.45 })).withFaceLandmarks();
        if (withExpr && exprReady) q = q.withFaceExpressions();
        const res = await q;
        for (const r of res) {
          const b = r.detection.box;
          const lm = r.landmarks;
          const e1 = ear(lm.getLeftEye()), e2 = ear(lm.getRightEye());
          const stats = grayAndStats(ctx, b.x, b.y, b.width, b.height);
          const ex = r.expressions || null;
          out.faces.push({
            box: { x: b.x, y: b.y, w: b.width, h: b.height }, score: r.detection.score, ear: e1 != null && e2 != null ? Math.min(e1, e2) : (e1 ?? e2), stats,
            eyesWide: e1 != null && e2 != null ? (e1 + e2) / 2 : (e1 ?? e2),
            mouth: mouthOpen(lm.getMouth()),
            scared: ex ? (ex.surprised || 0) + (ex.fearful || 0) + 0.5 * (ex.disgusted || 0) : null,
          });
        }
      } catch (e) { console.warn('face detect failed', e); }
    }
  }

  /**
   * Score candidate frames. `frames` are ImageBitmaps / canvases. `reaction` (optional) is an array of
   * reaction strengths (0..n) for the jump-scare burst. Returns { best, scores, details, faceAnalysis }.
   */
  async function pick(frames, { reaction = null } = {}) {
    await load();
    const a = [];
    for (const f of frames) a.push(await analyzeFrame(f, false));
    if (faceReady) {
      // quick pre-score (whole-picture exposure + sharpness [+ reaction]) to choose which frames get the face check
      const maxS = Math.max(1e-6, ...a.map(x => x.whole.sharp));
      const pre = a.map((x, i) => {
        const w = x.whole, ex = clamp01(1 - (w.mean < 0.25 ? (0.25 - w.mean) * 2.5 : w.mean > 0.7 ? (w.mean - 0.7) * 3 : 0) - w.clipped * 6 - w.dark * 2);
        return 0.6 * ex + 0.4 * (w.sharp / maxS) + (reaction ? 0.8 * ((reaction[i] || 0) / Math.max(1e-6, ...reaction)) : 0);
      });
      // the scare burst: check every frame (up to 16), since the biggest scare face can be in any of them
      const k = reaction ? Math.min(16, a.length) : FACE_TOP_K;
      const top = pre.map((v, i) => [v, i]).sort((p, q) => q[0] - p[0]).slice(0, k).map(p => p[1]);
      for (const i of top) await addFaces(a[i], !!reaction);
    }
    const maxFaces = Math.max(0, ...a.map(x => x.faces.length));
    const sharpVals = a.map(x => x.faces.length ? x.faces.reduce((s, f) => s + f.stats.sharp, 0) / x.faces.length : x.whole.sharp);
    const maxSharp = Math.max(1e-6, ...sharpVals);
    const maxReact = reaction ? Math.max(1e-6, ...reaction) : 1;
    const details = a.map((x, i) => {
      // exposure judged on the faces when we have them, otherwise on the whole picture
      const regions = x.faces.length ? x.faces.map(f => f.stats) : [x.whole];
      const mean = regions.reduce((s, r) => s + r.mean, 0) / regions.length;
      const clipped = regions.reduce((s, r) => s + r.clipped, 0) / regions.length;
      const dark = regions.reduce((s, r) => s + r.dark, 0) / regions.length;
      // a comfortable brightness band, with strong penalties for blown-out (flash) or crushed areas
      const lo = 0.30, hi = 0.66;
      const meanPen = mean < lo ? (lo - mean) * 2.5 : mean > hi ? (mean - hi) * 3 : 0;
      const exposure = clamp01(1 - meanPen - clipped * 6 - dark * 2);
      // eyes: averaged over everyone expected in the picture; a face we couldn't find counts as "unknown" (0.5)
      const eyeVals = x.faces.map(f => (f.ear == null ? 0.5 : clamp01((f.ear - 0.17) / (0.27 - 0.17))));
      while (eyeVals.length < maxFaces) eyeVals.push(0.5);
      const eyes = maxFaces ? eyeVals.reduce((s, v) => s + v, 0) / eyeVals.length : null;
      const facesFound = maxFaces ? x.faces.length / maxFaces : null;
      const sharp = sharpVals[i] / maxSharp;
      const react = reaction ? clamp01((reaction[i] || 0) / maxReact) : null;
      // how scared everyone looks: surprised/fearful expression, mouth wide open, eyes wide
      let scared = null;
      if (reaction && maxFaces) { // frames where nobody was found score 0 here
        const per = x.faces.map(f => {
          const expr = f.scared == null ? null : clamp01(f.scared);
          const mouth = f.mouth == null ? 0 : clamp01((f.mouth - 0.05) / 0.35);
          const wide = f.eyesWide == null ? 0 : clamp01((f.eyesWide - 0.24) / 0.14);
          return expr == null ? 0.65 * mouth + 0.35 * wide : 0.55 * expr + 0.30 * mouth + 0.15 * wide;
        });
        while (per.length < maxFaces) per.push(0); // someone we couldn't find doesn't count as scared
        scared = per.reduce((s, v) => s + v, 0) / per.length;
      }
      let score;
      if (reaction && scared != null) {
        // the most scared faces win; still a reasonably sharp, well-lit photo with everyone in it
        score = 0.55 * scared + 0.10 * react + 0.12 * exposure + 0.10 * sharp + 0.13 * facesFound;
      } else if (reaction) {
        score = 0.40 * react + 0.22 * exposure + 0.13 * sharp + (maxFaces ? 0.15 * facesFound + 0.10 * eyes : 0.25 * exposure);
      } else if (maxFaces) {
        score = 0.30 * eyes + 0.27 * exposure + 0.25 * facesFound + 0.18 * sharp;
      } else {
        score = 0.65 * exposure + 0.35 * sharp;
      }
      const r3 = v => (v == null ? null : Math.round(v * 1000) / 1000);
      return { score: r3(score), exposure: r3(exposure), eyes: r3(eyes), faces: x.faces.length, sharp: r3(sharp), reaction: r3(react), scared: r3(scared), brightness: r3(mean), clipped: r3(clipped), ears: x.faces.map(f => r3(f.ear)) };
    });
    let best = -1;
    details.forEach((d, i) => {
      d.faceChecked = !!a[i].faceChecked;
      if (faceReady && maxFaces && !a[i].faceChecked) return; // only compare frames whose faces were checked
      if (best < 0 || d.score > details[best].score) best = i;
    });
    if (best < 0) best = 0;
    return { best, scores: details.map(d => d.score), details, faceAnalysis: faceReady };
  }

  /** Where the faces are in a photo (0–1 of width/height), or null. Used to crop tall photos for the strip. */
  async function faceFocus(img) {
    if (!faceReady) return null;
    try {
      const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
      const c = document.createElement('canvas'); c.width = AW; c.height = Math.round(AW * ih / iw);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const fa = window.faceapi;
      const res = await fa.detectAllFaces(c, new fa.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.4 }));
      if (!res.length) return null;
      let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (const r of res) { const b = r.box; x0 = Math.min(x0, b.x); y0 = Math.min(y0, b.y); x1 = Math.max(x1, b.x + b.width); y1 = Math.max(y1, b.y + b.height); }
      return { x: (x0 + x1) / 2 / c.width, y: (y0 + y1) / 2 / c.height, top: y0 / c.height, bottom: y1 / c.height, count: res.length };
    } catch (e) { console.warn('faceFocus failed', e); return null; }
  }

  window.SBBest = { load, pick, faceFocus, get faceReady() { return faceReady; }, get loadError() { return loadError; }, _analyzeFrame: analyzeFrame };
})();
