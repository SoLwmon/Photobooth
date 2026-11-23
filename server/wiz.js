'use strict';
/*
 * WiZ smart bulb control (PC side).
 *
 * WiZ bulbs listen on the local Wi-Fi network on UDP port 38899 and take small JSON messages:
 *   {"method":"setPilot","params":{"r":255,"g":0,"b":0,"dimming":100}}   colour + brightness (10–100)
 *   {"method":"setPilot","params":{"state":false}}                        off
 *   {"method":"getPilot","params":{}}                                     ask for the current state
 * No cloud, no account and no internet are needed — only the PC and the bulb on the same router.
 * (In the WiZ app: Settings → Security → "Allow local communication" must be on. It is by default.)
 *
 * UDP can drop a packet, so every colour change is sent twice, 80 ms apart. Sending the same
 * colour twice is harmless.
 */
const dgram = require('dgram');
const os = require('os');
const EventEmitter = require('events');

const PORT = Number(process.env.SCAREBOOTH_WIZ_PORT) || 38899;
const hex = (h) => { const n = parseInt(String(h || '#000000').slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };

class Wiz extends EventEmitter {
  constructor({ log }) {
    super();
    this.log = log;
    this.settings = null;
    this.sock = null;
    this.bulbs = new Map(); // ip -> { ip, online, lastSeen, mac, state }
    this.look = { cue: null, color: '#000000', dimming: 0, on: false };
    this.found = new Map(); // replies while "Find bulbs" is running
    this.pollTimer = null;
    this.msgId = 1;
  }

  ensureSocket() {
    if (this.sock) return this.sock;
    const s = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    s.on('error', (e) => { this.log('WiZ socket error:', e.message); try { s.close(); } catch (_) {} if (this.sock === s) this.sock = null; });
    s.on('message', (buf, rinfo) => this.onMessage(buf, rinfo));
    s.bind(0, () => { try { s.setBroadcast(true); } catch (_) {} });
    this.sock = s;
    return s;
  }

  onMessage(buf, rinfo) {
    let msg; try { msg = JSON.parse(String(buf)); } catch (_) { return; }
    const r = msg && msg.result; if (!r) return;
    const info = { ip: rinfo.address, lastSeen: Date.now(), online: true };
    if (r.mac) info.mac = r.mac;
    if (r.state !== undefined) info.state = r.state;
    if (msg.method === 'getPilot' || msg.method === 'getSystemConfig') this.found.set(rinfo.address, { ...(this.found.get(rinfo.address) || {}), ...info, module: r.moduleName || (this.found.get(rinfo.address) || {}).module || '' });
    const b = this.bulbs.get(rinfo.address);
    if (b) { const was = b.online; Object.assign(b, info); if (!was) this.emit('change'); }
  }

  send(ip, method, params) {
    const s = this.ensureSocket();
    const buf = Buffer.from(JSON.stringify({ id: this.msgId++ % 100000, method, params }));
    try { s.send(buf, PORT, ip); } catch (e) { this.log('WiZ send failed:', e.message); }
  }

  /** Apply settings: which bulbs, on/off. */
  configure(settings) {
    const prev = this.settings ? JSON.stringify(this.settings.wiz) : '';
    this.settings = settings;
    const W = settings.wiz;
    const ips = W.enabled ? parseIps(W.bulbs) : [];
    for (const ip of [...this.bulbs.keys()]) if (!ips.includes(ip)) this.bulbs.delete(ip);
    for (const ip of ips) if (!this.bulbs.has(ip)) this.bulbs.set(ip, { ip, online: false, lastSeen: 0, mac: '' });
    clearInterval(this.pollTimer);
    if (ips.length) {
      this.poll();
      this.pollTimer = setInterval(() => this.poll(), 10000);
    }
    // bulb added, switched on, or a colour changed in the console: show the current look straight away
    if (ips.length && prev !== JSON.stringify(W) && this.look.cue !== 'scare') this.cue(this.look.cue && this.look.cue !== 'off' ? this.look.cue : 'idle');
    this.emit('change');
  }

  /** Ask every bulb for its state; a bulb that hasn't answered for 25 s shows as offline. */
  poll() {
    const now = Date.now();
    let changed = false;
    for (const b of this.bulbs.values()) {
      if (b.online && now - b.lastSeen > 25000) { b.online = false; changed = true; }
      this.send(b.ip, 'getPilot', {});
    }
    if (changed) this.emit('change');
  }

  /** Broadcast on every network the PC is on and collect the bulbs that answer. */
  discover(ms = 2500) {
    this.ensureSocket();
    this.found = new Map();
    const targets = new Set(['255.255.255.255']);
    for (const list of Object.values(os.networkInterfaces())) {
      for (const a of list || []) if (a.family === 'IPv4' && !a.internal && a.netmask) targets.add(broadcastAddr(a.address, a.netmask));
    }
    if (process.env.SCAREBOOTH_WIZ_TEST_IP) targets.add(process.env.SCAREBOOTH_WIZ_TEST_IP);
    const ask = () => { for (const t of targets) { this.send(t, 'getPilot', {}); this.send(t, 'getSystemConfig', {}); } };
    ask(); setTimeout(ask, 700); setTimeout(ask, 1500);
    return new Promise((resolve) => setTimeout(() => {
      resolve([...this.found.values()].sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true })));
    }, ms));
  }

  setColor(color, dimming) {
    const [r, g, b] = hex(color);
    const d = Math.max(10, Math.min(100, Math.round(dimming)));
    this.look = { ...this.look, color, dimming: d, on: true };
    this.sendAll('setPilot', { state: true, r, g, b, dimming: d });
  }
  setOff() { this.look = { ...this.look, on: false, dimming: 0 }; this.sendAll('setPilot', { state: false }); }
  sendAll(method, params) {
    const ips = [...this.bulbs.keys()];
    if (!ips.length) return;
    for (const ip of ips) this.send(ip, method, params);
    setTimeout(() => { for (const ip of ips) this.send(ip, method, params); }, 80);
    this.emit('change');
  }

  /** Same named moments as the lights box. */
  cue(name) {
    if (!this.settings || !this.settings.wiz.enabled) return false;
    const W = this.settings.wiz;
    this.look.cue = name;
    switch (name) {
      case 'idle': this.setColor(W.idleColor, W.brightness); break;
      case 'session': this.setColor(W.sessionColor, W.brightness); break;
      case 'scare': this.setColor(W.scareColor, 100); break;
      case 'off': this.setOff(); break;
      case 'flash': return true; // bulbs are too slow to be a camera flash — the flash strip does this
      default: return false;
    }
    return true;
  }

  info() {
    const W = this.settings ? this.settings.wiz : { enabled: false };
    const bulbs = [...this.bulbs.values()].map(b => ({ ip: b.ip, online: b.online, mac: b.mac }));
    let message = '';
    if (!W.enabled) message = 'WiZ bulb control is off.';
    else if (!bulbs.length) message = 'Add the bulb’s IP address, or press “Find bulbs”.';
    else if (!bulbs.some(b => b.online)) message = 'The bulb isn’t answering. Check it is switched on at the wall and connected to the same router as this PC.';
    return { enabled: !!W.enabled, bulbs, look: this.look, message };
  }

  close() { clearInterval(this.pollTimer); if (this.sock) { try { this.sock.close(); } catch (_) {} this.sock = null; } }
}

function parseIps(s) {
  return [...new Set(String(s || '').split(/[\s,;]+/).map(x => x.trim()).filter(x => /^\d{1,3}(\.\d{1,3}){3}$/.test(x)))].slice(0, 8);
}
function broadcastAddr(ip, mask) {
  const a = ip.split('.').map(Number), m = mask.split('.').map(Number);
  return a.map((v, i) => (v & m[i]) | (~m[i] & 255)).join('.');
}

module.exports = { Wiz, parseIps };
