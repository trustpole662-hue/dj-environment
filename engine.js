'use strict';
/* Audio engine: two decks -> filter/EQ -> volume -> crossfader -> master. Web Audio only, no dependencies. */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ---------- BPM detection: low-passed energy envelope -> onset -> autocorrelation ---------- */
function detectBpm(buf) {
  const sr = buf.sampleRate;
  const ch = buf.getChannelData(0);
  const win = 90 * sr;
  const start = Math.floor(Math.max(0, (ch.length - win) / 2));
  const end = Math.min(ch.length, start + win);
  const rate = 200; // envelope samples per second
  const hop = Math.floor(sr / rate);
  const n = Math.floor((end - start) / hop);
  if (n < rate * 8) return 0;

  const a = Math.exp((-2 * Math.PI * 150) / sr);
  let lp = 0;
  const env = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let e = 0;
    const o = start + i * hop;
    for (let j = 0; j < hop; j++) {
      lp = a * lp + (1 - a) * ch[o + j];
      e += lp * lp;
    }
    env[i] = Math.sqrt(e / hop);
  }
  const onset = new Float32Array(n);
  for (let i = 1; i < n; i++) onset[i] = Math.max(0, env[i] - env[i - 1]);

  const minLag = Math.floor((rate * 60) / 200);
  const maxLag = Math.ceil((rate * 60) / 60);
  const ac = new Float32Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += onset[i] * onset[i - lag];
    ac[lag] = s / (n - lag);
  }
  let best = minLag;
  for (let lag = minLag; lag <= maxLag; lag++) if (ac[lag] > ac[best]) best = lag;
  const y0 = ac[best - 1], y1 = ac[best], y2 = ac[best + 1];
  const denom = y0 - 2 * y1 + y2;
  const lagF = best + (denom !== 0 ? (0.5 * (y0 - y2)) / denom : 0);

  let bpm = (rate * 60) / lagF;
  while (bpm < 78) bpm *= 2;
  while (bpm > 160) bpm /= 2;
  return Math.round(bpm * 10) / 10;
}

function makePeaks(buf, columns) {
  const ch0 = buf.getChannelData(0);
  const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : ch0;
  const per = Math.floor(ch0.length / columns);
  const step = Math.max(1, Math.floor(per / 48));
  const peaks = new Float32Array(columns);
  for (let c = 0; c < columns; c++) {
    let m = 0;
    for (let i = c * per; i < (c + 1) * per; i += step) {
      const v = Math.max(Math.abs(ch0[i]), Math.abs(ch1[i]));
      if (v > m) m = v;
    }
    peaks[c] = m;
  }
  return peaks;
}

/* ---------- video helpers ---------- */
const isVideoFile = (f) => f.type.startsWith('video/') || /\.(mp4|m4v|mov|webm)$/i.test(f.name);

function silentBufferFor(ctx, file) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    const url = URL.createObjectURL(file);
    const done = (fn, arg) => { URL.revokeObjectURL(url); v.removeAttribute('src'); fn(arg); };
    v.preload = 'metadata';
    const finish = () => {
      const d = v.duration;
      if (Number.isFinite(d) && d > 0) done(resolve, ctx.createBuffer(1, Math.ceil(d * 8000), 8000));
      else done(reject, new Error('no duration'));
    };
    v.onloadedmetadata = () => {
      if (v.duration === Infinity) { // streamed/recorded files without a header duration: seek to the end to learn it
        v.ontimeupdate = () => { v.ontimeupdate = null; finish(); };
        v.currentTime = 1e101;
      } else finish();
    };
    v.onerror = () => done(reject, new Error('unreadable video'));
    v.src = url;
  });
}

/* ---------- Deck ---------- */
const FILTER_Q = 0.9;

