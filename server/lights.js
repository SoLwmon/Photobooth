'use strict';
/*
 * ScareBooth light controller (PC side).
 *
 * Talks to the ScareBooth Lights box (an ESP32 running hardware/ScareBoothLights) over USB serial,
 * using one-line text commands:
 *   PING                     -> PONG SCAREBOOTH-LIGHTS <version> <ledCount>
 *   LEDS <n>                 set the number of LEDs on the strip (saved on the board)
 *   ROOM <0-255>             room light brightness (0 = off)
 *   FLASH <0-255>            flash light, steady level
 *   PULSE <ms> [0-255]       flash light on for <ms>, then off
 *   STRIP <r> <g> <b> [bri]  LED strip solid colour
 *   BREATHE <r> <g> <b> [period ms] [bri]   LED strip slow breathing colour
 *   OFF                      everything off
 *
 * On Windows the serial port is opened by a small PowerShell helper (scripts/serial-bridge.ps1),
 * so no extra software or drivers beyond the board's USB driver are needed.
 * A built-in simulator ("Simulator" port) behaves like the board, for testing without hardware.
 */
const { spawn } = require('child_process');
const path = require('path');
const EventEmitter = require('events');

const IS_WIN = process.platform === 'win32';
const hex = (h) => { const n = parseInt(String(h || '#000000').slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

// ------------------------------------------------------------------ transports
class SimulatorTransport extends EventEmitter {
  constructor() { super(); this.name = 'Simulator'; this.leds = 60; }
  open() { setTimeout(() => this.emit('open'), 20); }
  write(line) {
    const [cmd, ...a] = line.trim().split(/\s+/);
    const reply = (t) => setTimeout(() => this.emit('line', t), 5);
    switch ((cmd || '').toUpperCase()) {
      case 'PING': return reply(`PONG SCAREBOOTH-LIGHTS 1 ${this.leds}`);
      case 'LEDS': this.leds = parseInt(a[0], 10) || this.leds; return reply('OK LEDS');
      case 'PULSE': reply('OK PULSE'); return setTimeout(() => this.emit('line', 'DONE PULSE'), parseInt(a[0], 10) || 0);
      case 'ROOM': case 'FLASH': case 'STRIP': case 'BREATHE': case 'OFF': return reply('OK ' + cmd.toUpperCase());
      default: return reply('ERR unknown command');
    }
  }
  close() { this.emit('close'); }
}

class BridgeTransport extends EventEmitter {
  constructor(port, scriptsDir) { super(); this.name = port; this.port = port; this.scriptsDir = scriptsDir; this.proc = null; }
  open() {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(this.scriptsDir, 'serial-bridge.ps1'), '-Port', this.port, '-Baud', '115200'], { windowsHide: true });
    this.proc = ps;
    let buf = '';
    ps.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, ''); buf = buf.slice(i + 1);
        if (line.startsWith('RX ')) this.emit('line', line.slice(3));
        else if (line.startsWith('OPEN')) this.emit('open');
        else if (line.startsWith('ERR')) this.emit('error', new Error(line.slice(4)));
      }
    });
    ps.on('error', (e) => this.emit('error', e));
    ps.on('exit', () => { this.proc = null; this.emit('close'); });
  }
  write(line) { if (this.proc && this.proc.stdin.writable) this.proc.stdin.write('SEND ' + line + '\n'); }
  close() { if (this.proc) { try { this.proc.stdin.write('QUIT\n'); } catch (_) {} const p = this.proc; setTimeout(() => { try { p.kill(); } catch (_) {} }, 500); } }
}

// ------------------------------------------------------------------ controller
class Lights extends EventEmitter {
  constructor({ log, scriptsDir }) {
    super();
    this.log = log; this.scriptsDir = scriptsDir;
    this.t = null; this.settings = null;
    this.status = { enabled: false, connected: false, port: null, device: null, message: 'Lights are switched off in the console.' };
    this.look = { room: 0, strip: [0, 0, 0], stripMode: 'off', flash: 0, cue: null };
    this.pingTimer = null; this.reconnectTimer = null; this.lastPong = 0; this.pulseTimer = null;
  }

  setStatus(p) { Object.assign(this.status, p); this.emit('change'); }

