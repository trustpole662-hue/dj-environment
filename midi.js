'use strict';
/* Web MIDI controller layer: device detection, MIDI-learn mapping, and dispatch to UI handlers (C[id]).
 *
 * Handler kinds registered by the UI in C[id]:
 *   btn: { press(down) }   abs: { setNorm(0..1) }   jog: { jog(ticks) }   enc: { step(-1|1) }
 */

const MAP_KEY = 'djtl.map.v1';
const DEVICE_RE = /dj2go|numark/i;

const hex = (n) => n.toString(16).toUpperCase().padStart(2, '0');

/* Relative encoders: 'twos' = 1/127, 'twosRev' = 127/1 for clockwise, 'off64' = 64+n. */
function decodeRelative(v, enc) {
  if (enc === 'off64') return v - 64;
  if (enc === 'twosRev') return v < 64 ? -v : 128 - v;
  return v < 64 ? v : v - 128;
}
function detectEncoding(clockwiseSample) {
  if (clockwiseSample < 64) return 'twos';
  return clockwiseSample >= 120 ? 'twosRev' : 'off64';
}

class Controller {
  constructor({ onStatus, onMessage, onLearned }) {
    this.onStatus = onStatus;
    this.onMessage = onMessage;
    this.onLearned = onLearned;
    this.map = {};          // "n:0:12" -> { id, enc?, lsb? }
    this.hi = {};           // 14-bit accumulators
    this.learnId = null;
    this.learnKind = null;
    this.cands = [];
    this.deviceName = '';
    this.load();
  }

  load() {
    try { this.map = JSON.parse(localStorage.getItem(MAP_KEY)) || {}; } catch (_) { this.map = {}; }
  }
  save() {
    try { localStorage.setItem(MAP_KEY, JSON.stringify(this.map)); } catch (_) { /* storage blocked */ }
  }
  get mapped() { return Object.keys(this.map).length > 0; }
  clearMap() { this.map = {}; this.save(); }
  isBound(id) { return Object.values(this.map).some((b) => b.id === id); }

  async start() {
    if (!navigator.requestMIDIAccess) return this.onStatus('unsupported', 'MIDI not supported');
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch (_) {
      return this.onStatus('denied', 'MIDI access denied');
    }
    this.access.onstatechange = () => this.attach();
    this.attach();
  }

  attach() {
    const inputs = [...this.access.inputs.values()];
    inputs.forEach((i) => { i.onmidimessage = (e) => this.handle(e.data); });
    const dev = inputs.find((i) => i.state === 'connected' && DEVICE_RE.test(i.name || ''));
    const first = inputs.find((i) => i.state === 'connected');
    const before = this.deviceName;
    this.deviceName = dev ? dev.name : '';
    if (dev) this.onStatus('ready', `${dev.name} connected`, !before);
    else if (first) this.onStatus('other', `${first.name} (not a Numark)`);
    else this.onStatus('none', 'No controller — plug in the DJ2GO2 Touch');
  }

  /* ---- learning ---- */
  startLearn(id, kind) {
    this.learnId = id;
    this.learnKind = kind;
    this.cands = [];
    clearTimeout(this.learnTimer);
  }
  cancelLearn() { this.learnId = null; clearTimeout(this.learnTimer); this.cands = []; }

  learnMessage(m) {
    const kind = this.learnKind;
    if (kind === 'btn' && !m.down) return;                        // ignore releases
    if ((kind === 'jog' || kind === 'enc') && m.t !== 'c') return;   // wheels are CC
    if (m.t === 'n' && !m.down) return;
    if (m.val === 0 && m.t === 'c' && (kind === 'jog' || kind === 'enc')) return;
    this.cands.push(m);
    if (kind === 'abs') {
      // collect a moment: a 14-bit fader sends MSB (n) and LSB (n+32)
      if (!this.learnTimer) this.learnTimer = setTimeout(() => this.finishAbs(), 120);
    } else {
      this.bind(m, kind === 'jog' || kind === 'enc' ? { enc: detectEncoding(m.val) } : {});
    }
  }
  finishAbs() {
    this.learnTimer = 0;
    const c = this.cands;
    const first = c[0];
    const pair = c.find((m) => m.t === 'c' && m.ch === first.ch && Math.abs(m.num - first.num) === 32);
    if (pair) {
      const msb = pair.num < first.num ? pair : first;
      this.bind(msb, { lsb: msb.num + 32 });
    } else this.bind(first, {});
  }
  bind(m, extra) {
    const id = this.learnId;
    for (const k of Object.keys(this.map)) if (this.map[k].id === id) delete this.map[k];
    const key = `${m.t}:${m.ch}:${m.num}`;
    this.map[key] = { id, ...extra };
    if (extra.lsb != null) this.map[`c:${m.ch}:${extra.lsb}`] = { id, lsbOf: true };
    this.save();
    this.learnId = null;
    this.cands = [];
    this.onLearned(id, this.describe(m));
  }
  describe(m) {
    const t = m.t === 'n' ? 'Note' : m.t === 'c' ? 'CC' : 'Pitch';
    return `${t} ${m.num} · ch ${m.ch + 1}`;
  }

  /* ---- incoming ---- */
  handle(d) {
    const st = d[0];
    if (st >= 0xF0) return;
    const type = st & 0xF0, ch = st & 0x0F;
    let m;
    if (type === 0x90) m = { t: 'n', ch, num: d[1], val: d[2], down: d[2] > 0 };
    else if (type === 0x80) m = { t: 'n', ch, num: d[1], val: 0, down: false };
    else if (type === 0xB0) m = { t: 'c', ch, num: d[1], val: d[2], down: d[2] > 0 };
    else if (type === 0xE0) m = { t: 'p', ch, num: 0, val: d[1] | (d[2] << 7), down: true };
    else return;
    this.onMessage([...d].map(hex).join(' '));
    if (this.learnId) return this.learnMessage(m);
    this.dispatch(m);
  }

  dispatch(m) {
    const b = this.map[`${m.t}:${m.ch}:${m.num}`];
    if (!b) return;
    const h = C[b.id];
    if (!h) return;
    switch (h.kind) {
      case 'btn': h.press(m.down); break;
      case 'abs': {
        let n;
        if (m.t === 'p') n = m.val / 16383;
        else if (b.lsb != null || b.lsbOf) {
          const s = (this.hi[b.id] = this.hi[b.id] || { msb: 0, lsb: 0 });
          if (b.lsbOf) s.lsb = m.val; else s.msb = m.val;
          n = (s.msb * 128 + s.lsb) / 16383;
        } else n = m.val / 127;
        h.setNorm(clamp(n, 0, 1));
        break;
      }
      case 'jog': h.jog(decodeRelative(m.val, b.enc)); break;
      case 'enc': { const s = Math.sign(decodeRelative(m.val, b.enc)); if (s) h.step(s); break; }
    }
  }
}