class Deck extends EventTarget {
  constructor(mixer, id) {
    super();
    const ctx = mixer.ctx;
    this.m = mixer;
    this.id = id;
    this.ctx = ctx;

    this.input = ctx.createGain();
    this.lo = ctx.createBiquadFilter();
    this.mid = ctx.createBiquadFilter();
    this.hi = ctx.createBiquadFilter();
    this.hp = ctx.createBiquadFilter();
    this.lp = ctx.createBiquadFilter();
    this.vol = ctx.createGain();
    this.xf = ctx.createGain();
    this.cueTap = ctx.createGain();
    this.meter = ctx.createAnalyser();
    this.meter.fftSize = 256;

    this.lo.type = 'lowshelf'; this.lo.frequency.value = 250;
    this.mid.type = 'peaking'; this.mid.frequency.value = 1200; this.mid.Q.value = 0.7;
    this.hi.type = 'highshelf'; this.hi.frequency.value = 4000;
    this.hp.type = 'highpass'; this.hp.Q.value = FILTER_Q;
    this.lp.type = 'lowpass'; this.lp.Q.value = FILTER_Q;
    this.cueTap.gain.value = 0;

    this.input.connect(this.lo).connect(this.mid).connect(this.hi).connect(this.hp).connect(this.lp);
    this.lp.connect(this.vol).connect(this.xf).connect(mixer.master);
    this.vol.connect(this.meter);
    this.lp.connect(this.cueTap).connect(mixer.cueBus);

    this.setFilter(0);
    this.setVolume(0.85);

    this.buffer = null;
    this.file = null;
    this.isVideo = false;
    this.name = '';
    this.peaks = null;
    this.bpm = 0;
    this.loading = false;
    this.playing = false;
    this.previewing = false;
    this.touching = false;
    this.offset = 0;
    this.startedAt = 0;
    this.tempo = 1;
    this.bend = 0;
    this.rate = 1;
    this.cuePoint = 0;
    this.hotcues = [null, null, null, null];
    this.src = null;
    this.pfl = false;
    this._lastJog = 0;
    this._bendTimer = 0;
  }

  emit(type) { this.dispatchEvent(new Event(type)); }
  get duration() { return this.buffer ? this.buffer.duration : 0; }
  get effectiveBpm() { return this.bpm * this.tempo; }

  getPos() {
    if (!this.buffer) return 0;
    if (!this.playing) return this.offset;
    return clamp(this.offset + (this.ctx.currentTime - this.startedAt) * this.rate, 0, this.duration);
  }

  /* --- mixer knobs --- */
  setVolume(v) { this.volume = v; this.vol.gain.setTargetAtTime(v * v * 1.2, this.ctx.currentTime, 0.01); }
  setEq(band, db) { this[band].gain.setTargetAtTime(db, this.ctx.currentTime, 0.01); }
  /* Bipolar filter: -1 = low-pass closing, 0 = off, +1 = high-pass closing. */
  setFilter(f) {
    f = Math.abs(f) < 0.03 ? 0 : f;
    this.filter = f;
    const t = this.ctx.currentTime;
    this.lp.frequency.setTargetAtTime(f < 0 ? 22000 * Math.pow(0.008, -f) : 22000, t, 0.015);
    this.hp.frequency.setTargetAtTime(f > 0 ? 20 * Math.pow(300, f) : 20, t, 0.015);
  }
  setPfl(on) { this.pfl = on; this.cueTap.gain.setTargetAtTime(on ? 1 : 0, this.ctx.currentTime, 0.01); this.emit('pfl'); }

  /* --- transport --- */
  _startSource() {
    const src = this.ctx.createBufferSource();
    src.buffer = this.buffer;
    src.playbackRate.value = this.rate;
    src.connect(this.input);
    this.src = src;
    this.startedAt = this.ctx.currentTime;
    src.onended = () => {
      if (this.src !== src) return;
      this.src = null;
      this.playing = false;
      this.offset = this.duration;
      this.emit('state');
    };
    src.start(0, this.offset);
  }
  _killSource() {
    const src = this.src;
    this.src = null;
    if (src) { try { src.stop(); } catch (_) { /* already stopped */ } src.disconnect(); }
  }

  play() {
    if (!this.buffer || this.playing) return;
    if (this.offset >= this.duration - 0.05) this.offset = 0;
    this.previewing = false;
    this._startSource();
    this.playing = true;
    this.emit('state');
  }
  pause() {
    if (!this.playing) return;
    this.offset = this.getPos();
    this._killSource();
    this.playing = false;
    this.emit('state');
  }
  toggle() { this.playing ? this.pause() : this.play(); }

