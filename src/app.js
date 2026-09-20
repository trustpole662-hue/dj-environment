'use strict';
/* UI + wiring. Every control registers a handler in C[id]; mouse, keyboard and MIDI all drive the same handlers. */

const C = {};
const $ = (s, r = document) => r.querySelector(s);
const mixer = new Mixer();
const decks = mixer.decks;

/* ---------- settings ---------- */
const SET_KEY = 'djtl.settings.v1';
const settings = Object.assign({ level: 'volume', split: 'auto', jog: 4, tempoInv: false }, (() => {
  try { return JSON.parse(localStorage.getItem(SET_KEY)) || {}; } catch (_) { return {}; }
})());
const saveSettings = () => { try { localStorage.setItem(SET_KEY, JSON.stringify(settings)); } catch (_) { /* blocked */ } };
mixer.splitMode = settings.split;
mixer.jogSens = settings.jog / 1000;
mixer.routeOutputs();

let statusTimer = 0;
function flash(msg) {
  const el = $('#status-msg');
  el.textContent = msg;
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { el.textContent = ''; }, 5000);
}

/* ---------- widgets ---------- */
function knob(id, label, o) {
  const { min = 0, max = 1, val = 0, def = val, bipolar = false, big = false, fmt = () => '', on } = o;
  const el = document.createElement('div');
  el.className = 'knob' + (big ? ' big' : '');
  el.tabIndex = 0;
  el.dataset.ctl = id;
  el.setAttribute('role', 'slider');
  el.setAttribute('aria-label', label);
  el.innerHTML = '<div class="dial"><i></i></div><output></output><span></span>';
  $('span', el).textContent = label;
  const dial = $('.dial', el), out = $('output', el);
  let v = val;
  const draw = () => {
    const n = (v - min) / (max - min), c = bipolar ? 0.5 : 0;
    dial.style.setProperty('--s', Math.min(n, c) * 270 + 'deg');
    dial.style.setProperty('--e', Math.max(n, c) * 270 + 'deg');
    dial.style.setProperty('--a', -135 + n * 270 + 'deg');
    out.textContent = fmt(v);
    el.setAttribute('aria-valuenow', String(Math.round(n * 100)));
  };
  const set = (x, emit = true) => {
    v = clamp(x, min, max);
    if (bipolar && Math.abs(v - (min + max) / 2) < (max - min) * 0.02) v = (min + max) / 2;
    draw();
    if (emit) on(v);
  };
  let lastY = null;
  el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); lastY = e.clientY; });
  el.addEventListener('pointermove', (e) => {
    if (lastY == null) return;
    set(v + ((lastY - e.clientY) / (e.shiftKey ? 700 : 170)) * (max - min));
    lastY = e.clientY;
  });
  const end = () => { lastY = null; };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);
  el.addEventListener('dblclick', () => set(def));
  el.addEventListener('wheel', (e) => { e.preventDefault(); set(v - Math.sign(e.deltaY) * (max - min) * 0.03); }, { passive: false });
  el.addEventListener('keydown', (e) => {
    const k = { ArrowUp: 1, ArrowRight: 1, ArrowDown: -1, ArrowLeft: -1 }[e.key];
    if (k) { e.preventDefault(); set(v + k * (max - min) * 0.03); }
  });
  C[id] = { kind: 'abs', setNorm: (n) => set(min + n * (max - min)) };
  draw();
  return el;
}

function fader(id, label, o) {
  const { min, max, step, val, def = val, fmt = () => '', on } = o;
  const el = document.createElement('label');
  el.className = 'fader v';
  el.innerHTML = '<b></b><input type="range"><span></span>';
  const inp = $('input', el), out = $('b', el);
  Object.assign(inp, { min, max, step, value: val });
  inp.dataset.ctl = id;
  inp.setAttribute('aria-label', label);
  $('span', el).textContent = label;
  const show = () => { out.textContent = fmt(+inp.value); };
  const set = (x, emit = true) => { inp.value = x; show(); if (emit) on(+inp.value); };
  inp.addEventListener('input', () => { show(); on(+inp.value); });
  inp.addEventListener('dblclick', () => set(def));
  C[id] = { kind: 'abs', setNorm: (n) => set(min + n * (max - min)) };
  show();
  return { el, set, input: inp };
}

