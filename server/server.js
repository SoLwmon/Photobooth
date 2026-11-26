#!/usr/bin/env node
/*
 * ScareBooth — local horror photobooth server.
 * Zero npm dependencies: only Node.js built-ins (Node 18+).
 *
 *   /display     PC monitor (live camera, countdowns, scare, capture)
 *   /controller  iPad guest controller
 *   /admin       Operator console (PC only by default)
 */
'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const https = require('https');
const { Lights } = require('./lights');
const { Wiz } = require('./wiz');
const IS_WIN = process.platform === 'win32';
const PRINT_MOCK = process.env.SCAREBOOTH_PRINT_MOCK === '1'; // testing without a printer

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.SCAREBOOTH_DATA || path.join(ROOT, 'data'));
const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');
const SCARES_DIR = path.join(DATA_DIR, 'scares');
const SOUNDS_DIR = path.join(DATA_DIR, 'sounds');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const PORT = parseInt(process.env.PORT || '8080', 10);
const ALLOW_REMOTE_ADMIN = process.env.SCAREBOOTH_ALLOW_REMOTE_ADMIN === '1';

for (const d of [DATA_DIR, SESSIONS_DIR, SCARES_DIR, SOUNDS_DIR]) fs.mkdirSync(d, { recursive: true });

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------
const LOG_FILE = path.join(DATA_DIR, 'scarebooth.log');
function log(...args) {
  const line = `[${new Date().toISOString()}] ${args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')}`;
  console.log(line);
  fs.appendFile(LOG_FILE, line + '\n', () => {});
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------
const BUILTIN_SCARES = [
  { id: 'builtin/pale-lady.svg', name: 'The Pale Lady (built-in, transparent image)', url: '/assets/scares/pale-lady.svg', kind: 'image', builtin: true },
  { id: 'builtin/pale-lady-greenscreen.mp4', name: 'Pale Lady lunge (built-in green-screen MP4 — chroma key test)', url: '/assets/scares/pale-lady-greenscreen.mp4', kind: 'video', builtin: true },
  { id: 'builtin/pale-lady-alpha.webm', name: 'Pale Lady lunge (built-in transparent WebM)', url: '/assets/scares/pale-lady-alpha.webm', kind: 'video', builtin: true },
  { id: 'builtin/till-death-scare.mp4', name: 'Till Death Do Us Part scare (the booth’s own clip)', url: '/assets/scares/till-death-scare.mp4', kind: 'video', builtin: true },
  { id: 'builtin/booth-scare.mp4', name: 'Booth scare (“Trythisone”, the event clip)', url: '/assets/scares/booth-scare.mp4', kind: 'video', builtin: true },
];

function defaultProfile(id) {
  const green = /greenscreen/i.test(id || '');
  return {
    placement: { x: 0.5, y: 0.56, scale: 0.95, flip: false },
    chroma: { enabled: green, color: '#00ff00', similarity: 0.30, smoothness: 0.10, spill: 0.55 },
    edgeFeather: 0.0,
    entrance: /\.(mp4|webm|m4v|mov)$/i.test(id || '') ? 'none' : 'lunge', // none | lunge | fade | rise
    holdSec: 2.6,           // images: how long the scare stays up
    fadeOutMs: 400,
    maxVideoSec: 8,         // videos: safety cap
  };
}

// Text that each theme brings with it. Switching theme swaps any of these the operator hasn't customised.
const THEME_PRESETS = {
  romance: {
    prompts: [
      'Who said “I love you” first? Tell us the story!',
      'What was your very first date?',
      'What’s one little thing your partner does that you adore?',
      'Do you promise to love each other… till death do you part?',
    ],
    title: 'Till Death Do Us Part',
    footer: 'Love you to death ♥',
    // five questions: the first is a warm-up with no photo, the next four each end in a photo (the last one: the scare)
    questions: {
      en: [
        'First, tell us your names — and how did you two meet?',
        'Who said “I love you” first? Tell us the story!',
        'What was your very first date?',
        'What’s one little thing your partner does that you adore?',
        'Do you promise to love each other… till death do you part?',
      ],
      zh: [
        '先来介绍一下你们的名字——你们是怎么认识的？',
        '谁先说“我爱你”的？跟我们说说当时的故事吧！',
        '你们第一次约会是去哪里？',
        '对方做的哪一件小事最让你心动？',
        '你们愿意相爱一生……直到死亡将你们分开吗？',
      ],
    },
    instructions: {
      en: '# Welcome to the Couple’s Photo Booth!\nTo get the best out of your session, follow these quick steps:\n1. You’ll see 5 relationship questions pop up on screen. Answer them out loud to test your chemistry and see who really knows who best!\n2. After each question, look up at the camera above. A 3-2-1 countdown will begin before each snap.\n3. Once your final photo is taken, head outside to the print table to pick up your complimentary photo strip!\n! ANSWER OUT LOUD!\n[ TAP THE IPAD TO START ]',
      zh: '# 欢迎来到情侣拍照亭！\n为了让你们玩得尽兴，请按照以下简单步骤：\n1. 屏幕上会出现 5 个关于你们感情的问题。请大声回答，测试你们的默契，看看谁才是最懂对方的人！\n2. 每个问题之后，请抬头看上方的相机。每次拍照前都会有 3-2-1 倒数。\n3. 拍完最后一张照片后，请到外面的打印台领取你们的免费照片条！\n! 大声回答！\n[ 点击 iPad 开始 ]',
    },
  },
  horror: {
    prompts: [
      'What is your biggest fear?',
      'Who would survive longer in a horror movie — and why?',
      'Who screams louder: you or your partner?',
      'Do you promise to stay together… no matter what happens next?',
    ],
    title: 'ScareBooth',
    footer: 'I survived the ScareBooth',
    questions: {
      en: [
        'Introduce yourselves — who are today’s brave souls?',
        'What is your biggest fear?',
        'Who would survive longer in a horror movie — and why?',
        'Who screams louder: you or your partner?',
        'Do you promise to stay together… no matter what happens next?',
      ],
      zh: [
        '先自我介绍一下——今天的勇士是谁？',
        '你最害怕的是什么？',
        '在恐怖片里，谁能活得更久？为什么？',
        '谁的尖叫声更大：你还是你的另一半？',
        '无论接下来发生什么，你们都愿意不离不弃吗？',
      ],
    },
    instructions: {
      en: 'Stand together in front of the screen and look at it.\nFive questions will appear at the top of the screen — answer each one out loud.\nAfter each question from the second one, a countdown starts: get ready to pose!\nWe take four photos in total. Your photo strip prints for you, and you can download it with the QR code.',
      zh: '一起站在屏幕前，看着大屏幕。\n屏幕上方会出现五个问题，请大声回答。\n从第二个问题开始，回答后会有倒数——准备好摆姿势！\n一共拍四张照片。照片条会自动打印，也可以扫描二维码下载。',
    },
  },
};
// Earlier versions used pose prompts; they're upgraded to the question presets if unchanged.
const OLD_POSE_PROMPTS = {
  romance: ['Look lovingly into each other’s eyes.', 'Make a heart together with your hands.', 'Steal a sweet kiss — a cheek kiss counts!', 'Final photo: hold each other close… forever and ever.'],
  horror: ['Strike your most elegant haunted-portrait pose.', 'Look terrified — something is right behind you.', 'Act completely unbothered. Nothing scares you.', 'Final shot: your bravest group pose. Stay very still…'],
};
function applyThemePresets(target, fromTheme, toTheme) {
  const from = THEME_PRESETS[fromTheme], to = THEME_PRESETS[toTheme];
  if (!from || !to || fromTheme === toTheme) return;
  target.prompts = (target.prompts || []).map((p, i) => (p === from.prompts[i] ? to.prompts[i] : p));
  if (target.questions) for (const lang of ['en', 'zh']) {
    if (Array.isArray(target.questions[lang])) target.questions[lang] = target.questions[lang].map((q, i) => (q === from.questions[lang][i] ? to.questions[lang][i] : q));
  }
  if (target.instructions) for (const lang of ['en', 'zh']) {
    if (target.instructions[lang] === from.instructions[lang]) target.instructions[lang] = to.instructions[lang];
  }
  if (target.strip.title === from.title) target.strip.title = to.title;
  if (target.strip.footer === from.footer) target.strip.footer = to.footer;
}

const DEFAULT_SETTINGS = {
  version: 1,
  camera: { deviceId: '', label: '', resolution: '1080p', mirrorPreview: true, mirrorSaved: false, demoMode: false, fit: 'cover', portraitLayout: 'window', rotation: 90 },
  sound: { volume: 0.85, useVideoAudio: true, sting: 'builtin' },
  theme: { name: 'romance' },
  // the booth's own questions (saved from the event setup, v12)
  questions: {
    en: ["How long have you been together?", "When is your anniversary?", "What was your last argument about?", "Could you forgive your partner if they cheated?", "Will you always love the person standing beside you?"],
    zh: ["你们在一起多久了？", "你们的纪念日是几月几号？", "你们上一次吵架是因为什么？", "如果你的另一半出轨了，你会原谅他/她吗？", "你会一直爱着站在你身边的这个人吗？"],
  },
  instructions: { ...THEME_PRESETS.romance.instructions },
  timing: {
    answerSec: 6, countdownSec: 3, // fallbacks; each question has its own time below
    answerSecs: [15, 15, 30, 30, 30], countdownSecs: [3, 3, 3, 3, 3], // per question (5): time to answer, then countdown (none on question 1)
    introTimeoutSec: 90, // instructions screen: back to the start if nobody presses Start
    shotBurstCount: 8, preFlashMs: 250, flashMs: 700, postFlashMs: 300, // photos 1–3: frames before/during/after the screen flash
    scareAtMinSec: 1.2, scareAtMaxSec: 2.6, scareBlackoutMs: 0, // final photo: scare strikes this many seconds into its countdown (random in range)
    scareOnNumber: 2, scareIntoNumberMs: 300, // …or on a countdown number: 2 = while “2” shows (0 = use the random range)
    burstCount: 10, burstDurationSec: 3, burstStartMs: 300, chooseTimeoutSec: 45, // scare photos: start 0.3 s after the scare appears (reactions take a moment)
    shutterFlash: false, flashColor: 'black', doneTimeoutSec: 120, inactivityTimeoutSec: 180,
  },
  flow: { chooseOnIpad: false, showWarning: false, linkFirstTwo: true }, // linkFirstTwo: questions 1 and 2 are Part 1 and Part 2 of one question
  record: { enabled: true, audio: true, micId: '', micLabel: '', videoKbps: 4000, size: '720p', keepCandidates: true },
  lights: {
    enabled: true, port: 'auto', ledCount: 60, stripBrightness: 180, roomLevel: 255, flashLevel: 255, relayMode: 'room', relayInvert: true,
    idleColor: '#ff4f8b', sessionColor: '#ffb3c9', scareColor: '#ff0000',
    neonIdle: 'white', neonSession: 'white', neonScare: 'red', neonInvR: true, neonInvG: false, neonInvB: true, flashInvert: false, // RGB neon on relays (pins 7/4/8)
    flashMode: 'steady', flashOnPhotos: false, scareFlashExtraMs: 400, revertDelayMs: 300, scareFlashDelayMs: 1500,
  },
  wiz: { enabled: true, bulbs: '', brightness: 80, idleColor: '#ff4f8b', sessionColor: '#ffc9a8', scareColor: '#ff0000',
    idleMode: 'white', idleTemp: 6500, sessionMode: 'white', sessionTemp: 6500, scareBrightness: 100 }, // 'white' = the bulb's own white LEDs (no purple tint)
  share: { enabled: true, mode: 'auto', customUrl: '', host: '', wifiSsid: '', wifiPassword: '', wifiSecurity: 'WPA' },
  print: { enabled: true, askGuests: false, maxCopies: 4, layout: '4x6-double', stripsPerPrint: 2, timeoutCopies: 1, method: 'direct', printerName: '',
    offsetXmm: 0, offsetYmm: 0, scalePct: 100, safeMm: 2.5 }, // print position fine-tuning: + moves right / down (mm); size in %
  scares: { active: 'builtin/booth-scare.mp4', profiles: { 'builtin/booth-scare.mp4': {"placement": {"x": 0.498, "y": 0.501, "scale": 1.013, "flip": false}, "chroma": {"enabled": false, "color": "#00ff00", "similarity": 0.3, "smoothness": 0.1, "spill": 0.55}, "edgeFeather": 0, "entrance": "none", "holdSec": 2.6, "fadeOutMs": 400, "maxVideoSec": 8}, 'builtin/till-death-scare.mp4': {"placement": {"x": 0.498, "y": 0.501, "scale": 1.022, "flip": false}, "chroma": {"enabled": false, "color": "#00ff00", "similarity": 0.3, "smoothness": 0.1, "spill": 0.55}, "edgeFeather": 0, "entrance": "none", "holdSec": 2.6, "fadeOutMs": 400, "maxVideoSec": 8} } },
  strip: { title: THEME_PRESETS.romance.title, footer: THEME_PRESETS.romance.footer, showDate: true, bottomLogo: true, style: 'template', jpegQuality: 0.92 },
  warning: {
    text: 'This booth contains sudden frightening images and loud sounds. It is not recommended for anyone with heart conditions, anxiety, or sensitivity to sudden noise or startling visuals. Photos are stored on this computer only.',
  },
};

function isObj(v) { return v && typeof v === 'object' && !Array.isArray(v); }
function deepMerge(base, over) {
  if (!isObj(base)) return over === undefined ? base : over;
  const out = { ...base };
  if (!isObj(over)) return out;
  for (const k of Object.keys(over)) {
    if (isObj(base[k]) && isObj(over[k])) out[k] = deepMerge(base[k], over[k]);
    else if (over[k] !== undefined) out[k] = over[k];
  }
  return out;
}
const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const str = (v, max, d = '') => (typeof v === 'string' ? v.slice(0, max) : d);
const bool = (v, d) => (typeof v === 'boolean' ? v : d);

function sanitizeProfile(p, id) {
  const d = defaultProfile(id);
  p = deepMerge(d, p || {});
  return {
    placement: {
      x: clamp(p.placement.x, -0.5, 1.5, d.placement.x),
      y: clamp(p.placement.y, -0.5, 1.5, d.placement.y),
      scale: clamp(p.placement.scale, 0.05, 3, d.placement.scale),
      flip: bool(p.placement.flip, false),
    },
    chroma: {
      enabled: bool(p.chroma.enabled, d.chroma.enabled),
      color: /^#[0-9a-f]{6}$/i.test(p.chroma.color) ? p.chroma.color : d.chroma.color,
      similarity: clamp(p.chroma.similarity, 0, 1, d.chroma.similarity),
      smoothness: clamp(p.chroma.smoothness, 0, 1, d.chroma.smoothness),
      spill: clamp(p.chroma.spill, 0, 1, d.chroma.spill),
    },
    edgeFeather: clamp(p.edgeFeather, 0, 0.5, 0),
    entrance: ['none', 'lunge', 'fade', 'rise'].includes(p.entrance) ? p.entrance : d.entrance,
    holdSec: clamp(p.holdSec, 0.5, 15, d.holdSec),
    fadeOutMs: clamp(p.fadeOutMs, 0, 3000, d.fadeOutMs),
    maxVideoSec: clamp(p.maxVideoSec, 1, 30, d.maxVideoSec),
  };
}

function sanitizeSettings(s) {
  const m = deepMerge(DEFAULT_SETTINGS, s || {});
  const t = m.timing;
  const out = {
    version: 17,
    theme: { name: m.theme.name === 'horror' ? 'horror' : 'romance' },
    camera: {
      deviceId: str(m.camera.deviceId, 300), label: str(m.camera.label, 300),
      resolution: ['720p', '1080p', '4k'].includes(m.camera.resolution) ? m.camera.resolution : '1080p',
      mirrorPreview: bool(m.camera.mirrorPreview, true), mirrorSaved: bool(m.camera.mirrorSaved, false),
      demoMode: bool(m.camera.demoMode, false), fit: m.camera.fit === 'contain' ? 'contain' : 'cover',
      portraitLayout: m.camera.portraitLayout === 'fill' ? 'fill' : 'window',
      rotation: [0, 90, 180, 270].includes(+m.camera.rotation) ? +m.camera.rotation : 0,
    },
    sound: {
      volume: clamp(m.sound.volume, 0, 1, 0.85), useVideoAudio: bool(m.sound.useVideoAudio, true),
      sting: str(m.sound.sting, 300, 'builtin') || 'builtin',
    },
    // five questions in English and Chinese; older settings had four English ones (now questions 2–5)
    questions: (() => {
      const q = m.questions || {}, old = Array.isArray(m.prompts) && !(s && s.questions) ? m.prompts : null;
      const en = old ? [DEFAULT_SETTINGS.questions.en[0], ...old] : q.en || [];
      return {
        en: [0, 1, 2, 3, 4].map(i => str(en[i], 240, DEFAULT_SETTINGS.questions.en[i])),
        zh: [0, 1, 2, 3, 4].map(i => str((q.zh || [])[i], 240, DEFAULT_SETTINGS.questions.zh[i])),
      };
    })(),
    instructions: {
      en: str((m.instructions || {}).en, 1200, DEFAULT_SETTINGS.instructions.en),
      zh: str((m.instructions || {}).zh, 1200, DEFAULT_SETTINGS.instructions.zh),
    },
    timing: {
      poseLeadSec: clamp(t.poseLeadSec, 0, 15, 3),
      answerSec: clamp(t.answerSec, 0, 60, 6),
      shotBurstCount: Math.round(clamp(t.shotBurstCount, 1, 20, 8)),
      preFlashMs: Math.round(clamp(t.preFlashMs, 0, 2000, 250)),
      flashMs: Math.round(clamp(t.flashMs, 100, 3000, 700)),
      postFlashMs: Math.round(clamp(t.postFlashMs, 0, 2000, 300)),
      countdownSec: Math.round(clamp(t.countdownSec, 1, 10, 3)),
      // per question; older settings without them take the single answer/countdown time for all four
      // per question (5). Older settings had 4 (the photo questions): they become questions 2–5.
      answerSecs: (() => { const a = t.answerSecs || []; const v = a.length === 4 ? [8, ...a] : a; return [0, 1, 2, 3, 4].map(i => clamp(v[i], 0, 60, i ? clamp(t.answerSec, 0, 60, 6) : 8)); })(),
      countdownSecs: (() => { const a = t.countdownSecs || []; const v = a.length === 4 ? [3, ...a] : a; return [0, 1, 2, 3, 4].map(i => Math.round(clamp(v[i], 1, 10, Math.round(clamp(t.countdownSec, 1, 10, 3))))); })(),
      introTimeoutSec: Math.round(clamp(t.introTimeoutSec, 15, 600, 90)),
      scareAtMinSec: clamp(t.scareAtMinSec, 0, 20, 1.2),
      scareAtMaxSec: clamp(t.scareAtMaxSec, 0, 20, 2.6),
      scareBlackoutMs: clamp(t.scareBlackoutMs, 0, 1500, 0),
      scareOnNumber: Math.round(clamp(t.scareOnNumber, 0, 10, 2)), scareIntoNumberMs: Math.round(clamp(t.scareIntoNumberMs, 0, 999, 300)),
      burstCount: Math.round(clamp(t.burstCount, 2, 40, 6)),
      chooseTimeoutSec: Math.round(clamp(t.chooseTimeoutSec, 10, 600, 45)),
      burstDurationSec: clamp(t.burstDurationSec, 0.5, 10, 3),
      burstStartMs: Math.round(clamp(t.burstStartMs, 0, 3000, 300)),
      shutterFlash: bool(t.shutterFlash, true),
      flashColor: t.flashColor === 'white' ? 'white' : 'black',
      doneTimeoutSec: Math.round(clamp(t.doneTimeoutSec, 5, 1800, 25)),
      inactivityTimeoutSec: Math.round(clamp(t.inactivityTimeoutSec, 30, 3600, 180)),
    },
    flow: { chooseOnIpad: bool(m.flow.chooseOnIpad, false), showWarning: bool(m.flow.showWarning, false), linkFirstTwo: bool(m.flow.linkFirstTwo, true) },
    record: {
      enabled: bool(m.record.enabled, true), audio: bool(m.record.audio, true),
      micId: str(m.record.micId, 300), micLabel: str(m.record.micLabel, 300),
      videoKbps: Math.round(clamp(m.record.videoKbps, 500, 20000, 4000)), size: m.record.size === 'full' ? 'full' : '720p', keepCandidates: bool(m.record.keepCandidates, true),
    },
    lights: (() => {
      const L = m.lights, col = (v, d) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v : d);
      return {
        enabled: bool(L.enabled, false), port: /^(auto|simulator|COM\d{1,3})$/i.test(L.port || '') ? L.port : 'auto',
        ledCount: Math.round(clamp(L.ledCount, 1, 600, 60)), stripBrightness: Math.round(clamp(L.stripBrightness, 0, 255, 180)),
        roomLevel: Math.round(clamp(L.roomLevel, 0, 255, 255)), flashLevel: Math.round(clamp(L.flashLevel, 0, 255, 255)),
        relayMode: L.relayMode === 'scare' ? 'scare' : 'room', relayInvert: bool(L.relayInvert, false),
        idleColor: col(L.idleColor, '#ff4f8b'), sessionColor: col(L.sessionColor, '#ffb3c9'), scareColor: col(L.scareColor, '#ff0000'),
        ...(() => { const ok = ['off', 'red', 'green', 'blue', 'yellow', 'cyan', 'magenta', 'white']; const c = (v, d) => (ok.includes(v) ? v : d);
          return { neonIdle: c(L.neonIdle, 'white'), neonSession: c(L.neonSession, 'white'), neonScare: c(L.neonScare, 'red'),
            neonInvR: bool(L.neonInvR, true), neonInvG: bool(L.neonInvG, false), neonInvB: bool(L.neonInvB, true), flashInvert: bool(L.flashInvert, false) }; })(),
        flashMode: L.flashMode === 'flash' ? 'flash' : 'steady', flashOnPhotos: bool(L.flashOnPhotos, false), scareFlashExtraMs: Math.round(clamp(L.scareFlashExtraMs, 0, 5000, 400)), scareFlashDelayMs: Math.round(clamp(L.scareFlashDelayMs, 0, 5000, 1500)),
        revertDelayMs: Math.round(clamp(L.revertDelayMs, 0, 10000, 300)),
      };
    })(),
    wiz: (() => {
      const W = m.wiz || {}, col = (v, d) => (/^#[0-9a-f]{6}$/i.test(v || '') ? v : d);
      return {
        enabled: bool(W.enabled, false), bulbs: String(W.bulbs || '').replace(/[^\d., ]/g, '').slice(0, 200),
        brightness: Math.round(clamp(W.brightness, 10, 100, 80)),
        idleColor: col(W.idleColor, '#ff4f8b'), sessionColor: col(W.sessionColor, '#ffc9a8'), scareColor: col(W.scareColor, '#ff0000'),
        idleMode: W.idleMode === 'color' ? 'color' : 'white', sessionMode: W.sessionMode === 'color' ? 'color' : 'white',
        scareBrightness: Math.round(clamp(W.scareBrightness, 10, 100, 100)),
        idleTemp: Math.round(clamp(W.idleTemp, 2200, 6500, 3500) / 100) * 100, sessionTemp: Math.round(clamp(W.sessionTemp, 2200, 6500, 2700) / 100) * 100,
      };
    })(),
    share: {
      enabled: bool(m.share.enabled, true),
      mode: m.share.mode === 'wifi' ? 'wifi' : 'auto',
      customUrl: /^https:\/\/[\w.-]+(:\d+)?\/?$/i.test(m.share.customUrl || '') ? String(m.share.customUrl).replace(/\/$/, '') : '',
      host: /^[\w.:-]{0,100}$/.test(m.share.host || '') ? (m.share.host || '') : '',
      wifiSsid: str(m.share.wifiSsid, 64), wifiPassword: str(m.share.wifiPassword, 64),
      wifiSecurity: ['WPA', 'WEP', 'nopass'].includes(m.share.wifiSecurity) ? m.share.wifiSecurity : 'WPA',
    },
    print: {
      enabled: bool(m.print.enabled, false), maxCopies: Math.round(clamp(m.print.maxCopies, 1, 10, 4)),
      layout: ['4x6-double', '4x6-single', '2x6'].includes(m.print.layout) ? m.print.layout : '4x6-double',
      stripsPerPrint: Number(m.print.stripsPerPrint) === 1 ? 1 : 2,
      askGuests: bool(m.print.askGuests, false),
      timeoutCopies: Math.round(clamp(m.print.timeoutCopies, 0, 10, 1)),
      method: m.print.method === 'browser' ? 'browser' : 'direct',
      printerName: str(m.print.printerName, 200),
      offsetXmm: Math.round(clamp(m.print.offsetXmm, -15, 15, 0) * 2) / 2, offsetYmm: Math.round(clamp(m.print.offsetYmm, -15, 15, 0) * 2) / 2,
      scalePct: Math.round(clamp(m.print.scalePct, 85, 110, 100) * 2) / 2,
      safeMm: Math.round(clamp(m.print.safeMm, 0, 6, 2.5) * 2) / 2,
    },
    scares: { active: str(m.scares.active, 300, 'builtin/booth-scare.mp4'), profiles: {} },
    strip: {
      title: str(m.strip.title, 40, 'Till Death Do Us Part'), footer: str(m.strip.footer, 80, ''),
      showDate: bool(m.strip.showDate, true), bottomLogo: bool(m.strip.bottomLogo, true), style: ['template', 'theme', 'romance', 'dark'].includes(m.strip.style) ? m.strip.style : 'template', jpegQuality: clamp(m.strip.jpegQuality, 0.6, 1, 0.92),
    },
    warning: { text: str(m.warning.text, 800, DEFAULT_SETTINGS.warning.text) },
  };
  if (out.print.timeoutCopies > out.print.maxCopies) out.print.timeoutCopies = out.print.maxCopies;
  if (out.timing.scareAtMaxSec < out.timing.scareAtMinSec) out.timing.scareAtMaxSec = out.timing.scareAtMinSec;
  const profiles = isObj(m.scares.profiles) ? m.scares.profiles : {};
  for (const id of Object.keys(profiles).slice(0, 200)) out.scares.profiles[id] = sanitizeProfile(profiles[id], id);
  return out;
}

let settings;
try {
  const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  if (!raw.version || raw.version < 2) {
    if (raw.scares && raw.scares.active === 'builtin/pale-lady.svg') raw.scares.active = 'builtin/pale-lady-alpha.webm';
    if (raw.timing && raw.timing.doneTimeoutSec === 120) raw.timing.doneTimeoutSec = 25;
  }
  if (!raw.version || raw.version < 4) {
    // Upgrading from the horror-only version: switch to the romance theme, keeping any custom text.
    raw.theme = { name: 'romance' };
    raw.strip = raw.strip || {}; raw.prompts = raw.prompts || THEME_PRESETS.horror.prompts.slice();
    if (raw.strip.title === undefined) raw.strip.title = THEME_PRESETS.horror.title;
    if (raw.strip.footer === undefined) raw.strip.footer = THEME_PRESETS.horror.footer;
    applyThemePresets(raw, 'horror', 'romance');
  }
  if (!raw.version || raw.version < 5) {
    // 6 reaction shots that guests pick from on the iPad
    raw.timing = raw.timing || {}; raw.flow = raw.flow || {};
    if (raw.timing.burstCount === undefined || raw.timing.burstCount === 15) raw.timing.burstCount = 6;
    raw.flow.chooseOnIpad = true;
  }
  if (!raw.version || raw.version < 6) {
    // Revision: questions with answer time, program picks the best photos, no warning screen
    raw.flow = raw.flow || {}; raw.flow.chooseOnIpad = false; raw.flow.showWarning = false;
    for (const th of ['romance', 'horror']) {
      if (Array.isArray(raw.prompts)) raw.prompts = raw.prompts.map((q, i) => (q === OLD_POSE_PROMPTS[th][i] ? THEME_PRESETS[th].prompts[i] : q));
    }
    if (raw.timing && raw.timing.poseLeadSec !== undefined && raw.timing.answerSec === undefined) raw.timing.answerSec = 6;
  }
  if (!raw.version || raw.version < 7) {
    // screen flash is a black blink by default (white is still available in the console)
    raw.timing = raw.timing || {}; raw.timing.flashColor = 'black';
  }
  if (!raw.version || raw.version < 8) {
    // the 毒爱 / Till Death Do Us Part logo goes across the bottom of the strip
    raw.strip = raw.strip || {}; raw.strip.bottomLogo = true;
  }
  if (!raw.version || raw.version < 9) {
    // dark strip frame that blends into the black logo band
    raw.strip = raw.strip || {}; raw.strip.style = 'dark';
  }
  if (!raw.version || raw.version < 10) {
    // the rose-stained "Till Death Do Us Part" strip design
    raw.strip = raw.strip || {}; raw.strip.style = 'template';
  }
  if ((raw.version || 0) < 17) {
    // the booth's 1-channel green relay switches on with HIGH (the 2-channel red/blue board with LOW)
    raw.lights = raw.lights || {}; raw.lights.neonInvG = false;
  }
  if ((raw.version || 0) < 16) {
    // the COB light is now a steady light (always on), not a flash
    raw.lights = raw.lights || {}; raw.lights.flashMode = 'steady';
  }
  if ((raw.version || 0) < 15) {
    // scare photos: 10 over 3 s, starting 0.3 s after the scare appears, so they catch the reaction
    raw.timing = raw.timing || {};
    if (!raw.timing.burstCount || raw.timing.burstCount <= 6) raw.timing.burstCount = 10;
    if (!raw.timing.burstDurationSec || raw.timing.burstDurationSec <= 2.5) raw.timing.burstDurationSec = 3;
    raw.timing.burstStartMs = 300;
  }
  if ((raw.version || 0) < 14 && raw.instructions) {
    // new instructions text, unless the operator had already written their own
    const oldEn = /^Stand together in front of the screen and look at it\./, oldZh = /^(两人)?一起站在屏幕前/;
    if (!raw.instructions.en || oldEn.test(raw.instructions.en)) raw.instructions.en = THEME_PRESETS.romance.instructions.en;
    if (!raw.instructions.zh || oldZh.test(raw.instructions.zh)) raw.instructions.zh = THEME_PRESETS.romance.instructions.zh;
  }
  if ((raw.version || 0) < 13) {
    // scare: no black screen, and it strikes while the countdown shows “2”
    raw.timing = raw.timing || {}; raw.timing.scareBlackoutMs = 0; raw.timing.scareOnNumber = 2;
  }
  if (raw.version === 11 || (raw.version || 0) < 12) {
    // idle: light warm white
    raw.wiz = raw.wiz || {}; raw.wiz.idleMode = 'white'; raw.wiz.idleTemp = 3500;
  }
  if (!raw.version || raw.version < 11) {
    // WiZ: warm white from the bulb's white LEDs while waiting and during photos (RGB white looked purple)
    raw.wiz = raw.wiz || {}; raw.wiz.idleMode = 'white'; raw.wiz.sessionMode = 'white';
  }
  settings = sanitizeSettings(raw);
  log('Loaded settings from', SETTINGS_FILE);
} catch (e) {
  settings = sanitizeSettings({});
  if (e.code !== 'ENOENT') log('WARNING: settings.json unreadable, using defaults:', e.message);
}
function saveSettings() {
  const tmp = SETTINGS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2));
  fs.renameSync(tmp, SETTINGS_FILE);
}
saveSettings();