  seek(t) {
    if (!this.buffer) return;
    const was = this.playing;
    if (was) { this._killSource(); }
    this.offset = clamp(t, 0, this.duration);
    if (was) this._startSource();
    this.emit('state');
  }

  /* CDJ-style cue: playing -> return to cue & stop; stopped on cue -> preview while held; else set cue here. */
  cueDown() {
    if (!this.buffer) return;
    if (this.playing) { this.pause(); this.offset = this.cuePoint; }
    else if (Math.abs(this.offset - this.cuePoint) < 0.02) { this.previewing = true; this._startSource(); this.playing = true; }
    else this.cuePoint = this.offset;
    this.emit('state');
  }
  cueUp() {
    if (!this.previewing) return;
    this.previewing = false;
    this.pause();
    this.offset = this.cuePoint;
    this.emit('state');
  }

  hot(i) {
    if (!this.buffer) return;
    if (this.hotcues[i] == null) { this.hotcues[i] = this.getPos(); this.emit('state'); return; }
    this.seek(this.hotcues[i]);
    this.play();
  }
  clearHot(i) { this.hotcues[i] = null; this.emit('state'); }

  /* --- tempo --- */
  applyRate() {
    const r = this.tempo * (1 + this.bend);
    if (this.playing) { this.offset = this.getPos(); this.startedAt = this.ctx.currentTime; }
    this.rate = r;
    if (this.src) this.src.playbackRate.value = r;
  }
  setTempo(t) { this.tempo = clamp(t, 0.84, 1.16); this.applyRate(); this.emit('tempo'); }
  syncTo(other) {
    if (!this.bpm || !other.bpm) return;
    this.setTempo((other.bpm * other.tempo) / this.bpm);
  }
  scaleBpm(k) { if (this.bpm) { this.bpm = clamp(this.bpm * k, 40, 240); this.emit('tempo'); } }

  /* --- jog wheel: scratch while touched, pitch-bend while playing, nudge while stopped --- */
  touch(on) {
    if (on === this.touching) return;
    this.touching = on;
    if (on) {
      this._wasPlaying = this.playing;
      this._lastJog = this.ctx.currentTime;
      if (this.playing) this.pause();
    } else if (this._wasPlaying) {
      this.play();
    }
  }
  jog(ticks) {
    if (!this.buffer || !ticks) return;
    if (this.touching) return this._scrub(ticks);
    if (this.playing) {
      this.bend = clamp(this.bend + ticks * 0.01, -0.3, 0.3);
      this.applyRate();
      if (!this._bendTimer) this._bendTimer = setInterval(() => this._decayBend(), 30);
    } else {
      this.offset = clamp(this.offset + ticks * 0.01, 0, this.duration);
      this.emit('state');
    }
  }
  _decayBend() {
    this.bend *= 0.6;
    if (Math.abs(this.bend) < 0.003) { this.bend = 0; clearInterval(this._bendTimer); this._bendTimer = 0; }
    this.applyRate();
  }
  _scrub(ticks) {
    const buf = this.buffer;
    const now = this.ctx.currentTime;
    const dt = clamp(now - this._lastJog, 0.004, 0.06);
    this._lastJog = now;
    const move = ticks * this.m.jogSens;
    const from = this.offset;
    const to = clamp(from + move, 0, this.duration);
    this.offset = to;
    const sr = buf.sampleRate;
    const i0 = Math.floor(Math.min(from, to) * sr);
    const i1 = Math.floor(Math.max(from, to) * sr);
    const n = i1 - i0;
    if (n < 8) return;
    const grain = this.ctx.createBuffer(buf.numberOfChannels, n, sr);
    const fade = Math.min(48, n >> 2);
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const s = buf.getChannelData(c), d = grain.getChannelData(c);
      if (to >= from) d.set(s.subarray(i0, i1)); else for (let j = 0; j < n; j++) d[j] = s[i1 - 1 - j];
      for (let j = 0; j < fade; j++) { const k = j / fade; d[j] *= k; d[n - 1 - j] *= k; }
    }
    const g = this.ctx.createBufferSource();
    g.buffer = grain;
    g.playbackRate.value = clamp(Math.abs(to - from) / dt, 0.05, 8);
    g.connect(this.input);
    g.start();
  }

  /* --- loading --- */
  async load(file) {
    this.loading = true;
    this.emit('load');
    try {
      const isVideo = isVideoFile(file);
      let buf, silent = false;
      try {
        buf = await this.ctx.decodeAudioData(await file.arrayBuffer());
      } catch (e) {
        if (!isVideo) throw e;
        buf = await silentBufferFor(this.ctx, file); // video with no usable audio track: play it silently
        silent = true;
      }
      this._killSource();
      this.playing = false;
      this.previewing = false;
      this.buffer = buf;
      this.file = file;
      this.isVideo = isVideo;
      this.name = file.name.replace(/\.[^.]+$/, '');
      this.offset = 0;
      this.cuePoint = 0;
      this.hotcues = [null, null, null, null];
      this.peaks = makePeaks(buf, 1400);
      this.bpm = silent ? 0 : detectBpm(buf);
      this.error = '';
    } catch (e) {
      this.error = `Could not read "${file.name}" (unsupported format?)`;
    }
    this.loading = false;
    this.emit('load');
    this.emit('state');
  }
}