function button(id, text, cls, onPress) {
  const b = document.createElement('button');
  b.textContent = text;
  b.className = cls;
  b.dataset.ctl = id;
  C[id] = { kind: 'btn', press: onPress, el: b };
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); onPress(true); });
  const up = () => onPress(false);
  b.addEventListener('pointerup', up);
  b.addEventListener('pointerleave', (e) => { if (e.buttons) up(); });
  return b;
}

/* ---------- library ---------- */
const lib = [];
let sel = -1;
const isAudio = (f) => f.type.startsWith('audio/') || isVideoFile(f) || /\.(mp3|wav|m4a|aac|flac|ogg|aif|aiff)$/i.test(f.name);

function renderLib() {
  const ul = $('#lib-list');
  ul.textContent = '';
  lib.forEach((f, i) => {
    const li = document.createElement('li');
    li.textContent = f.name.replace(/\.[^.]+$/, '');
    if (i === sel) li.className = 'sel';
    li.addEventListener('click', () => { sel = i; renderLib(); });
    li.addEventListener('dblclick', () => loadTo(decks[decks[0].playing ? 1 : 0], f));
    ul.appendChild(li);
  });
  $('#lib-count').textContent = `${lib.length} track${lib.length === 1 ? '' : 's'}`;
  $('#lib-empty').hidden = lib.length > 0;
  const s = $('li.sel', ul);
  if (s) s.scrollIntoView({ block: 'nearest' });
}
function addFiles(files) {
  const audio = [...files].filter(isAudio);
  if (!audio.length) return flash('No audio or video files found.');
  audio.forEach((f) => { if (!lib.some((x) => x.name === f.name && x.size === f.size)) lib.push(f); });
  if (sel < 0) sel = 0;
  renderLib();
}
function loadTo(deck, file) {
  if (!file) return;
  flash(`Loading ${file.name}…`);
  deck.load(file).then(() => { if (deck.error) flash(deck.error); else flash(''); });
}
let pickTarget = null;
function loadSelected(deck) {
  if (lib[sel]) return loadTo(deck, lib[sel]);
  pickTarget = deck;
  flash('Library is empty — pick a track to load.');
  $('#file-input').click();
}
$('#file-input').addEventListener('change', (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  addFiles(files);
  if (pickTarget && lib.length) { loadTo(pickTarget, files.find(isAudio)); }
  pickTarget = null;
});
$('#folder-input').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
$('#lib-add').addEventListener('click', () => { pickTarget = null; $('#file-input').click(); });
$('#lib-folder').addEventListener('click', () => $('#folder-input').click());
C.browse = {
  kind: 'enc',
  step(s) { if (!lib.length) return; sel = clamp(sel + s, 0, lib.length - 1); renderLib(); },
};
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

/* ---------- deck UI ---------- */
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const eqDb = (v) => (v < 0 ? v * 40 : v * 6);
const eqFmt = (v) => (v <= -0.99 ? 'KILL' : `${eqDb(v) > 0 ? '+' : ''}${eqDb(v).toFixed(0)} dB`);
const filterFmt = (v) => (v === 0 ? 'OFF' : `${v < 0 ? 'LP' : 'HP'} ${Math.round(Math.abs(v) * 100)}`);
const views = [];