// ---------------------------------------------------------------------------
// Scare / sound library
// ---------------------------------------------------------------------------
const IMAGE_EXT = ['.png', '.webp', '.gif', '.jpg', '.jpeg', '.svg', '.avif'];
const VIDEO_EXT = ['.mp4', '.webm', '.m4v', '.mov'];
const AUDIO_EXT = ['.mp3', '.wav', '.ogg', '.m4a', '.aac'];

function listScares() {
  const list = BUILTIN_SCARES.filter(s => fs.existsSync(path.join(PUBLIC_DIR, s.url)));
  for (const f of fs.readdirSync(SCARES_DIR).sort()) {
    const ext = path.extname(f).toLowerCase();
    const kind = IMAGE_EXT.includes(ext) ? 'image' : VIDEO_EXT.includes(ext) ? 'video' : null;
    if (!kind) continue;
    const st = fs.statSync(path.join(SCARES_DIR, f));
    list.push({ id: 'upload/' + f, name: f, url: '/media/scares/' + encodeURIComponent(f), kind, size: st.size, builtin: false });
  }
  return list;
}
function listSounds() {
  return fs.readdirSync(SOUNDS_DIR).filter(f => AUDIO_EXT.includes(path.extname(f).toLowerCase())).sort()
    .map(f => ({ id: f, name: f, url: '/media/sounds/' + encodeURIComponent(f) }));
}
function activeScare() {
  const lib = listScares();
  const s = lib.find(x => x.id === settings.scares.active) || lib[0];
  if (!s) return null;
  return { ...s, profile: sanitizeProfile(settings.scares.profiles[s.id], s.id) };
}
function safeName(name) {
  const base = path.basename(String(name || 'file')).replace(/[^\w.\- ()]+/g, '_').replace(/^\.+/, '').slice(0, 120);
  return base || 'file';
}
function uniqueName(dir, name) {
  const ext = path.extname(name); const stem = name.slice(0, name.length - ext.length);
  let n = name, i = 1;
  while (fs.existsSync(path.join(dir, n))) n = `${stem} (${i++})${ext}`;
  return n;
}