  async listPorts() {
    const out = [{ id: 'auto', name: 'Auto-detect the ScareBooth Lights box' }, { id: 'simulator', name: 'Simulator (no hardware — for testing)' }];
    if (!IS_WIN) return out;
    try {
      const txt = await new Promise((resolve, reject) => {
        const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(this.scriptsDir, 'list-serial.ps1')], { windowsHide: true });
        let s = ''; ps.stdout.on('data', d => (s += d)); ps.on('error', reject); ps.on('exit', () => resolve(s));
        setTimeout(() => { try { ps.kill(); } catch (_) {} resolve(s); }, 15000);
      });
      const data = JSON.parse(txt.slice(txt.indexOf('[')) || '[]');
      for (const p of (Array.isArray(data) ? data : [data])) if (p && p.port) out.push({ id: p.port, name: `${p.port} — ${p.name || 'serial port'}` });
    } catch (e) { this.log('Could not list serial ports:', e.message); }
    return out;
  }

  /** Apply settings; (re)connects when the port or the on/off switch changes. */
  configure(settings) {
    const prev = this.settings;
    this.settings = settings;
    const L = settings.lights;
    if (!L.enabled) { this.disconnect(); this.setStatus({ enabled: false, connected: false, port: null, message: 'Lights are switched off in the console.' }); return; }
    const changed = !prev || !prev.lights.enabled || prev.lights.port !== L.port;
    if (changed) this.connect();
    else if (prev.lights.ledCount !== L.ledCount && this.status.connected) this.send(`LEDS ${L.ledCount}`);
  }

  disconnect() {
    clearInterval(this.pingTimer); clearTimeout(this.reconnectTimer);
    if (this.t) { const t = this.t; this.t = null; t.removeAllListeners(); try { t.close(); } catch (_) {} }
  }

  async connect() {
    this.disconnect();
    const want = this.settings.lights.port || 'auto';
    this.setStatus({ enabled: true, connected: false, port: null, device: null, message: 'Connecting to the lights…' });
    let candidates;
    if (want === 'simulator' || process.env.SCAREBOOTH_LIGHTS_MOCK === '1') candidates = ['simulator'];
    else if (want === 'auto') {
      if (!IS_WIN) { this.setStatus({ message: 'The USB lights box works on Windows. Choose “Simulator” to test here.' }); return; }
      candidates = (await this.listPorts()).map(p => p.id).filter(id => id !== 'auto' && id !== 'simulator');
      if (!candidates.length) { this.setStatus({ message: 'No USB serial ports found. Plug in the lights box (and install its USB driver), then press Reconnect.' }); this.scheduleReconnect(); return; }
    } else candidates = [want];

    for (const c of candidates) {
      if (!this.settings.lights.enabled) return;
      const t = c === 'simulator' ? new SimulatorTransport() : new BridgeTransport(c, this.scriptsDir);
      const pong = await this.tryPort(t);
      if (pong) { this.attach(t, pong); return; }
      t.removeAllListeners(); try { t.close(); } catch (_) {}
    }
    this.setStatus({ connected: false, message: want === 'auto' ? 'The lights box didn’t answer on any USB port. Check the cable and that the ScareBooth Lights code is uploaded, then press Reconnect.' : `The lights box didn’t answer on ${want}.` });
    this.scheduleReconnect();
  }

  tryPort(t) {
    return new Promise((resolve) => {
      let done = false, pinger = null;
      const finish = (v) => { if (done) return; done = true; clearInterval(pinger); clearTimeout(to); resolve(v); };
      const to = setTimeout(() => finish(null), 4500); // the board may reboot when the port opens
      t.on('line', (line) => { if (/^PONG SCAREBOOTH-LIGHTS/.test(line)) finish(line); });
      t.on('error', () => finish(null));
      t.on('close', () => finish(null));
      t.on('open', () => { t.write('PING'); pinger = setInterval(() => t.write('PING'), 600); });
      try { t.open(); } catch (_) { finish(null); }
    });
  }

  attach(t, pong) {
    this.t = t;
    const [, , ver, leds] = pong.split(/\s+/);
    this.lastPong = Date.now();
    this.setStatus({ connected: true, port: t.name, device: `ScareBooth Lights v${ver || '?'} (${leds || '?'} LEDs)`, message: '' });
    this.log('Lights connected on', t.name, pong);
    t.on('line', (line) => {
      if (/^PONG/.test(line)) this.lastPong = Date.now();
      if (/^DONE PULSE/.test(line)) { this.look.flash = 0; this.emit('change'); }
      const ok = /^OK (\w+)/.exec(line);
      if (ok && this.pending[ok[1]]) { clearTimeout(this.pending[ok[1]].timer); delete this.pending[ok[1]]; }
      if (/^ERR/.test(line)) this.log('Lights box:', line);
    });
    const lost = (why) => {
      if (this.t !== t) return;
      this.t = null; clearInterval(this.pingTimer);
      this.setStatus({ connected: false, message: 'Lost the lights box (' + why + '). Reconnecting…' });
      this.log('Lights disconnected:', why);
      this.scheduleReconnect(3000);
    };
    t.on('close', () => lost('USB disconnected'));
    t.on('error', (e) => lost(e.message));
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastPong > 15000) { try { t.close(); } catch (_) {} lost('no answer'); return; }
      t.write('PING');
    }, 5000);
    this.send(`LEDS ${this.settings.lights.ledCount}`);
    this.emit('connected');
  }

  scheduleReconnect(ms = 10000) {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => { if (this.settings && this.settings.lights.enabled && !this.status.connected) this.connect(); }, ms);
  }

  send(line) {
    // keep a copy of what the lights should look like (shown live in the console)
    const [cmd, ...a] = line.split(/\s+/); const n = a.map(Number);
    if (cmd === 'ROOM') this.look.room = n[0];
    if (cmd === 'FLASH') this.look.flash = n[0];
    if (cmd === 'PULSE') {
      this.look.flash = n[1] ?? 255;
      clearTimeout(this.pulseTimer); this.pulseTimer = setTimeout(() => { this.look.flash = 0; this.emit('change'); }, n[0] || 0);
    }
    if (cmd === 'STRIP') { this.look.strip = scaleRgb(n.slice(0, 3), n[3]); this.look.stripMode = 'solid'; }
    if (cmd === 'BREATHE') { this.look.strip = scaleRgb(n.slice(0, 3), n[4]); this.look.stripMode = 'breathe'; }
    if (cmd === 'OFF') { this.look = { ...this.look, room: 0, flash: 0, strip: [0, 0, 0], stripMode: 'off' }; }
    this.emit('change');
    if (this.t && this.status.connected) { this.t.write(line); this.expectOk(cmd, line); }
  }

  /**
   * Every command is answered with "OK <command>". If no answer comes, the command is sent again
   * (up to twice). An Arduino UNO can miss characters while it is updating the LED strip, so this
   * makes sure the scare and flash commands always arrive. A PULSE is resent with the time left.
   */
  expectOk(cmd, line, tries = 0, sentAt = Date.now()) {
    if (!this.pending) this.pending = {};
    const prev = this.pending[cmd]; if (prev) clearTimeout(prev.timer);
    const p = { line, tries, sentAt: prev && tries ? prev.sentAt : sentAt };
    p.timer = setTimeout(() => {
      if (this.pending[cmd] !== p) return;
      if (!this.t || !this.status.connected || p.tries >= 2) { delete this.pending[cmd]; if (p.tries >= 2) this.log('Lights box did not confirm:', line); return; }
      let again = line;
      if (cmd === 'PULSE') {
        const [, ms, lvl] = line.split(/\s+/);
        const left = (parseInt(ms, 10) || 0) - (Date.now() - p.sentAt);
        if (left < 60) { delete this.pending[cmd]; return; }
        again = `PULSE ${left} ${lvl || 255}`;
      }
      this.t.write(again);
      this.expectOk(cmd, line, p.tries + 1);
    }, 180);
    this.pending[cmd] = p;
  }

  /** Named lighting moments used by the booth. */
  cue(name, opts = {}) {
    const L = this.settings.lights;
    clearTimeout(this.flashDelayTimer); // a new moment cancels a scare flash that hasn't fired yet
    const bri = L.stripBrightness;
    const rgb = (h) => hex(h).join(' ');
    this.look.cue = name;
    // Pin 10 output: a room light (on normally, off at the scare) or a relay that switches a light
    // on only for the jump scare (e.g. a red neon). Relay boards that switch on with a LOW signal are inverted.
    const scareOnly = L.relayMode === 'scare';
    const room = (on) => {
      const v = on ? (scareOnly ? 255 : L.roomLevel) : 0;
      this.send(`ROOM ${L.relayInvert ? 255 - v : v}`);
    };
    switch (name) {
      case 'idle':
        room(!scareOnly); this.send('FLASH 0');
        this.send(`BREATHE ${rgb(L.idleColor)} 4000 ${bri}`);
        break;
      case 'session':
        room(!scareOnly); this.send('FLASH 0');
        this.send(`STRIP ${rgb(L.sessionColor)} ${bri}`);
        break;
      case 'flash':
        this.send(`PULSE ${Math.max(50, Math.min(5000, opts.ms || 700))} ${L.flashLevel}`);
        break;
      case 'scare':
        // jump scare: room light off, LED strip red, flash device on for the reaction burst
        room(scareOnly);
        this.send(`STRIP ${rgb(L.scareColor)} 255`);
        {
          // the flash can wait (e.g. 1.5 s, for the scream in the scare clip); it still ends when the burst ends
          const total = Math.max(200, Math.min(10000, opts.ms || 3000)), wait = L.scareFlashDelayMs || 0;
          const pulse = () => this.send(`PULSE ${Math.max(800, total - wait)} ${L.flashLevel}`);
          if (wait > 0) this.flashDelayTimer = setTimeout(pulse, wait); else pulse();
        }
        break;
      case 'off':
        this.send('OFF');
        if (L.relayInvert) room(false);
        break;
      default:
        return false;
    }
    return true;
  }

  info() { return { ...this.status, look: this.look }; }
}
function scaleRgb([r, g, b], bri) { const k = (bri == null || isNaN(bri) ? 255 : bri) / 255; return [r, g, b].map(v => Math.round((v || 0) * k)); }

module.exports = { Lights };