function buildDeck(root, deck, n) {
  root.innerHTML = `
    <div class="d-top"><span class="d-tag">${n.toUpperCase()}</span><span class="d-title empty">Drop a track here or press LOAD</span>
      <span class="d-bpm"></span><button class="bpm-fix ghost" data-k="0.5" title="Halve BPM">½</button><button class="bpm-fix ghost" data-k="2" title="Double BPM">2×</button></div>
    <canvas class="wave" aria-label="Track overview; click to seek"></canvas>
    <div class="d-time">0:00 / 0:00</div>
    <div class="d-mid"><div class="platter-wrap"><canvas class="platter" aria-label="Jog wheel: drag to scratch"></canvas></div><div class="slot-tempo"></div><div class="vu-col slot-vol"></div></div>
    <div class="transport"></div>
    <div class="pads"></div>
    <div class="knob-row"></div>`;
  const q = (s) => $(s, root);
  const title = q('.d-title'), bpmEl = q('.d-bpm'), timeEl = q('.d-time');

  const tempo = fader(`${n}.tempo`, 'TEMPO', {
    min: -16, max: 16, step: 0.05, val: 0, fmt: (v) => `${v <= 0 ? '+' : ''}${(-v).toFixed(1)}%`,
    on: (v) => deck.setTempo(1 - v / 100),
  });
  // Hardware slider direction can be flipped in Settings.
  const rawTempo = C[`${n}.tempo`].setNorm;
  C[`${n}.tempo`].setNorm = (x) => rawTempo(settings.tempoInv ? 1 - x : x);
  q('.slot-tempo').appendChild(tempo.el);

  const vol = fader(`${n}.vol`, 'VOL', { min: 0, max: 1, step: 0.005, val: 0.85, fmt: () => '', on: (v) => deck.setVolume(v) });
  const vu = document.createElement('div');
  vu.className = 'vu';
  vu.innerHTML = '<i></i>';
  q('.slot-vol').append(vol.el, vu);

  const tr = q('.transport');
  const btnPlay = button(`${n}.play`, 'PLAY', 'play', (d) => { if (d) deck.toggle(); });
  const btnCue = button(`${n}.cue`, 'CUE', 'cue', (d) => (d ? deck.cueDown() : deck.cueUp()));
  const btnSync = button(`${n}.sync`, 'SYNC', 'sync', (d) => { if (d) deck.syncTo(decks[1 - decks.indexOf(deck)]); });
  const btnLoad = button(`${n}.load`, 'LOAD', 'load', (d) => { if (d) loadSelected(deck); });
  const btnPfl = button(`${n}.pfl`, 'HP', 'pfl', (d) => { if (d) deck.setPfl(!deck.pfl); });
  tr.append(btnCue, btnPlay, btnSync, btnLoad, btnPfl);
  button(`${n}.touch`, '', '', (d) => deck.touch(d)); // hardware-only: jog wheel touch
  C[`${n}.touch`].kind = 'btn';
  C[`${n}.jog`] = { kind: 'jog', jog: (t) => deck.jog(t) };
  C[`${n}.level`] = { kind: 'abs', setNorm: (x) => C[`${n}.${settings.level === 'filter' ? 'filter' : 'vol'}`].setNorm(x) };

  const pads = q('.pads');
  const padEls = [0, 1, 2, 3].map((i) => {
    const b = button(`${n}.pad${i + 1}`, `CUE ${i + 1}`, '', (d) => { if (d) deck.hot(i); });
    b.addEventListener('contextmenu', (e) => { e.preventDefault(); deck.clearHot(i); });
    b.title = 'Click: set / jump · Right-click: clear';
    pads.appendChild(b);
    return b;
  });

  const kr = q('.knob-row');
  const fk = knob(`${n}.filter`, 'FILTER', { min: -1, max: 1, val: 0, bipolar: true, big: true, fmt: filterFmt, on: (v) => deck.setFilter(v) });
  kr.append(
    fk,
    knob(`${n}.hi`, 'HI', { min: -1, max: 1, val: 0, bipolar: true, fmt: eqFmt, on: (v) => deck.setEq('hi', eqDb(v)) }),
    knob(`${n}.mid`, 'MID', { min: -1, max: 1, val: 0, bipolar: true, fmt: eqFmt, on: (v) => deck.setEq('mid', eqDb(v)) }),
    knob(`${n}.lo`, 'LOW', { min: -1, max: 1, val: 0, bipolar: true, fmt: eqFmt, on: (v) => deck.setEq('lo', eqDb(v)) }),
  );

  /* waveform */
  const wave = q('canvas.wave'), wctx = wave.getContext('2d');
  let cache = null;
  const accent = () => getComputedStyle(root).getPropertyValue('--accent').trim() || '#2fd4ff';
  const buildCache = () => {
    const dpr = devicePixelRatio || 1;
    wave.width = Math.max(1, Math.round(wave.clientWidth * dpr));
    wave.height = Math.max(1, Math.round(wave.clientHeight * dpr));
    cache = document.createElement('canvas');
    cache.width = wave.width; cache.height = wave.height;
    if (!deck.peaks) return;
    const c = cache.getContext('2d'), w = cache.width, h = cache.height;
    c.fillStyle = accent();
    for (let x = 0; x < w; x++) {
      const p = deck.peaks[Math.floor((x / w) * deck.peaks.length)];
      const bh = Math.max(1, p * h * 0.92);
      c.globalAlpha = 0.85;
      c.fillRect(x, (h - bh) / 2, 1, bh);
    }
  };
  new ResizeObserver(buildCache).observe(wave);
  wave.addEventListener('pointerdown', (e) => {
    if (!deck.buffer) return;
    const r = wave.getBoundingClientRect();
    deck.seek(((e.clientX - r.left) / r.width) * deck.duration);
  });

  /* platter: drag to scratch */
  const pl = q('canvas.platter'), pctx = pl.getContext('2d');
  let lastAng = null;
  const ang = (e) => { const r = pl.getBoundingClientRect(); return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)); };
  pl.addEventListener('pointerdown', (e) => { pl.setPointerCapture(e.pointerId); lastAng = ang(e); deck.touch(true); });
  pl.addEventListener('pointermove', (e) => {
    if (lastAng == null) return;
    const a = ang(e);
    let d = a - lastAng;
    if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI;
    lastAng = a;
    deck.jog((d / (2 * Math.PI)) * 400);
  });
  const release = () => { if (lastAng != null) { lastAng = null; deck.touch(false); } };
  pl.addEventListener('pointerup', release);
  pl.addEventListener('pointercancel', release);

  /* events */
  const updateBpm = () => {
    bpmEl.innerHTML = deck.bpm ? `${(deck.bpm * deck.tempo).toFixed(1)} <small>BPM</small>` : '<small>— BPM</small>';
  };
  deck.addEventListener('load', () => {
    title.textContent = deck.loading ? 'Loading…' : deck.name ? deck.name + (deck.isVideo ? ' · video' : '') : 'Drop a track here or press LOAD';
    title.classList.toggle('empty', !deck.name || deck.loading);
    if (!deck.loading) { tempo.set(0, false); deck.setTempo(1); }
    buildCache(); updateBpm();
  });
  deck.addEventListener('tempo', () => { tempo.set(-(deck.tempo - 1) * 100, false); updateBpm(); });
  const refresh = () => {
    btnPlay.classList.toggle('on', deck.playing && !deck.previewing);
    btnPfl.classList.toggle('on', deck.pfl);
    padEls.forEach((b, i) => b.classList.toggle('set', deck.hotcues[i] != null));
  };
  deck.addEventListener('state', refresh);
  deck.addEventListener('pfl', refresh);
  root.querySelectorAll('.bpm-fix').forEach((b) => b.addEventListener('click', () => deck.scaleBpm(+b.dataset.k)));

  /* drop a file straight onto a deck */
  root.addEventListener('dragover', (e) => { e.preventDefault(); root.classList.add('drag'); });
  root.addEventListener('dragleave', () => root.classList.remove('drag'));
  root.addEventListener('drop', (e) => {
    e.preventDefault(); e.stopPropagation(); root.classList.remove('drag');
    const files = [...e.dataTransfer.files].filter(isAudio);
    addFiles(files);
    if (files[0]) loadTo(deck, files[0]);
  });

  let lastTime = '', lastBpm = -1, lastPlatter = null;
  const meterBuf = new Uint8Array(deck.meter.fftSize);
  views.push(() => {
    const pos = deck.getPos();
    // waveform
    if (cache) {
      wctx.clearRect(0, 0, wave.width, wave.height);
      wctx.drawImage(cache, 0, 0);
      if (deck.duration) {
        const w = wave.width, h = wave.height;
        wctx.fillStyle = '#ffb94a';
        wctx.fillRect(Math.round((deck.cuePoint / deck.duration) * w), 0, 2, h);
        deck.hotcues.forEach((t) => { if (t != null) { wctx.fillStyle = '#4be38a'; wctx.fillRect(Math.round((t / deck.duration) * w), 0, 2, h); } });
        wctx.fillStyle = '#fff';
        wctx.fillRect(Math.round((pos / deck.duration) * w) - 1, 0, 2, h);
      }
    }
    const t = `${fmtTime(pos)} / ${fmtTime(deck.duration)}`;
    if (t !== lastTime) { timeEl.textContent = t; lastTime = t; }
    // platter
    const a = pos * (100 / 60) * Math.PI; // 33 1/3 rpm
    if (a !== lastPlatter) { drawPlatter(pctx, pl, a, accent()); lastPlatter = a; }
    // meter
    deck.meter.getByteTimeDomainData(meterBuf);
    let peak = 0;
    for (let i = 0; i < meterBuf.length; i++) peak = Math.max(peak, Math.abs(meterBuf[i] - 128));
    vu.firstChild.style.height = Math.min(100, (peak / 128) * 110) + '%';
  });
  updateBpm();
  refresh();
}