// ---------------------------------------------------------------------------
// SSE hub
// ---------------------------------------------------------------------------
const clients = new Map(); // id -> { res, role, ip, since }
let primaryDisplay = null;
let cameraStatus = { ok: false, message: 'Display not connected yet', label: '', width: 0, height: 0, demo: false, devices: [] };

function send(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
}
function broadcast(event, data, roleFilter) {
  for (const c of clients.values()) if (!roleFilter || roleFilter.includes(c.role)) send(c.res, event, data);
}
function displayOnline() { return !!(primaryDisplay && clients.has(primaryDisplay)); }
function sendToDisplay(cmd) {
  if (!displayOnline()) return false;
  send(clients.get(primaryDisplay).res, 'command', cmd);
  return true;
}
let lastScarePerf = null; // how smoothly the last scare played (console)
function statusPayload() {
  const counts = { display: 0, controller: 0, admin: 0 };
  for (const c of clients.values()) counts[c.role] = (counts[c.role] || 0) + 1;
  return { clients: counts, displayOnline: displayOnline(), camera: cameraStatus, urls: lanUrls(), tunnel: tunnelInfo(), lights: lights.info(), wiz: wiz.info(), shareHost: shareHost(), prints: printCounter.total || 0, phase: state.phase, sessionId: state.sessionId, lastScarePerf };
}
function broadcastStatus() { broadcast('status', statusPayload(), ['admin']); }
// A fingerprint of the web pages' code: open pages reload themselves when the program is updated.
const BUILD_ID = (() => {
  let h = 0;
  const walk = (dir) => { for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) { if (!['vendor', 'fonts', 'assets'].includes(f.name)) walk(p); }
    else if (/\.(js|html|css)$/.test(f.name)) { const st = fs.statSync(p); for (const c of `${f.name}:${st.size}:${Math.round(st.mtimeMs)}`) h = (h * 31 + c.charCodeAt(0)) | 0; }
  } };
  try { walk(path.join(ROOT, 'public')); } catch (_) {}
  return (h >>> 0).toString(36);
})();

function settingsPayload() {
  return { settings, scare: activeScare(), scares: listScares(), sounds: listSounds() };
}
function broadcastSettings() { broadcast('settings', settingsPayload()); if (typeof lights !== 'undefined') { lights.configure(settings); wiz.configure(settings); } }

setInterval(() => { for (const c of clients.values()) { try { c.res.write(': ping\n\n'); } catch (_) {} } }, 15000);

// ---------------------------------------------------------------------------
// Session state machine
// ---------------------------------------------------------------------------
const state = {
  phase: 'idle',          // idle | intro | warning | shooting | choose | composing | done
  sessionId: null, shot: 0, prompt: '', message: '',
  lang: 'both',           // guest-facing language: 'both' (English + Chinese together, the default) | 'en' | 'zh'
  question: 0,            // 1–5 on screen; question 1 has no photo, questions 2–5 are photos 1–4
  reactions: [], previewIndex: -1, selected: -1, stripUrl: null, photos: [],
  shareToken: null, printStatus: 'off', printCopies: 0, printAuto: false,
  pendingCmd: null, updatedAt: Date.now(),
};

// ---- share links (QR download) ------------------------------------------------
const shareTokens = new Map(); // token -> sessionId
function loadShareTokens() {
  for (const id of fs.readdirSync(SESSIONS_DIR)) {
    try { const m = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, id, 'session.json'), 'utf8')); if (m.shareToken) shareTokens.set(m.shareToken, id); } catch (_) {}
  }
}
loadShareTokens();
function newShareToken() {
  const abc = 'abcdefghjkmnpqrstuvwxyz23456789';
  const b = crypto.randomBytes(10); let t = '';
  for (const x of b) t += abc[x % abc.length];
  return t;
}
function shareHost() {
  const urls = lanUrls();
  if (settings.share.host && urls.some(u => u.ip === settings.share.host)) return settings.share.host;
  return urls.length ? urls[0].ip : 'localhost';
}
function shareOnline() { return settings.share.mode !== 'wifi' && tunnel.status === 'online' && !!tunnel.url; }
function shareUrlFor(token) {
  if (!token) return null;
  return shareOnline() ? `${tunnel.url}/d/${token}` : `http://${shareHost()}:${PORT}/d/${token}`;
}

// ---- print counter ---------------------------------------------------------------
const PRINTS_FILE = path.join(DATA_DIR, 'prints.json');
let printCounter = { total: 0 };
try { printCounter = JSON.parse(fs.readFileSync(PRINTS_FILE, 'utf8')); } catch (_) {}
function addPrints(n) { printCounter.total = (printCounter.total || 0) + n; try { fs.writeFileSync(PRINTS_FILE, JSON.stringify(printCounter)); } catch (_) {} }
let cmdCounter = 0;
const videoSeq = new Map();
const lights = new Lights({ log, scriptsDir: path.join(ROOT, 'scripts') });
let lightsBroadcastTimer = null;
lights.on('change', () => { if (!lightsBroadcastTimer) lightsBroadcastTimer = setTimeout(() => { lightsBroadcastTimer = null; broadcastStatus(); }, 120); });
lights.on('connected', () => lights.cue(state.phase === 'idle' ? 'idle' : 'session'));
setTimeout(() => lights.configure(settings), 200);
// WiZ bulbs on the Wi-Fi (optional, alongside or instead of the USB lights box)
const wiz = new Wiz({ log });
let wizBroadcastTimer = null;
wiz.on('change', () => { if (!wizBroadcastTimer) wizBroadcastTimer = setTimeout(() => { wizBroadcastTimer = null; broadcastStatus(); }, 150); });
setTimeout(() => { wiz.configure(settings); wiz.cue(state.phase === 'idle' ? 'idle' : 'session'); }, 300);
/** One light moment for everything: the USB lights box and the WiZ bulbs. */
function lightCue(name, opts) { lights.cue(name, opts); wiz.cue(name); }
let watchdog = null, inactivityTimer = null, doneTimer = null, nextShotTimer = null, retryCount = 0;