/* ---------- Mixer ---------- */
class Mixer {
  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    const ctx = this.ctx;
    this.jogSens = 0.004;
    this.splitMode = 'auto';
    this.master = ctx.createGain();
    this.master.gain.value = 0.8;
    this.cueBus = ctx.createGain();
    this.cueBus.gain.value = 0.8;
    this.limiter = ctx.createDynamicsCompressor(); // safety limiter
    this.limiter.threshold.value = -2; this.limiter.knee.value = 0; this.limiter.ratio.value = 20;
    this.limiter.attack.value = 0.003; this.limiter.release.value = 0.1;
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this.master.connect(this.limiter).connect(this.analyser);
    this.decks = [new Deck(this, 'a'), new Deck(this, 'b')];
    this._extra = [];
    this.setCrossfader(0);
    this.routeOutputs();
  }

  setMaster(v) { this.master.gain.setTargetAtTime(v * v * 1.25, this.ctx.currentTime, 0.01); }
  setCueLevel(v) { this.cueBus.gain.setTargetAtTime(v * v * 1.25, this.ctx.currentTime, 0.01); }
  /* x in -1..1. Both decks are full at centre and the far side fades out. */
  setCrossfader(x) {
    this.xfader = x;
    const t = this.ctx.currentTime;
    this.decks[0].xf.gain.setTargetAtTime(x <= 0 ? 1 : Math.cos(x * Math.PI / 2), t, 0.008);
    this.decks[1].xf.gain.setTargetAtTime(x >= 0 ? 1 : Math.cos(-x * Math.PI / 2), t, 0.008);
  }

  /* The DJ2GO2 Touch exposes 4 outputs: 1-2 master, 3-4 headphones. Split cue onto 3-4 when that is what we see. */
  routeOutputs() {
    const ctx = this.ctx, dest = ctx.destination;
    try { this.analyser.disconnect(); this.cueBus.disconnect(); } catch (_) { /* first run */ }
    this._extra.forEach((n) => { try { n.disconnect(); } catch (_) { /* ignore */ } });
    this._extra = [];
    const max = dest.maxChannelCount || 2;
    const split = this.splitMode === 'on' || (this.splitMode === 'auto' && max === 4);
    this.splitActive = split && max >= 4;
    if (this.splitActive) {
      dest.channelCount = 4;
      dest.channelCountMode = 'explicit';
      dest.channelInterpretation = 'discrete';
      const merger = ctx.createChannelMerger(4);
      const sm = ctx.createChannelSplitter(2), sc = ctx.createChannelSplitter(2);
      this.analyser.connect(sm); this.cueBus.connect(sc);
      sm.connect(merger, 0, 0); sm.connect(merger, 1, 1);
      sc.connect(merger, 0, 2); sc.connect(merger, 1, 3);
      merger.connect(dest);
      this._extra = [sm, sc, merger];
    } else {
      dest.channelCount = Math.min(2, max);
      dest.channelCountMode = 'explicit';
      dest.channelInterpretation = 'speakers';
      this.analyser.connect(dest);
    }
    this.outputChannels = max;
  }
}