function drawPlatter(c, cv, angle, color) {
  const dpr = devicePixelRatio || 1;
  const size = Math.round(cv.clientWidth * dpr);
  if (size < 8) return;
  if (cv.width !== size) { cv.width = size; cv.height = size; }
  const r = size / 2;
  c.clearRect(0, 0, size, size);
  c.save();
  c.translate(r, r);
  c.rotate(angle);
  c.fillStyle = '#12141b'; c.beginPath(); c.arc(0, 0, r - 2, 0, 7); c.fill();
  c.strokeStyle = '#242835'; c.lineWidth = 1;
  for (let k = 0.5; k < 0.95; k += 0.09) { c.beginPath(); c.arc(0, 0, r * k, 0, 7); c.stroke(); }
  c.fillStyle = color; c.beginPath(); c.arc(0, 0, r * 0.27, 0, 7); c.fill();
  c.fillStyle = '#0d0e12'; c.beginPath(); c.arc(0, 0, r * 0.04, 0, 7); c.fill();
  c.fillStyle = '#fff'; c.fillRect(-2 * dpr, -r * 0.92, 4 * dpr, r * 0.3);
  c.restore();
  c.strokeStyle = '#2f3442'; c.lineWidth = 2 * dpr; c.beginPath(); c.arc(r, r, r - 2, 0, 7); c.stroke();
}