function publicState() {
  return {
    phase: state.phase, sessionId: state.sessionId, shot: state.shot, totalShots: 4, prompt: state.prompt,
    lang: state.lang, question: state.question, totalQuestions: 5, promptZh: state.promptZh || '',
    message: state.message, reactions: state.reactions, previewIndex: state.previewIndex, selected: state.selected,
    stripUrl: state.stripUrl, photos: state.photos, displayOnline: displayOnline(), cameraOk: cameraStatus.ok,
    shareUrl: settings.share.enabled && state.stripUrl ? shareUrlFor(state.shareToken) : null,
    shareOnline: shareOnline(),
    printStatus: state.printStatus, printCopies: state.printCopies, printMax: settings.print.maxCopies, printAuto: state.printAuto,
    printDefault: settings.print.timeoutCopies, printFixed: settings.print.enabled && !settings.print.askGuests, stripsPerPrint: settings.print.layout === '4x6-double' ? settings.print.stripsPerPrint : 1, doneTimeoutSec: settings.timing.doneTimeoutSec, chooseTimeoutSec: settings.timing.chooseTimeoutSec,
    updatedAt: state.updatedAt,
  };
}
let lastLightPhase = null;
function setState(patch) {
  Object.assign(state, patch, { updatedAt: Date.now() });
  if (state.phase !== lastLightPhase) {
    if (state.phase === 'idle') lightCue('idle');
    else if (lastLightPhase === 'idle' || lastLightPhase === 'warning' || lastLightPhase === null) lightCue('session');
    lastLightPhase = state.phase;
  }
  broadcast('state', publicState());
  broadcastStatus();
  armTimers();
}
function sessionDir(id) { return path.join(SESSIONS_DIR, id); }
function sessionUrl(id, file) { return `/sessions/${encodeURIComponent(id)}/${file}`; }

function writeSessionMeta(extra = {}) {
  if (!state.sessionId) return;
  const file = path.join(sessionDir(state.sessionId), 'session.json');
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  meta = { ...meta, id: state.sessionId, photos: state.photos, reactions: state.reactions, selected: state.selected, strip: state.stripUrl, ...extra, updatedAt: new Date().toISOString() };
  try { fs.writeFileSync(file, JSON.stringify(meta, null, 2)); } catch (e) { log('Could not write session.json:', e.message); }
}