buildDeck($('#deck-a'), decks[0], 'a');
buildDeck($('#deck-b'), decks[1], 'b');

/* ---------- mixer ---------- */
$('#mix-knobs').append(
  knob('master', 'MASTER', { val: 0.8, def: 0.8, big: true, fmt: (v) => `${Math.round(v * 100)}`, on: (v) => mixer.setMaster(v) }),
  knob('cuelevel', 'HEADPHONES', { val: 0.8, def: 0.8, fmt: (v) => `${Math.round(v * 100)}`, on: (v) => mixer.setCueLevel(v) }),
);
mixer.setMaster(0.8);
mixer.setCueLevel(0.8);
const xf = $('#xfader');
C.xfader = { kind: 'abs', setNorm: (n) => { xf.value = n * 2 - 1; mixer.setCrossfader(+xf.value); } };
xf.addEventListener('input', () => mixer.setCrossfader(+xf.value));
xf.addEventListener('dblclick', () => { xf.value = 0; mixer.setCrossfader(0); });
const stage = new VideoStage(decks, mixer);
views.push(() => stage.tick());
const mvu = $('#master-vu i'), mbuf = new Uint8Array(mixer.analyser.fftSize);
views.push(() => {
  mixer.analyser.getByteTimeDomainData(mbuf);
  let p = 0;
  for (let i = 0; i < mbuf.length; i++) p = Math.max(p, Math.abs(mbuf[i] - 128));
  mvu.style.width = Math.min(100, (p / 128) * 105) + '%';
});

function updateOutInfo() {
  const el = $('#out-info');
  el.textContent = mixer.splitActive
    ? `Output: ${mixer.outputChannels} ch · headphone cue on outputs 3-4`
    : `Output: ${mixer.outputChannels} ch · headphone cue needs a 4-channel output (choose the DJ2GO2 Touch in macOS Sound)`;
}
updateOutInfo();
if (navigator.mediaDevices) {
  navigator.mediaDevices.addEventListener('devicechange', () => setTimeout(() => { mixer.routeOutputs(); updateOutInfo(); }, 600));
}

(function frame() {
  views.forEach((v) => v());
  requestAnimationFrame(frame);
})();

/* ---------- keyboard ---------- */
const keyMap = {
  q: [0, 'play'], p: [1, 'play'], a: [0, 'cue'], l: [1, 'cue'], z: [0, 'sync'], m: [1, 'sync'],
};
window.addEventListener('keydown', (e) => {
  if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || document.querySelector('dialog[open]')) return;
  if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName) && e.target.type !== 'range') return;
  const k = e.key.toLowerCase();
  if (keyMap[k]) { C[`${'ab'[keyMap[k][0]]}.${keyMap[k][1]}`].press(true); return; }
  if (k === 'v') { stage.show(stage.root.hidden); return; }
  if (k === ',' || k === '.') {
    xf.value = clamp(+xf.value + (k === ',' ? -0.1 : 0.1), -1, 1);
    mixer.setCrossfader(+xf.value);
  }
});
window.addEventListener('keyup', (e) => {
  const k = keyMap[e.key.toLowerCase()];
  if (k && k[1] === 'cue') C[`${'ab'[k[0]]}.cue`].press(false);
});

/* ---------- controller mapping & learn ---------- */
const LEARN_KIND_HINT = {
  btn: 'Press it once on your controller.',
  abs: 'Move it through part of its range.',
  jog: 'Turn it slowly clockwise.',
  enc: 'Turn it slowly clockwise.',
};
const STEPS = [];
[['a', 'Deck A'], ['b', 'Deck B']].forEach(([n, d]) => {
  STEPS.push(
    [`${n}.play`, `${d}: PLAY / PAUSE`], [`${n}.cue`, `${d}: CUE`], [`${n}.sync`, `${d}: SYNC`],
    [`${n}.load`, `${d}: LOAD`], [`${n}.pfl`, `${d}: HEADPHONES (cue) button`],
    [`${n}.touch`, `${d}: touch the top of the JOG WHEEL`, 'Rest a finger on the wheel top without turning it.'],
    [`${n}.jog`, `${d}: JOG WHEEL`], [`${n}.tempo`, `${d}: TEMPO slider`],
    [`${n}.level`, `${d}: LEVEL knob`],
    [`${n}.pad1`, `${d}: pad 1`], [`${n}.pad2`, `${d}: pad 2`], [`${n}.pad3`, `${d}: pad 3`], [`${n}.pad4`, `${d}: pad 4`],
  );
});
STEPS.push(['xfader', 'CROSSFADER'], ['master', 'MASTER level'], ['cuelevel', 'HEADPHONES level (cue)'], ['browse', 'BROWSE knob']);

const wiz = { i: -1 };
const ctrl = new Controller({
  onStatus(state, text, justConnected) {
    $('#midi-pill').className = `pill ${state}`;
    $('#midi-text').textContent = text;
    if (state === 'ready' && justConnected && !ctrl.mapped && !sessionStorage.getItem('djtl.asked')) {
      try { sessionStorage.setItem('djtl.asked', '1'); } catch (_) { /* ignore */ }
      $('#dlg-first').showModal();
    }
  },
  onMessage(hexStr) { $('#msg-monitor').textContent = `MIDI: ${hexStr}`; },
  onLearned(id, desc) {
    document.querySelectorAll('.learn-target').forEach((el) => el.classList.remove('learn-target'));
    markBound();
    if (wiz.i >= 0) {
      $('#w-hint').textContent = `✓ ${desc}`;
      $('#w-hint').className = 'w-hint ok';
      const at = wiz.i;
      setTimeout(() => { if (wiz.i === at) nextStep(); }, 650);
    } else flash(`${id} → ${desc}`);
  },
});