function newSessionId() {
  const d = new Date(); const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}_${crypto.randomBytes(2).toString('hex')}`;
}

function clearTimer(t) { if (t) clearTimeout(t); return null; }
function armTimers() {
  inactivityTimer = clearTimer(inactivityTimer);
  doneTimer = clearTimer(doneTimer);
  if (state.phase === 'choose') {
    inactivityTimer = setTimeout(() => {
      if (state.phase !== 'choose' || !state.reactions.length) return;
      const i = state.autoPick >= 0 && state.autoPick < state.reactions.length ? state.autoPick : 0;
      log('No reaction chosen in time — auto-picking', state.reactions[i].file);
      state.selected = i; state.previewIndex = i;
      writeSessionMeta({ autoSelectedReaction: state.reactions[i].file, chooseTimedOut: true });
      startCompose();
    }, settings.timing.chooseTimeoutSec * 1000);
  }
  if (state.phase === 'intro') {
    inactivityTimer = setTimeout(() => {
      if (state.phase !== 'intro') return;
      log('Nobody pressed Start on the instructions screen — back to the start');
      resetToIdle('');
    }, settings.timing.introTimeoutSec * 1000);
  }
  if (state.phase === 'warning') {
    inactivityTimer = setTimeout(() => {
      log('Session', state.sessionId || '-', 'timed out from inactivity in phase', state.phase);
      resetToIdle('Session ended after inactivity.');
    }, settings.timing.inactivityTimeoutSec * 1000);
  }
  if (state.phase === 'done' && state.printStatus !== 'printing') {
    doneTimer = setTimeout(() => {
      if (state.printStatus === 'ask' && settings.print.timeoutCopies > 0) {
        log('No print choice made — printing the default', settings.print.timeoutCopies);
        const r = startPrint(settings.print.timeoutCopies, true);
        if (r.ok) return;
      }
      resetToIdle('');
    }, settings.timing.doneTimeoutSec * 1000);
  }
}

function resetToIdle(message = '') {
  watchdog = clearTimer(watchdog);
  nextShotTimer = clearTimer(nextShotTimer);
  if (state.pendingCmd) sendToDisplay({ cmd: 'abort', cmdId: state.pendingCmd.cmdId });
  if (state.sessionId) writeSessionMeta({ endedAt: new Date().toISOString(), completed: !!state.stripUrl });
  setState({ phase: 'idle', sessionId: null, shot: 0, question: 0, prompt: '', promptZh: '', message, reactions: [], previewIndex: -1, selected: -1, stripUrl: null, photos: [], shareToken: null, printStatus: 'off', printCopies: 0, printAuto: false, pendingCmd: null });
}

function issueCommand(cmd, timeoutMs, onTimeout) {
  const cmdId = ++cmdCounter;
  const full = { ...cmd, cmdId, sessionId: state.sessionId };
  state.pendingCmd = { cmdId, type: cmd.cmd, timeoutMs, onTimeout, started: Date.now() };
  if (!sendToDisplay(full)) { state.pendingCmd = null; return null; }
  armWatchdog(cmdId, cmd, timeoutMs, onTimeout);
  return cmdId;
}
function armWatchdog(cmdId, cmd, timeoutMs, onTimeout) {
  watchdog = clearTimer(watchdog);
  watchdog = setTimeout(() => {
    if (state.pendingCmd && state.pendingCmd.cmdId === cmdId) {
      log('Watchdog: display did not finish', cmd.cmd, 'cmd', cmdId);
      sendToDisplay({ cmd: 'abort', cmdId });
      state.pendingCmd = null;
      onTimeout();
    }
  }, timeoutMs);
}

function failSession(msg) {
  log('Session ended:', msg);
  resetToIdle(msg);
}

/** A photo failed: retry it automatically (guests never need to touch the iPad), then give up. */
function shotFailed(reason) {
  if (state.phase !== 'shooting') return;
  if (!displayOnline()) return failSession('The booth screen disconnected. Please ask a staff member for help.');
  if (retryCount < 2) {
    retryCount++;
    log(`Retrying photo ${state.shot} (attempt ${retryCount + 1}) after:`, reason);
    nextShotTimer = clearTimer(nextShotTimer);
    nextShotTimer = setTimeout(() => startShot(state.shot), 2500);
  } else {
    failSession('The camera isn’t working right now. Please ask a staff member for help.');
  }
}

/**
 * Sessions run automatically on the main display. Five questions: question 1 (shot 0) is answered with no photo;
 * questions 2–5 each end with a countdown and a photo (shots 1–4), and the scare strikes on shot 4.
 */
function startShot(shot) {
  nextShotTimer = clearTimer(nextShotTimer);
  const t = settings.timing;
  const final = shot === 4, noPhoto = shot === 0, question = shot + 1;
  // English, with the Chinese shown underneath (or one language if a session asked for just one)
  const prompt = (settings.questions[state.lang === 'zh' ? 'zh' : 'en'] || settings.questions.en)[question - 1];
  const promptZh = state.lang === 'both' ? settings.questions.zh[question - 1] : '';
  const answerSec = t.answerSecs[question - 1], countdownSec = t.countdownSecs[question - 1];
  const timeout = (1 + answerSec + (noPhoto ? 0 : Math.max(countdownSec, final ? t.scareAtMaxSec : 0) + 4 + (t.preFlashMs + t.flashMs + t.postFlashMs) / 1000) + (final ? t.burstDurationSec + 40 : 0) + 20) * 1000;
  setState({ phase: 'shooting', shot, question, prompt, promptZh, message: '' });
  const cmdId = issueCommand({ cmd: 'shoot', shot, question, totalQuestions: 5, noPhoto, final, prompt, promptZh, lang: state.lang, totalShots: 4, answerSec, countdownSec }, timeout, () => shotFailed('display did not respond in time'));
  if (!cmdId) failSession('The booth screen isn’t connected. Please ask a staff member for help.');
}

function startCompose() {
  const reaction = state.reactions[state.selected];
  const onFail = (msg) => settings.flow.chooseOnIpad
    ? setState({ phase: 'choose', message: msg + ' Please confirm your favourite again.' })
    : failSession('Your photos are saved, but the strip couldn’t be created. Please ask a staff member.');
  const cmdId = issueCommand({
    cmd: 'compose', photos: state.photos.slice(0, 3), reaction: reaction.url, strip: { ...settings.strip, theme: settings.theme.name },
  }, 45000, () => onFail('Creating the strip took too long.'));
  if (!cmdId) { onFail('The booth screen isn’t connected.'); return; }
  setState({ phase: 'composing', message: '' });
}
startCompose.fail = (msg) => settings.flow.chooseOnIpad
  ? setState({ phase: 'choose', message: 'Couldn’t build the strip: ' + msg + ' Please try again.' })
  : failSession('Your photos are saved, but the strip couldn’t be created. Please ask a staff member.');

function startPrint(copies, auto) {
  if (settings.print.method === 'direct') {
    const sid = state.sessionId;
    log('Printing', copies, 'copies for', sid, auto ? '(automatic default)' : '', '(direct)');
    writeSessionMeta({ printAuto: !!auto });
    setState({ printStatus: 'printing', printCopies: copies, printAuto: !!auto });
    directPrint(path.join(sessionDir(sid), 'strip.jpg'), copies, settings.print.layout, `ScareBooth ${sid}`).then(sheets => {
      addPrints(sheets);
      updateMetaFor(sid, { prints: copies, printedSheets: sheets });
      if (state.sessionId === sid) setState({ printStatus: 'printed' });
      broadcastStatus();
    }).catch(e => {
      log('Print failed:', e.message);
      printNotice(false, 'Printing failed: ' + e.message);
      if (state.sessionId === sid) setState({ printStatus: 'error' });
    });
    return { ok: true };
  }
  const cmdId = issueCommand({ cmd: 'print', copies, stripUrl: state.stripUrl, layout: settings.print.layout }, 30000 + copies * 15000,
    () => setState({ printStatus: 'error' }));
  if (!cmdId) { setState({ printStatus: 'error' }); return { ok: false, error: 'The booth screen isn’t connected.' }; }
  log('Printing', copies, 'copies for', state.sessionId, auto ? '(automatic default)' : '');
  writeSessionMeta({ printAuto: !!auto });
  setState({ printStatus: 'printing', printCopies: copies, printAuto: !!auto });
  return { ok: true };
}

// ---- direct printing: the PC sends the strip straight to a Windows printer -----------------
const SCRIPTS_DIR = path.join(ROOT, 'scripts');
let printChain = Promise.resolve();
function runPowerShell(script, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (PRINT_MOCK) {
      if (script === 'list-printers.ps1') return resolve('{"default":"Mock Photo Printer","printers":["Mock Photo Printer","Microsoft Print to PDF"]}');
      return setTimeout(() => resolve('OK Mock Photo Printer'), 400);
    }
    if (!IS_WIN) return reject(new Error('Direct printing works on Windows only. Switch “Print method” to “Through the display browser”.'));
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS_DIR, script), ...args],
      { windowsHide: true, timeout: timeoutMs }, (err, stdout, stderr) => {
        const out = String(stdout || '').trim();
        if (err && !out) return reject(new Error(err.killed ? 'The printer didn’t respond in time.' : (String(stderr || '').trim() || err.message)));
        resolve(out);
      });
  });
}
// 4x6-double: two strips side by side on one 4R sheet; the printer's 2-inch cut splits them.
// stripsPerPrint 2 → each print is a whole sheet (2 strips); 1 → strips are counted singly (3 prints = 2 sheets).
function perSheet(layout) { return layout === '4x6-double' && settings.print.stripsPerPrint === 1 ? 2 : 1; }
/** Queue a direct print job; resolves with the number of sheets printed. */
function directPrint(imagePath, copies, layout, jobName, opts = {}) {
  const sheets = Math.ceil(copies / perSheet(layout));
  const job = async () => {
    const P = settings.print;
    const out = await runPowerShell('print-strip.ps1', ['-Image', imagePath, '-Printer', P.printerName || '', '-Layout', layout, '-Sheets', String(sheets), '-JobName', jobName || 'ScareBooth',
      '-OffsetXmm', String(P.offsetXmm || 0), '-OffsetYmm', String(P.offsetYmm || 0), '-ScalePct', String(P.scalePct || 100),
      '-SafeMm', String(opts.noSafe ? 0 : P.safeMm || 0)], 60000 + sheets * 20000);
    if (!/^OK/m.test(out)) throw new Error((out.match(/ERROR: (.*)/) || [])[1] || out || 'Printing failed');
    log('Printed', sheets, 'sheet(s) on', out.replace(/^OK\s*/, ''));
    return sheets;
  };
  const p = printChain.then(job, job);
  printChain = p.catch(() => {});
  return p;
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? Math.round(n * 10) / 10 : 0; }
function printNotice(ok, message) { broadcast('testResult', { kind: 'print', ok, message, error: ok ? '' : message }, ['admin']); }

// ---- reprints from the gallery (any past session) -----------------------------------
let reprintCounter = 0;
const reprintJobs = new Map(); // jobId -> sessionId
function updateMetaFor(sid, extra) {
  const file = path.join(sessionDir(sid), 'session.json');
  let meta = {}; try { meta = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) {}
  const merged = { ...meta, ...(typeof extra === 'function' ? extra(meta) : extra) };
  try { fs.writeFileSync(file, JSON.stringify(merged, null, 2)); } catch (_) {}
}

function handleControl(body) {
  const a = body.action;
  switch (a) {
    case 'begin': {
      // the guests picked a language on the iPad: show the instructions in it, then wait for Start
      if (state.phase === 'done') resetToIdle('');
      if (state.phase === 'intro') { broadcast('state', publicState()); return { ok: true }; } // pressed twice: already on the instructions
      if (state.phase !== 'idle') return { ok: false, error: 'A session is already in progress.' };
      if (!displayOnline()) return { ok: false, error: 'The booth screen isn’t connected yet. Please ask a staff member.' };
      setState({ phase: 'intro', lang: ['en', 'zh'].includes(body.lang) ? body.lang : 'both', message: '' });
      return { ok: true };
    }
    case 'back':
      if (state.phase !== 'intro') return { ok: false, error: 'Not on the instructions screen.' };
      resetToIdle('');
      return { ok: true };
    case 'start':
      if (state.phase !== 'intro') return { ok: false, error: 'Not on the instructions screen.' };
      if (!displayOnline()) return { ok: false, error: 'The booth screen isn’t connected yet. Please ask a staff member.' };
      if (settings.flow.showWarning) { setState({ phase: 'warning', message: '' }); return { ok: true }; }
      state.phase = 'warning'; // straight through to the first question, no warning screen
      return handleControl({ action: 'accept' });
    case 'decline':
      if (state.phase !== 'warning') return { ok: false, error: 'Not on the warning screen.' };
      resetToIdle('');
      return { ok: true };
    case 'accept': {
      if (state.phase !== 'warning') return { ok: false, error: 'Not on the warning screen.' };
      if (!displayOnline()) { resetToIdle('The booth screen isn’t connected. Please ask a staff member for help.'); return { ok: false, error: 'Display offline' }; }
      const id = newSessionId();
      fs.mkdirSync(path.join(sessionDir(id), 'thumbs'), { recursive: true });
      state.sessionId = id; state.photos = []; state.reactions = []; state.stripUrl = null; state.selected = -1;
      state.shareToken = newShareToken(); state.printStatus = 'off'; state.printCopies = 0;
      shareTokens.set(state.shareToken, id);
      retryCount = 0;
      writeSessionMeta({ startedAt: new Date().toISOString(), lang: state.lang, questions: state.lang === 'both' ? settings.questions : settings.questions[state.lang], warningAccepted: true, shareToken: state.shareToken });
      log('Session started', id, 'language', state.lang);
      startShot(0);
      return { ok: true };
    }
    case 'preview': {
      if (state.phase !== 'choose') return { ok: false, error: 'Not choosing.' };
      const i = Number(body.index);
      if (!Number.isInteger(i) || i < 0 || i >= state.reactions.length) return { ok: false, error: 'Bad index' };
      setState({ previewIndex: i });
      return { ok: true };
    }
    case 'confirm': {
      if (state.phase !== 'choose') return { ok: false, error: 'Not choosing.' };
      const i = Number(body.index);
      if (!Number.isInteger(i) || i < 0 || i >= state.reactions.length) return { ok: false, error: 'Bad index' };
      state.selected = i; state.previewIndex = i;
      writeSessionMeta();
      startCompose();
      return { ok: true };
    }
    case 'print': {
      if (state.phase !== 'done' || state.printStatus !== 'ask') return { ok: false, error: 'Printing isn’t available right now.' };
      const copies = Number(body.copies);
      if (!Number.isInteger(copies) || copies < 0 || copies > settings.print.maxCopies) return { ok: false, error: 'Choose between 0 and ' + settings.print.maxCopies + ' prints.' };
      if (copies === 0) { setState({ printStatus: 'skipped', printCopies: 0 }); writeSessionMeta({ prints: 0 }); return { ok: true }; }
      return startPrint(copies, false);
    }
    case 'finish':
      if (state.phase !== 'done') return { ok: false, error: 'Not finished yet.' };
      resetToIdle('');
      return { ok: true };
    case 'cancel':
      log('Session cancelled', state.sessionId || '-');
      resetToIdle('');
      return { ok: true };
    case 'ping':
      armTimers();
      return { ok: true };
    default:
      return { ok: false, error: 'Unknown action' };
  }
}

function handleDisplayReport(body) {
  const r = body || {};
  if (r.type === 'camera') {
    cameraStatus = {
      ok: !!r.ok, message: str(r.message, 500), label: str(r.label, 300), width: r.width | 0, height: r.height | 0,
      demo: !!r.demo, scareMessage: str(r.scareMessage, 500), audio: !!r.audio,
      mics: Array.isArray(r.mics) ? r.mics.slice(0, 30).map(d => ({ deviceId: str(d.deviceId, 300), label: str(d.label, 300) })) : (cameraStatus.mics || []),
      devices: Array.isArray(r.devices) ? r.devices.slice(0, 30).map(d => ({ deviceId: str(d.deviceId, 300), label: str(d.label, 300) })) : cameraStatus.devices,
    };
    broadcastStatus();
    broadcast('state', publicState(), ['controller']);
    return { ok: true };
  }
  if (r.type === 'log') { log('[display]', str(r.message, 1000)); return { ok: true }; }
  if (r.type === 'reprinted' || r.type === 'reprintFailed') {
    const sid = reprintJobs.get(r.jobId); reprintJobs.delete(r.jobId);
    if (r.type === 'reprinted') {
      addPrints(r.sheets | 0);
      if (sid) updateMetaFor(sid, m => ({ reprints: (m.reprints || 0) + (r.copies | 0) }));
      log('Reprint done for', sid, r.copies, 'copies');
    } else log('Reprint failed for', sid, str(r.error, 300));
    broadcast('testResult', { kind: 'print', ok: r.type === 'reprinted', message: r.type === 'reprinted' ? `Reprinted ${r.copies} for ${sid}` : 'Reprint failed: ' + str(r.error, 200), error: str(r.error, 200) }, ['admin']);
    broadcastStatus();
    return { ok: true };
  }
  if (r.type === 'alive') {
    const pc = state.pendingCmd;
    // the display is still working: give it more time (up to 5 minutes per command)
    if (pc && r.cmdId === pc.cmdId && Date.now() - pc.started < 300000) armWatchdog(pc.cmdId, { cmd: pc.type }, Math.max(20000, pc.timeoutMs / 2), pc.onTimeout);
    return { ok: true };
  }
  if (r.type === 'shotChosen') {
    const sid = /^[\w-]+$/.test(r.sessionId || '') ? r.sessionId : null;
    if (sid && fs.existsSync(sessionDir(sid))) {
      updateMetaFor(sid, m => ({ bestShots: { ...(m.bestShots || {}), ['photo' + (r.shot | 0)]: { chosen: (r.best | 0) + 1, faceAnalysis: !!r.faceAnalysis, offsetsMs: r.offsets, candidates: r.details } } }));
      const d = (r.details || [])[r.best] || {};
      log(`Best shot for photo ${r.shot}: frame ${(r.best | 0) + 1}/${(r.details || []).length} (score ${d.score}, eyes ${d.eyes}, exposure ${d.exposure}, faces ${d.faces})`);
    }
    return { ok: true };
  }
  if (r.type === 'testResult') { broadcast('testResult', r, ['admin']); log('[display] test result', r); return { ok: true }; }
  if (r.type === 'scarePerf') {
    // how smoothly the last scare played on the booth screen (shown in the console)
    lastScarePerf = { at: Date.now(), test: !!r.test, fps: num(r.fps), videoFps: num(r.videoFps), worstMs: num(r.worstMs), stalls: num(r.stalls), dropped: num(r.dropped),
      clip: str(r.clip, 40), gpu: str(r.gpu, 160), software: !!r.software, recording: !!r.recording };
    broadcast('scarePerf', lastScarePerf, ['admin']); log('[display] scare playback', lastScarePerf); return { ok: true };
  }

  if (!state.pendingCmd || r.cmdId !== state.pendingCmd.cmdId) return { ok: false, error: 'stale command' };
  watchdog = clearTimer(watchdog);
  state.pendingCmd = null;

  if (r.type === 'shotDone' && state.shot === 0) {
    // question 1 answered (no photo): on to question 2 and the first photo
    retryCount = 0;
    nextShotTimer = setTimeout(() => startShot(1), 600);
    return { ok: true };
  }
  if (r.type === 'shotDone') {
    const shot = state.shot;
    const photos = state.photos.slice(); photos[shot - 1] = sessionUrl(state.sessionId, `photo${shot}.jpg`);
    retryCount = 0;
    setState({ photos });
    writeSessionMeta();
    // short breath, then the next question + countdown appear on the main display
    if (shot < 4) nextShotTimer = setTimeout(() => startShot(shot + 1), 1200);
    return { ok: true };
  }
  if (r.type === 'reactionsDone') {
    const n = Math.max(0, Math.min(40, r.count | 0));
    const reactions = [];
    for (let i = 1; i <= n; i++) {
      const f = `reaction_${String(i).padStart(2, '0')}.jpg`;
      reactions.push({ url: sessionUrl(state.sessionId, f), thumb: sessionUrl(state.sessionId, 'thumbs/' + f), file: f, t: (r.offsets || [])[i - 1] ?? null });
    }
    const photos = state.photos.slice(); photos[3] = null;
    writeSessionMeta({ scareTiming: r.timing || null });
    log('Reaction burst saved:', n, 'frames', r.timing || '');
    if (!n) { shotFailed('no reaction photos captured'); return { ok: true }; }
    // The biggest jump: the frame that changed most from the moment the scare appeared.
    const scores = Array.isArray(r.scores) ? r.scores.map(Number) : [];
    let best = Math.min(n - 1, Math.round(n * 0.35));
    if (scores.length === n && scores.some(v => v > 0)) {
      best = n > 1 ? 1 : 0;
      for (let i = 1; i < n; i++) if (scores[i] > scores[best]) best = i;
    }
    if (Number.isInteger(r.best) && r.best >= 0 && r.best < n) best = r.best; // the display's best-shot pick (quality + reaction)
    writeSessionMeta({ reactionScores: scores, finalPick: { chosen: best + 1, faceAnalysis: !!r.faceAnalysis, candidates: r.details || null } });
    if (settings.flow.chooseOnIpad) {
      // guests pick on the iPad; the preview starts on the biggest reaction, and it's used if nobody picks in time
      setState({ phase: 'choose', reactions, previewIndex: best, autoPick: best, selected: -1, photos, message: '' });
      return { ok: true };
    }
    Object.assign(state, { reactions, photos, selected: best, previewIndex: best });
    writeSessionMeta({ autoSelectedReaction: reactions[best].file, reactionScores: scores });
    log('Auto-selected reaction', reactions[best].file);
    startCompose();
    return { ok: true };
  }
  if (r.type === 'stripDone') {
    const stripUrl = sessionUrl(state.sessionId, 'strip.jpg');
    const photos = state.photos.slice(); photos[3] = state.reactions[state.selected].url;
    const ask = settings.print.enabled && settings.print.askGuests;
    setState({ phase: 'done', stripUrl, photos, message: '', printStatus: ask ? 'ask' : 'off', printCopies: 0, printAuto: false });
    writeSessionMeta({ completedAt: new Date().toISOString() });
    log('Strip complete for', state.sessionId);
    // No question: every session gets one print (one 4R sheet = 2 strips with the DNP 2-inch cut).
    if (settings.print.enabled && !settings.print.askGuests) startPrint(1, false);
    return { ok: true };
  }
  if (r.type === 'printed') {
    const sheets = r.sheets | 0;
    addPrints(sheets); writeSessionMeta({ prints: state.printCopies, printedSheets: sheets });
    setState({ printStatus: 'printed' });
    broadcastStatus();
    return { ok: true };
  }
  if (r.type === 'printFailed') {
    log('Print failed:', str(r.error, 300));
    setState({ printStatus: 'error' });
    return { ok: true };
  }
  if (r.type === 'failed') {
    const msg = str(r.error, 300) || 'Something went wrong.';
    log('Display reported failure:', msg);
    if (state.phase === 'composing') startCompose.fail(msg);
    else shotFailed(msg);
    return { ok: true };
  }
  return { ok: false, error: 'unknown report' };
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.mp4': 'video/mp4', '.m4v': 'video/mp4',
  '.mov': 'video/quicktime', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.woff2': 'font/woff2', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function isLocal(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
function adminAllowed(req) { return ALLOW_REMOTE_ADMIN || isLocal(req); }

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('Upload too large'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const b = await readBody(req, 1024 * 1024);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); } catch (_) { throw Object.assign(new Error('Invalid JSON'), { status: 400 }); }
}

async function serveFile(req, res, filePath, opts = {}) {
  let st;
  try { st = await fsp.stat(filePath); } catch (_) { return notFound(res); }
  if (!st.isFile()) return notFound(res);
  const ext = path.extname(filePath).toLowerCase();
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Cache-Control': opts.cache || 'no-cache',
    'Last-Modified': st.mtime.toUTCString(),
  };
  if (opts.download) headers['Content-Disposition'] = `attachment; filename="${opts.download}"`;
  const range = req.headers.range;
  if (range && /^bytes=\d*-\d*$/.test(range)) {
    let [s, e] = range.slice(6).split('-');
    let start = s === '' ? Math.max(0, st.size - parseInt(e, 10)) : parseInt(s, 10);
    let end = s === '' || e === '' ? st.size - 1 : Math.min(parseInt(e, 10), st.size - 1);
    if (start > end || start >= st.size) { res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }); return res.end(); }
    res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
    if (req.method === 'HEAD') return res.end();
    return fs.createReadStream(filePath, { start, end }).pipe(res);
  }
  res.writeHead(200, { ...headers, 'Content-Length': st.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
}
function notFound(res) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); }
function forbidden(res) {
  res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<body style="background:#0b0606;color:#eee;font-family:sans-serif;padding:40px"><h1>Operator pages are only available on the booth PC.</h1><p>Open this page on the PC at <b>http://localhost:' + PORT + '/admin</b>, or start the server with SCAREBOOTH_ALLOW_REMOTE_ADMIN=1.</p></body>');
}
function safeJoin(base, rel) {
  const p = path.resolve(base, '.' + path.sep + rel);
  return p.startsWith(base + path.sep) || p === base ? p : null;
}
function lanUrls() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      const virtual = /vEthernet|VirtualBox|VMware|Hyper-V|WSL|docker|Loopback|Bluetooth|tailscale|ZeroTier|vpn/i.test(name);
      const rank = (virtual ? 10 : 0) + (a.address.startsWith('192.168.') ? 0 : a.address.startsWith('10.') ? 1 : 2);
      out.push({ iface: name, ip: a.address, rank, url: `http://${a.address}:${PORT}/controller` });
    }
  }
  return out.sort((x, y) => x.rank - y.rank);
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
const PAGES = { '/': 'index.html', '/display': 'display.html', '/controller': 'controller.html', '/ipad': 'controller.html', '/admin': 'admin.html', '/gallery': 'gallery.html' };
const ADMIN_PAGES = new Set(['/admin', '/gallery', '/display']);