function markBound() {
  document.querySelectorAll('[data-ctl]').forEach((el) => el.classList.toggle('bound', ctrl.isBound(el.dataset.ctl)));
}
function showStep() {
  const [id, title, hint] = STEPS[wiz.i];
  const kind = C[id].kind;
  ctrl.startLearn(id, kind);
  $('#w-step').textContent = `STEP ${wiz.i + 1} OF ${STEPS.length}`;
  $('#w-title').textContent = title;
  $('#w-hint').textContent = hint || LEARN_KIND_HINT[kind];
  $('#w-hint').className = 'w-hint';
  document.querySelectorAll('.learn-target').forEach((el) => el.classList.remove('learn-target'));
  document.querySelectorAll(`[data-ctl="${id}"]`).forEach((el) => el.classList.add('learn-target'));
}
function nextStep() {
  if (wiz.i < 0) return;
  if (++wiz.i >= STEPS.length) return stopWizard('Controller mapping saved.');
  showStep();
}
function stopWizard(msg) {
  wiz.i = -1;
  ctrl.cancelLearn();
  $('#wizard').hidden = true;
  document.querySelectorAll('.learn-target').forEach((el) => el.classList.remove('learn-target'));
  markBound();
  if (msg) flash(msg);
}
function startWizard() {
  setLearnMode(false);
  wiz.i = 0;
  $('#wizard').hidden = false;
  showStep();
}
$('#btn-map').addEventListener('click', startWizard);
$('#first-map').addEventListener('click', () => setTimeout(startWizard, 0));
$('#w-skip').addEventListener('click', () => { ctrl.cancelLearn(); nextStep(); });
$('#w-stop').addEventListener('click', () => stopWizard('Mapping stopped — what you learned is saved.'));

let learning = false;
function setLearnMode(on) {
  learning = on;
  document.body.classList.toggle('learning', on);
  $('#btn-learn').classList.toggle('on', on);
  if (on) { stopWizard(); flash('MIDI Learn: click a control, then move it on your hardware. Click MIDI Learn again to finish.'); markBound(); }
  else { ctrl.cancelLearn(); document.querySelectorAll('.learn-target').forEach((el) => el.classList.remove('learn-target')); }
}
$('#btn-learn').addEventListener('click', () => setLearnMode(!learning));
['pointerdown', 'mousedown', 'click'].forEach((type) => {
  document.addEventListener(type, (e) => {
    if (!learning) return;
    const el = e.target.closest && e.target.closest('[data-ctl]');
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    if (type !== 'pointerdown') return;
    const id = el.dataset.ctl;
    if (!C[id]) return;
    document.querySelectorAll('.learn-target').forEach((x) => x.classList.remove('learn-target'));
    el.classList.add('learn-target');
    ctrl.startLearn(id, C[id].kind);
    flash(`Now move the hardware control for “${id}”…`);
  }, true);
});

/* ---------- settings dialog ---------- */
const dlg = $('#dlg-settings');
$('#btn-settings').addEventListener('click', () => {
  $('#set-level').value = settings.level;
  $('#set-split').value = settings.split;
  $('#set-jog').value = settings.jog;
  $('#set-tempo-inv').checked = settings.tempoInv;
  dlg.showModal();
});
$('#set-level').addEventListener('change', (e) => { settings.level = e.target.value; saveSettings(); });
$('#set-split').addEventListener('change', (e) => {
  settings.split = e.target.value; saveSettings();
  mixer.splitMode = settings.split; mixer.routeOutputs(); updateOutInfo();
});
$('#set-jog').addEventListener('input', (e) => { settings.jog = +e.target.value; mixer.jogSens = settings.jog / 1000; saveSettings(); });
$('#set-tempo-inv').addEventListener('change', (e) => { settings.tempoInv = e.target.checked; saveSettings(); });
$('#set-reset').addEventListener('click', () => { ctrl.clearMap(); markBound(); flash('Controller mapping cleared.'); });

renderLib();
ctrl.start();