async function route(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = decodeURIComponent(url.pathname);

  if (req.method === 'GET' && PAGES[p]) {
    if (ADMIN_PAGES.has(p) && !adminAllowed(req)) return forbidden(res);
    return serveFile(req, res, path.join(PUBLIC_DIR, PAGES[p]));
  }

  // ---- Server-Sent Events --------------------------------------------------
  if (p === '/events' && req.method === 'GET') {
    const role = ['display', 'controller', 'admin'].includes(url.searchParams.get('role')) ? url.searchParams.get('role') : 'controller';
    if ((role === 'display' || role === 'admin') && !adminAllowed(req)) return forbidden(res);
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('retry: 1500\n\n');
    const id = crypto.randomUUID();
    clients.set(id, { res, role, ip: req.socket.remoteAddress, since: Date.now() });
    req.socket.setKeepAlive(true);
    if (role === 'display') {
      if (primaryDisplay && clients.has(primaryDisplay) && primaryDisplay !== id) send(clients.get(primaryDisplay).res, 'command', { cmd: 'demoted' });
      primaryDisplay = id;
      log('Display connected', req.socket.remoteAddress);
    } else log(role, 'connected', req.socket.remoteAddress);
    send(res, 'hello', { id, role, build: BUILD_ID });
    send(res, 'settings', settingsPayload());
    send(res, 'state', publicState());
    if (role === 'admin') send(res, 'status', statusPayload());
    broadcast('state', publicState(), ['controller']);
    broadcastStatus();
    req.on('close', () => {
      clients.delete(id);
      log(role, 'disconnected', req.socket.remoteAddress);
      if (id === primaryDisplay) {
        primaryDisplay = null;
        // promote another display if one is still connected
        for (const [cid, c] of clients) if (c.role === 'display') primaryDisplay = cid;
        if (state.pendingCmd && !displayOnline()) {
          watchdog = clearTimer(watchdog);
          state.pendingCmd = null;
          if (state.phase === 'composing') startCompose.fail('The display disconnected.');
          else if (state.phase === 'shooting') failSession('The booth screen disconnected. Please ask a staff member for help.');
        }
        cameraStatus = { ...cameraStatus, ok: displayOnline() && cameraStatus.ok, message: displayOnline() ? cameraStatus.message : 'Display not connected' };
      }
      broadcast('state', publicState(), ['controller']);
      broadcastStatus();
    });
    return;
  }

  // ---- Guest controller ----------------------------------------------------
  if (p === '/api/control' && req.method === 'POST') {
    const body = await readJson(req);
    const r = handleControl(body);
    return json(res, r.ok ? 200 : 409, { ...r, state: publicState() });
  }
  if (p === '/api/state' && req.method === 'GET') return json(res, 200, publicState());

  // ---- Display reports & uploads ------------------------------------------
  if (p === '/api/display/report' && req.method === 'POST') {
    if (!adminAllowed(req)) return forbidden(res);
    return json(res, 200, handleDisplayReport(await readJson(req)));
  }
  if (p === '/api/upload' && req.method === 'POST') {
    if (!adminAllowed(req)) return forbidden(res);
    const sid = url.searchParams.get('session') || '';
    const name = url.searchParams.get('name') || '';
    if (!/^[\w-]+$/.test(sid) || !fs.existsSync(sessionDir(sid))) return json(res, 400, { ok: false, error: 'Unknown session' });
    if (!/^((thumbs\/)?(photo[1-4]|reaction_\d{2}|strip)|candidates\/photo[1-3]_\d{2})\.jpg$/.test(name)) return json(res, 400, { ok: false, error: 'Bad file name' });
    const buf = await readBody(req, 40 * 1024 * 1024);
    if (buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8) return json(res, 400, { ok: false, error: 'Not a JPEG' });
    const dest = path.join(sessionDir(sid), name);
    await fsp.mkdir(path.dirname(dest), { recursive: true });
    if (name === 'strip.jpg' && url.searchParams.get('edited') === '1') {
      const orig = path.join(sessionDir(sid), 'strip_original.jpg');
      if (!fs.existsSync(orig) && fs.existsSync(dest)) await fsp.copyFile(dest, orig);
      let picks = []; try { picks = JSON.parse(url.searchParams.get('picks') || '[]').map(v => str(v, 80)).slice(0, 4); } catch (_) {}
      updateMetaFor(sid, m => ({ stripEdited: { at: new Date().toISOString(), photos: picks } }));
      log('Strip edited for', sid, picks.join(', '));
    }
    await fsp.writeFile(dest, buf);
    return json(res, 200, { ok: true, url: sessionUrl(sid, name) });
  }
  // ---- session video (saved on this PC only; never served to other devices) ----
  if (p === '/api/video' && req.method === 'POST') {
    if (!adminAllowed(req)) return forbidden(res);
    const sid = url.searchParams.get('session') || '', seq = parseInt(url.searchParams.get('seq'), 10), ext = url.searchParams.get('ext') === 'mp4' ? 'mp4' : 'webm';
    if (!/^[\w-]+$/.test(sid) || !fs.existsSync(sessionDir(sid)) || !(seq >= 0)) return json(res, 400, { ok: false, error: 'Bad video upload' });
    const key = sid + '.' + ext, expected = videoSeq.get(key) || 0;
    if (seq !== expected) return json(res, 409, { ok: false, error: `Video piece ${seq} arrived out of order (expected ${expected})` });
    const buf = await readBody(req, 200 * 1024 * 1024);
    await fsp[seq === 0 ? 'writeFile' : 'appendFile'](path.join(sessionDir(sid), 'interaction.' + ext), buf);
    videoSeq.set(key, seq + 1);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/video/end' && req.method === 'POST') {
    if (!adminAllowed(req)) return forbidden(res);
    const sid = url.searchParams.get('session') || '', ext = url.searchParams.get('ext') === 'mp4' ? 'mp4' : 'webm';
    if (!/^[\w-]+$/.test(sid)) return json(res, 400, { ok: false, error: 'Bad session' });
    const f = path.join(sessionDir(sid), 'interaction.' + ext);
    let bytes = 0; try { bytes = (await fsp.stat(f)).size; } catch (_) {}
    videoSeq.delete(sid + '.' + ext);
    if (bytes) { updateMetaFor(sid, { video: { file: 'interaction.' + ext, bytes } }); log('Session video saved:', sid, Math.round(bytes / 1024 / 1024 * 10) / 10, 'MB'); }
    return json(res, 200, { ok: true, bytes });
  }
  // ---- lights ----
  if (p === '/api/lights/cue' && req.method === 'POST') {
    if (!adminAllowed(req)) return forbidden(res);
    const body = await readJson(req);
    if (!['idle', 'session', 'flash', 'scare', 'off'].includes(body.cue)) return json(res, 400, { ok: false, error: 'Unknown light cue' });
    if (!settings.lights.enabled && !settings.wiz.enabled) return json(res, 200, { ok: true, skipped: 'lights off' });
    if (settings.lights.enabled) lights.cue(body.cue, { ms: Number(body.ms) || undefined });
    wiz.cue(body.cue);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/wiz/discover' && req.method === 'POST') {
    if (!adminAllowed(req)) return forbidden(res);
    return json(res, 200, { ok: true, bulbs: await wiz.discover() });
  }
  if (p === '/api/lights/raw' && req.method === 'POST') {
    if (!adminAllowed(req)) return forbidden(res);
    const body = await readJson(req);
    const line = String(body.line || '').trim();
    if (!/^(ROOM|FLASH|PULSE|STRIP|BREATHE|OFF|PING|LEDS|NEON|NEONINV|FLASHINV)( \d{1,5}){0,5}$/.test(line)) return json(res, 400, { ok: false, error: 'Not a lights command' });
    if (!lights.status.connected) return json(res, 409, { ok: false, error: 'The lights aren’t connected.' });
    lights.send(line);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/lights/ports' && req.method === 'GET') {
    if (!adminAllowed(req)) return forbidden(res);
    return json(res, 200, { ok: true, ports: await lights.listPorts() });
  }
  if (p === '/api/lights/reconnect' && req.method === 'POST') {
    if (!adminAllowed(req)) return forbidden(res);
    if (settings.lights.enabled) lights.connect();
    return json(res, 200, { ok: true });
  }
  if (p === '/api/test-upload' && req.method === 'POST') {
    if (!adminAllowed(req)) return forbidden(res);
    const name = (url.searchParams.get('name') || '').replace(/[^\w.-]/g, '');
    const dir = path.join(DATA_DIR, 'tests', (url.searchParams.get('run') || 'run').replace(/[^\w-]/g, ''));
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, name || 'test.jpg'), await readBody(req, 40 * 1024 * 1024));
    return json(res, 200, { ok: true });
  }

  // ---- Operator API --------------------------------------------------------
  if (p.startsWith('/api/') && !adminAllowed(req) && !['/api/control', '/api/state'].includes(p)) return forbidden(res);

  if (p === '/api/settings' && req.method === 'GET') return json(res, 200, settingsPayload());
  if (p === '/api/settings' && req.method === 'POST') {
    const body = await readJson(req);
    const prevTheme = settings.theme.name;
    settings = sanitizeSettings(deepMerge(settings, body));
    if (settings.theme.name !== prevTheme && !body.questions && !body.instructions && !(body.strip && (body.strip.title || body.strip.footer))) {
      applyThemePresets(settings, prevTheme, settings.theme.name);
      settings = sanitizeSettings(settings);
    }
    if (body.scares && isObj(body.scares.profiles)) {
      for (const id of Object.keys(body.scares.profiles)) settings.scares.profiles[id] = sanitizeProfile(deepMerge(settings.scares.profiles[id] || defaultProfile(id), body.scares.profiles[id]), id);
    }
    saveSettings();
    broadcastSettings();
    return json(res, 200, { ok: true, ...settingsPayload() });
  }
  if (p === '/api/settings/reset' && req.method === 'POST') {
    settings = sanitizeSettings({}); saveSettings(); broadcastSettings();
    return json(res, 200, { ok: true, ...settingsPayload() });
  }
  if (p === '/api/scares' && req.method === 'POST') {
    const name = safeName(url.searchParams.get('name'));
    const ext = path.extname(name).toLowerCase();
    if (![...IMAGE_EXT, ...VIDEO_EXT].includes(ext)) return json(res, 400, { ok: false, error: `Unsupported file type “${ext}”. Use PNG/WebP/GIF/SVG images or MP4/WebM videos.` });
    const buf = await readBody(req, 300 * 1024 * 1024);
    if (!buf.length) return json(res, 400, { ok: false, error: 'Empty file' });
    const final = uniqueName(SCARES_DIR, name);
    await fsp.writeFile(path.join(SCARES_DIR, final), buf);
    const id = 'upload/' + final;
    if (!settings.scares.profiles[id]) settings.scares.profiles[id] = sanitizeProfile({}, id);
    if (url.searchParams.get('activate') !== '0') settings.scares.active = id;
    saveSettings(); broadcastSettings();
    log('Scare uploaded', final, buf.length, 'bytes');
    return json(res, 200, { ok: true, id, ...settingsPayload() });
  }
  if (p === '/api/scares' && req.method === 'DELETE') {
    const id = url.searchParams.get('id') || '';
    if (!id.startsWith('upload/')) return json(res, 400, { ok: false, error: 'Built-in scares can’t be deleted' });
    const fp = safeJoin(SCARES_DIR, id.slice(7));
    if (!fp || !fs.existsSync(fp)) return json(res, 404, { ok: false, error: 'Not found' });
    await fsp.unlink(fp);
    delete settings.scares.profiles[id];
    if (settings.scares.active === id) settings.scares.active = BUILTIN_SCARES[0].id;
    saveSettings(); broadcastSettings();
    return json(res, 200, { ok: true, ...settingsPayload() });
  }
  if (p === '/api/sounds' && req.method === 'POST') {
    const name = safeName(url.searchParams.get('name'));
    if (!AUDIO_EXT.includes(path.extname(name).toLowerCase())) return json(res, 400, { ok: false, error: 'Use MP3, WAV, OGG or M4A audio.' });
    const final = uniqueName(SOUNDS_DIR, name);
    await fsp.writeFile(path.join(SOUNDS_DIR, final), await readBody(req, 50 * 1024 * 1024));
    settings.sound.sting = final; saveSettings(); broadcastSettings();
    return json(res, 200, { ok: true, ...settingsPayload() });
  }
  if (p === '/api/sounds' && req.method === 'DELETE') {
    const fp = safeJoin(SOUNDS_DIR, url.searchParams.get('id') || '');
    if (fp && fs.existsSync(fp)) await fsp.unlink(fp);
    if (settings.sound.sting === path.basename(fp || '')) settings.sound.sting = 'builtin';
    saveSettings(); broadcastSettings();
    return json(res, 200, { ok: true, ...settingsPayload() });
  }
  if (p === '/api/admin/command' && req.method === 'POST') {
    const body = await readJson(req);
    const allowed = ['testScare', 'previewOverlay', 'testSound', 'reloadCamera', 'reloadDisplay', 'testCapture', 'testPrint'];
    if (body.cmd === 'alignPrint') {
      // a strip with 1 mm frames on every edge, to measure how far the printer shifts / crops
      if (settings.print.method !== 'direct') return json(res, 200, { ok: false, error: 'The alignment print needs the “Print directly” method.' });
      directPrint(path.join(PUBLIC_DIR, 'assets', 'align-strip.jpg'), perSheet(settings.print.layout), settings.print.layout, 'ScareBooth alignment test', { noSafe: true })
        .then(() => printNotice(true, 'Alignment test sent. On each edge, note the first coloured frame you can see fully.'))
        .catch(e => printNotice(false, 'Alignment print failed: ' + e.message));
      return json(res, 200, { ok: true });
    }
    if (body.cmd === 'testPrint') {
      body.layout = settings.print.layout; body.copies = 1;
      if (settings.print.method === 'direct') {
        directPrint(path.join(PUBLIC_DIR, 'assets', 'test-strip.jpg'), perSheet(settings.print.layout), settings.print.layout, 'ScareBooth test print')
          .then(() => printNotice(true, `Test print sent to ${settings.print.printerName || 'the Windows default printer'}.`))
          .catch(e => printNotice(false, 'Test print failed: ' + e.message));
        return json(res, 200, { ok: true });
      }
    }
    if (!allowed.includes(body.cmd)) return json(res, 400, { ok: false, error: 'Unknown command' });
    if (body.cmd === 'testScare' && state.phase !== 'idle') return json(res, 409, { ok: false, error: 'Finish or cancel the current guest session before testing the scare.' });
    if (!sendToDisplay({ ...body })) return json(res, 409, { ok: false, error: 'The display page isn’t open. Open http://localhost:' + PORT + '/display on the booth monitor.' });
    return json(res, 200, { ok: true });
  }
  if (p === '/api/printers' && req.method === 'GET') {
    try {
      const out = await runPowerShell('list-printers.ps1', [], 20000);
      const data = JSON.parse(out.slice(out.indexOf('{')));
      if (data.error) return json(res, 500, { ok: false, error: data.error });
      const printers = Array.isArray(data.printers) ? data.printers : (data.printers ? [data.printers] : []);
      return json(res, 200, { ok: true, default: data.default || '', printers });
    } catch (e) { return json(res, 200, { ok: false, error: e.message, printers: [] }); }
  }
  if (p === '/api/admin/reprint' && req.method === 'POST') {
    const body = await readJson(req);
    const sid = String(body.sessionId || '');
    const copies = Number(body.copies);
    if (!/^[\w-]+$/.test(sid) || !fs.existsSync(path.join(sessionDir(sid), 'strip.jpg'))) return json(res, 404, { ok: false, error: 'That session has no strip.' });
    if (!Number.isInteger(copies) || copies < 1 || copies > 20) return json(res, 400, { ok: false, error: 'Choose 1–20 copies.' });
    if (settings.print.method === 'direct') {
      log('Reprint requested for', sid, copies, 'copies (direct)');
      directPrint(path.join(sessionDir(sid), 'strip.jpg'), copies, settings.print.layout, `ScareBooth reprint ${sid}`).then(sheets => {
        addPrints(sheets);
        updateMetaFor(sid, m => ({ reprints: (m.reprints || 0) + copies }));
        printNotice(true, `Reprinted ${copies} for ${sid}`); broadcastStatus();
      }).catch(e => { log('Reprint failed:', e.message); printNotice(false, 'Reprint failed: ' + e.message); });
      return json(res, 200, { ok: true });
    }
    if (state.phase === 'shooting' || state.phase === 'composing') return json(res, 409, { ok: false, error: 'A guest is taking photos right now — try again when they finish.' });
    const jobId = 'r' + (++reprintCounter);
    reprintJobs.set(jobId, sid);
    if (!sendToDisplay({ cmd: 'reprint', jobId, copies, stripUrl: sessionUrl(sid, 'strip.jpg'), layout: settings.print.layout })) {
      reprintJobs.delete(jobId);
      return json(res, 409, { ok: false, error: 'The booth display isn’t open, so nothing can print. Open the display first.' });
    }
    log('Reprint requested for', sid, copies, 'copies');
    return json(res, 200, { ok: true, jobId });
  }
  if (p === '/api/admin/restart-link' && req.method === 'POST') { tunnel.restarts = 0; startTunnel(); return json(res, 200, { ok: true }); }
  if (p === '/api/admin/reset-prints' && req.method === 'POST') { printCounter = { total: 0 }; addPrints(0); broadcastStatus(); return json(res, 200, { ok: true }); }
  if (p === '/api/admin/cancel' && req.method === 'POST') { resetToIdle('Session cancelled by staff.'); return json(res, 200, { ok: true }); }
  if (p === '/api/status' && req.method === 'GET') return json(res, 200, statusPayload());
  if (p === '/api/admin/session-photos' && req.method === 'GET') {
    if (!adminAllowed(req)) return forbidden(res);
    const sid = url.searchParams.get('id') || '';
    if (!/^[\w-]+$/.test(sid) || !fs.existsSync(sessionDir(sid))) return json(res, 404, { ok: false, error: 'Unknown session' });
    const dir = sessionDir(sid);
    const ls = async d => { try { return (await fsp.readdir(path.join(dir, d))).sort(); } catch (_) { return []; } };
    const top = await ls(''), cands = await ls('candidates');
    let meta = {}; try { meta = JSON.parse(await fsp.readFile(path.join(dir, 'session.json'), 'utf8')); } catch (_) {}
    const base = u => (u ? String(u).split('?')[0].split('/').pop() : null);
    const slots = [1, 2, 3].map(n => {
      const files = [...(top.includes(`photo${n}.jpg`) ? [`photo${n}.jpg`] : []), ...cands.filter(f => new RegExp(`^photo${n}_\\d{2}\\.jpg$`).test(f)).map(f => 'candidates/' + f)];
      const edited = meta.stripEdited && meta.stripEdited.photos && meta.stripEdited.photos[n - 1];
      return { files, current: files.includes(edited) ? edited : files[0] || null };
    });
    const reactions = top.filter(f => /^reaction_\d{2}\.jpg$/.test(f));
    const editedR = meta.stripEdited && meta.stripEdited.photos && meta.stripEdited.photos[3];
    const metaR = base(meta.photos && meta.photos[3]) || (meta.selected >= 0 && meta.reactions && meta.reactions[meta.selected] ? base(meta.reactions[meta.selected].url) : null) || meta.autoSelectedReaction;
    slots.push({ files: reactions, current: reactions.includes(editedR) ? editedR : reactions.includes(metaR) ? metaR : reactions[0] || null });
    return json(res, 200, { ok: true, id: sid, base: sessionUrl(sid, ''), slots, hasOriginal: top.includes('strip_original.jpg') });
  }
  if (p === '/api/admin/restore-strip' && req.method === 'POST') {
    if (!adminAllowed(req)) return forbidden(res);
    const sid = String((await readJson(req)).sessionId || '');
    const orig = path.join(sessionDir(sid), 'strip_original.jpg');
    if (!/^[\w-]+$/.test(sid) || !fs.existsSync(orig)) return json(res, 404, { ok: false, error: 'No original strip saved for that session.' });
    await fsp.copyFile(orig, path.join(sessionDir(sid), 'strip.jpg'));
    updateMetaFor(sid, m => ({ stripEdited: null }));
    log('Strip restored to the original for', sid);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/sessions' && req.method === 'GET') {
    const ids = (await fsp.readdir(SESSIONS_DIR)).filter(f => /^[\w-]+$/.test(f)).sort().reverse().slice(0, 300);
    const out = [];
    for (const id of ids) {
      const dir = sessionDir(id);
      let files = []; try { files = await fsp.readdir(dir); } catch (_) { continue; }
      out.push({
        id, strip: files.includes('strip.jpg') ? sessionUrl(id, 'strip.jpg') : null,
        photos: files.filter(f => /^photo\d\.jpg$/.test(f)).length, reactions: files.filter(f => /^reaction_\d+\.jpg$/.test(f)).length,
        video: files.find(f => /^interaction\.(mp4|webm)$/.test(f)) ? sessionUrl(id, files.find(f => /^interaction\.(mp4|webm)$/.test(f))) : null,
        folder: dir, prints: (() => { try { const m = JSON.parse(fs.readFileSync(path.join(dir, 'session.json'), 'utf8')); return (m.prints || 0) + (m.reprints || 0); } catch (_) { return 0; } })(),
      });
    }
    return json(res, 200, { ok: true, dataDir: DATA_DIR, sessionsDir: SESSIONS_DIR, sessions: out });
  }

  // ---- Media ---------------------------------------------------------------
  if (p.startsWith('/d/') && (req.method === 'GET' || req.method === 'HEAD')) return serveShare(req, res, url, p);
  if (p.startsWith('/sessions/') && (req.method === 'GET' || req.method === 'HEAD')) {
    // Other devices may only see the session in progress (the iPad's reaction picker); everything else is PC-only.
    const sidReq = p.split('/')[2];
    const rel = p.split('/').slice(3).join('/');
    if (!adminAllowed(req) && (sidReq !== state.sessionId || !/^((thumbs\/)?(photo[1-4]|reaction_\d{2})|strip)\.jpg$/.test(rel))) return forbidden(res);
    const fp = safeJoin(SESSIONS_DIR, p.slice('/sessions/'.length));
    if (!fp) return notFound(res);
    const dl = url.searchParams.get('download') ? `ScareBooth_${path.basename(path.dirname(fp))}_${path.basename(fp)}` : null;
    return serveFile(req, res, fp, { download: dl, cache: 'private, max-age=3600' });
  }
  if (p.startsWith('/media/scares/')) { const fp = safeJoin(SCARES_DIR, p.slice(14)); return fp ? serveFile(req, res, fp) : notFound(res); }
  if (p.startsWith('/media/sounds/')) { const fp = safeJoin(SOUNDS_DIR, p.slice(14)); return fp ? serveFile(req, res, fp) : notFound(res); }

  if (req.method === 'GET' || req.method === 'HEAD') {
    const fp = safeJoin(PUBLIC_DIR, p);
    if (fp) return serveFile(req, res, fp, { cache: /\.woff2$/.test(fp) ? 'public, max-age=86400' : 'no-cache' });
  }
  notFound(res);
}

function serveShare(req, res, url, p) {
  const [, , token, file] = p.split('/');
  const sid = shareTokens.get(token || '');
  if (!sid || !settings.share.enabled) return sharePage(res, null);
  if (!file) return sharePage(res, sid, token);
  if (!/^(strip|photo[1-3]|reaction_\d{2})\.jpg$/.test(file)) return notFound(res);
  const slug = String(settings.strip.title || 'ScareBooth').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'ScareBooth';
  const dl = url.searchParams.get('download') ? `${slug}_${sid.slice(0, 10)}_${file}` : null;
  return serveFile(req, res, path.join(sessionDir(sid), file), { download: dl, cache: file === 'strip.jpg' ? 'no-cache' : 'private, max-age=3600' });
}

function htmlEsc(v) { return String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function sharePage(res, sid, token) {
  const theme = settings.theme.name, title = htmlEsc(settings.strip.title || 'ScareBooth');
  const head = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — your photos</title><link rel="icon" href="/assets/favicon.svg"><link rel="stylesheet" href="/css/theme.css"><link rel="stylesheet" href="/css/romance.css"><style>
    body{overflow:auto;background:radial-gradient(ellipse at 50% 0%,#2a0a0e,#070405 60%);text-align:center;padding:28px 18px 60px}
    body.theme-romance{background:linear-gradient(180deg,#ffe9f0,#fbd3e0)}
    .logo{font-size:clamp(34px,11vw,56px);margin:6px 0 4px}.strip{width:min(78vw,340px);margin:18px auto;display:block;box-shadow:0 20px 50px #000,0 0 40px rgba(179,18,27,.35)}
    .btn{text-decoration:none;display:inline-flex;align-items:center;justify-content:center;width:min(90vw,420px)}
    p{color:var(--ash);font-size:16px;line-height:1.5;max-width:520px;margin:14px auto}.grid{display:grid;grid-template-columns:1fr 1fr;gap:10px;max-width:520px;margin:18px auto}
    .grid a img{width:100%;display:block;border:2px solid #2a1c1d}h2{font-family:var(--font-type);font-weight:normal;color:var(--bone);margin-top:34px}</style></head><body class="${theme === 'horror' ? 'grain theme-horror' : 'theme-romance share'}">`;
  let body;
  if (!sid) body = `<div class="logo">${title}</div><p>This photo link isn’t available (it may have been removed, or sharing is switched off).</p>`;
  else {
    const files = fs.existsSync(sessionDir(sid)) ? fs.readdirSync(sessionDir(sid)) : [];
    let meta = {}; try { meta = JSON.parse(fs.readFileSync(path.join(sessionDir(sid), 'session.json'), 'utf8')); } catch (_) {}
    const pick = meta.autoSelectedReaction || (Array.isArray(meta.reactions) && meta.selected >= 0 && meta.reactions[meta.selected] ? meta.reactions[meta.selected].file : null);
    const singles = ['photo1.jpg', 'photo2.jpg', 'photo3.jpg', pick].filter(f => f && files.includes(f));
    // in the language the guests chose at the booth
    const zh = meta.lang === 'zh', both = !meta.lang || meta.lang === 'both';
    const TZ = {
      eyebrow: theme === 'horror' ? '你活下来了' : '从此幸福快乐', alt: '你们的照片条', dl: '下载照片条',
      howto: '<b>iPhone：</b>长按照片条，选择<b>存储到“照片”</b>。<b>安卓：</b>点“下载”，或长按图片保存。',
      making: '照片条还在制作中——请稍后刷新。', singles: '单张照片', wifi: '连接拍照亭的 Wi-Fi 时才能打开此页面。离开前请保存好你们的照片！',
    };
    const TE = {
      eyebrow: theme === 'horror' ? 'You survived' : 'Happily ever after', alt: 'Your photo strip', dl: 'Download strip',
      howto: '<b>iPhone:</b> tap and hold the strip, then choose <b>Save to Photos</b>. <b>Android:</b> tap Download, or tap and hold the image.',
      making: 'Your strip is still being made — refresh in a moment.', singles: 'Single photos', wifi: 'This page works while you’re connected to the booth’s Wi-Fi. Save your photos before you leave!',
    };
    const T = zh ? TZ : !both ? TE : Object.fromEntries(Object.keys(TE).map(k => [k, k === 'howto' || k === 'wifi' || k === 'making' ? `${TE[k]}<br>${TZ[k]}` : `${TE[k]} · ${TZ[k]}`]));
    body = `<div class="eyebrow">${T.eyebrow}</div><div class="logo">${title}</div>` +
      (files.includes('strip.jpg') ? `<img class="strip" src="/d/${token}/strip.jpg" alt="${T.alt}">
      <a class="btn" href="/d/${token}/strip.jpg?download=1" download>${T.dl}</a>
      <p>${T.howto}</p>` : `<p>${T.making}</p>`) +
      (singles.length ? `<h2>${T.singles}</h2><div class="grid">${singles.map(f => `<a href="/d/${token}/${f}?download=1" download><img src="/d/${token}/${f}" alt=""></a>`).join('')}</div>` : '') +
      `<p>${T.wifi}</p>`;
  }
  res.writeHead(sid ? 200 : 404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(head + body + '</body></html>');
}

const server = http.createServer((req, res) => {
  route(req, res).catch(err => {
    log('Request error', req.method, req.url, err.message);
    if (!res.headersSent) json(res, err.status || 500, { ok: false, error: err.message || 'Server error' });
    else try { res.end(); } catch (_) {}
  });
});
server.keepAliveTimeout = 65000;
server.requestTimeout = 0; // allow long SSE streams and big uploads

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ERROR: Port ${PORT} is already in use.\n  Is ScareBooth already running in another window? Close it, or set a different port:\n     set PORT=8090 && start-scarebooth.bat\n`);
  } else console.error('Server error:', err);
  process.exit(1);
});

server.listen(PORT, '0.0.0.0', () => {
  const lines = [
    '',
    '  ╔══════════════════════════════════════════════════════╗',
    '  ║                  S C A R E B O O T H                 ║',
    '  ╚══════════════════════════════════════════════════════╝',
    '',
    `  Display (booth monitor):  http://localhost:${PORT}/display`,
    `  Operator console:         http://localhost:${PORT}/admin`,
    '  iPad controller (same Wi-Fi):',
    ...(() => {
      // hide VirtualBox / VMware / Hyper-V adapters: the iPad can never reach those
      const all = lanUrls(), real = all.filter(u => u.rank < 10), list = real.length ? real : all;
      return list.length ? list.map(u => `     ${u.url}    (${u.iface})`) : ['     (no network adapter found — connect the PC to Wi-Fi/LAN)'];
    })(),
    '',
    `  Photos are saved in: ${SESSIONS_DIR}`,
    '  Keep this window open while the booth is running. Press Ctrl+C to stop.',
    '',
  ];
  console.log(lines.join('\n'));
  log('Server listening on port', PORT);
});

// ===========================================================================
// Internet download links (Option A): a Cloudflare quick tunnel to a PUBLIC-ONLY server.
// The public server listens on 127.0.0.1 only and serves nothing but the download pages,
// so the console, display and settings are never reachable from the internet.
// ===========================================================================
const PUBLIC_PORT = parseInt(process.env.SCAREBOOTH_PUBLIC_PORT || String(PORT + 1), 10);
const PUBLIC_FILES = new Set(['/css/theme.css', '/css/romance.css', '/assets/favicon.svg', '/assets/florals-corner.svg']);
const tunnel = { status: 'off', url: null, message: '', nonce: crypto.randomBytes(12).toString('hex'), proc: null, restarts: 0, fails: 0, timer: null, healthTimer: null };

const publicServer = http.createServer((req, res) => {
  (async () => {
    const url = new URL(req.url, 'http://x');
    let p; try { p = decodeURIComponent(url.pathname); } catch (_) { return notFound(res); }
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (req.method !== 'GET' && req.method !== 'HEAD') return notFound(res);
    if (p === '/healthz') { res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' }); return res.end('scarebooth-ok ' + tunnel.nonce); }
    if (p.startsWith('/d/')) return serveShare(req, res, url, p);
    if (PUBLIC_FILES.has(p) || /^\/fonts\/[\w.-]+\.woff2$/.test(p)) return serveFile(req, res, path.join(PUBLIC_DIR, p), { cache: p.startsWith('/fonts/') ? 'public, max-age=86400' : 'no-cache' });
    return notFound(res);
  })().catch(() => { if (!res.headersSent) notFound(res); });
});
publicServer.on('error', e => log('Public download server error:', e.message));
publicServer.listen(PUBLIC_PORT, '127.0.0.1', () => log('Public download server on 127.0.0.1:' + PUBLIC_PORT));

function tunnelInfo() { return { status: tunnel.status, url: tunnel.url, message: tunnel.message, mode: settings.share.mode }; }
function setTunnel(patch) {
  const before = JSON.stringify(tunnelInfo());
  Object.assign(tunnel, patch);
  if (JSON.stringify(tunnelInfo()) !== before) {
    if (patch.status) log('Internet sharing:', tunnel.status, tunnel.url || '', tunnel.message || '');
    broadcastStatus();
    broadcast('state', publicState());
  }
}
function findCloudflared() {
  const exe = IS_WIN ? 'cloudflared.exe' : 'cloudflared';
  const candidates = [process.env.SCAREBOOTH_CLOUDFLARED, path.join(ROOT, 'tools', exe)];
  if (IS_WIN) candidates.push(path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'cloudflared', exe), path.join(process.env.ProgramFiles || 'C:\\Program Files', 'cloudflared', exe));
  for (const c of candidates) if (c && fs.existsSync(c)) return c;
  for (const dir of String(process.env.PATH || '').split(path.delimiter)) { const c = path.join(dir, exe); if (dir && fs.existsSync(c)) return c; }
  return null;
}
function stopTunnel() {
  clearTimeout(tunnel.timer); clearInterval(tunnel.healthTimer);
  if (tunnel.proc) { const pr = tunnel.proc; tunnel.proc = null; try { pr.kill(); } catch (_) {} }
}
function checkHealth() {
  if (!tunnel.url) return;
  const target = (process.env.SCAREBOOTH_TUNNEL_HEALTH_BASE || tunnel.url) + '/healthz';
  const mod = target.startsWith('https:') ? https : http;
  const req = mod.get(target, { timeout: 8000, headers: { 'Cache-Control': 'no-cache' } }, res => {
    let body = ''; res.on('data', d => { body += d; if (body.length > 200) res.destroy(); });
    res.on('end', () => {
      if (res.statusCode === 200 && body.includes(tunnel.nonce)) { tunnel.fails = 0; tunnel.restarts = 0; setTunnel({ status: 'online', message: '' }); }
      else onHealthFail('the link answered, but not from this booth');
    });
  });
  req.on('timeout', () => req.destroy(new Error('timed out')));
  req.on('error', e => onHealthFail(e.message));
}
function onHealthFail(why) {
  tunnel.fails++;
  // a brand-new quick tunnel can take a little while before its address works
  if (tunnel.status === 'starting' && tunnel.fails < 8) return;
  if (tunnel.fails >= 2) setTunnel({ status: 'offline', message: 'Internet link not reachable (' + why + '). Using booth Wi-Fi QR codes for now.' });
  if (tunnel.fails >= 6 && !settings.share.customUrl && !process.env.SCAREBOOTH_TUNNEL_MOCK_URL) restartTunnel('link stopped responding');
}
function restartTunnel(why) {
  stopTunnel();
  const delay = Math.min(60000, 5000 * Math.pow(2, tunnel.restarts++));
  setTunnel({ status: 'offline', url: null, message: `Reconnecting (${why})…` });
  tunnel.timer = setTimeout(startTunnel, delay);
}
function startTunnel() {
  stopTunnel();
  tunnel.fails = 0;
  if (!settings.share.enabled || settings.share.mode === 'wifi') { setTunnel({ status: 'off', url: null, message: '' }); return; }
  const startHealth = () => { clearInterval(tunnel.healthTimer); checkHealth(); tunnel.healthTimer = setInterval(checkHealth, 15000); };
  const fixed = settings.share.customUrl || process.env.SCAREBOOTH_TUNNEL_MOCK_URL;
  if (fixed) { setTunnel({ status: 'starting', url: fixed.replace(/\/$/, ''), message: 'Checking your fixed address…' }); startHealth(); return; }
  const bin = findCloudflared();
  if (!bin) { setTunnel({ status: 'missing', url: null, message: 'The free Cloudflare tunnel tool isn’t installed. Run install-online-sharing.bat once (needs internet), then restart ScareBooth.' }); return; }
  setTunnel({ status: 'starting', url: null, message: 'Opening a secure internet link…' });
  let proc;
  try { proc = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${PUBLIC_PORT}`], { windowsHide: true }); }
  catch (e) { setTunnel({ status: 'offline', message: 'Couldn’t start the tunnel tool: ' + e.message }); return; }
  tunnel.proc = proc;
  let lastLine = '';
  const onData = (buf) => {
    for (const line of String(buf).split(/\r?\n/)) {
      if (!line.trim()) continue;
      lastLine = line.replace(/^\S+\s+\w{3}\s+/, '').slice(0, 200);
      const m = line.match(/https:\/\/[a-z0-9]+(?:-[a-z0-9]+)+\.trycloudflare\.com/i); // e.g. https://word-word-word.trycloudflare.com (never api.trycloudflare.com)
      if (m && tunnel.url !== m[0]) { setTunnel({ url: m[0], status: 'starting', message: 'Link created — waiting for it to come online…' }); startHealth(); }
    }
  };
  proc.stdout.on('data', onData); proc.stderr.on('data', onData);
  proc.on('error', e => { if (tunnel.proc === proc) { tunnel.proc = null; restartTunnel(e.message); } });
  proc.on('exit', code => {
    if (tunnel.proc !== proc) return; // stopped on purpose
    tunnel.proc = null; clearInterval(tunnel.healthTimer);
    restartTunnel(/no such host|dial tcp|connection refused|failed to request/i.test(lastLine) ? 'no internet connection' : (lastLine || 'tunnel closed, code ' + code));
  });
}
startTunnel();
let lastShareKey = JSON.stringify([settings.share.enabled, settings.share.mode, settings.share.customUrl]);
setInterval(() => { // react to console changes
  const k = JSON.stringify([settings.share.enabled, settings.share.mode, settings.share.customUrl]);
  if (k !== lastShareKey) { lastShareKey = k; tunnel.restarts = 0; startTunnel(); }
}, 1000);

function shutdown() { log('Shutting down'); stopTunnel(); try { lights.disconnect(); } catch (_) {} try { wiz.close(); } catch (_) {} try { saveSettings(); } catch (_) {} process.exit(0); }
process.on('exit', () => { try { tunnel.proc && tunnel.proc.kill(); } catch (_) {} });
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
