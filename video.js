'use strict';
/* Video overlay: each deck's video (if the loaded file is one) is slaved to that deck's audio clock.
 * The overlay crossfades between the two videos with the crossfader. Audio always comes from the deck. */

class VideoStage {
  constructor(decks, mixer) {
    this.decks = decks;
    this.mixer = mixer;
    this.root = document.getElementById('vstage');
    this.els = [document.getElementById('vid-a'), document.getElementById('vid-b')];
    this.hint = this.root.querySelector('.v-empty');
    this.files = [null, null];
    this.urls = [null, null];
    this.has = [false, false];
    this.lastSeek = [0, 0];
    this.btn = document.getElementById('btn-video');

    this.els.forEach((el) => { el.muted = true; el.playsInline = true; el.preload = 'auto'; });
    decks.forEach((d, i) => d.addEventListener('load', () => this.onLoad(i)));

    this.btn.addEventListener('click', () => this.show(this.root.hidden));
    document.getElementById('v-close').addEventListener('click', () => this.show(false));
    document.getElementById('v-full').addEventListener('click', () => this.fullscreen());
    this.root.querySelector('.v-screen').addEventListener('dblclick', () => this.fullscreen());
    this.enableDrag();
  }

  show(on) {
    this.root.hidden = !on;
    this.btn.classList.toggle('on', on);
    if (!on) this.els.forEach((el) => el.pause());
  }

  fullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else if (this.root.requestFullscreen) this.root.requestFullscreen();
  }

  onLoad(i) {
    const d = this.decks[i];
    if (d.loading || d.file === this.files[i]) return; // still loading, or a failed load left the old file in place
    const el = this.els[i];
    this.files[i] = d.file;
    if (this.urls[i]) { URL.revokeObjectURL(this.urls[i]); this.urls[i] = null; el.removeAttribute('src'); el.load(); }
    this.has[i] = !!(d.file && d.isVideo);
    if (this.has[i]) {
      this.urls[i] = URL.createObjectURL(d.file);
      el.src = this.urls[i];
      el.load();
      this.show(true);
    }
    this.hint.hidden = this.has[0] || this.has[1];
  }

  /* Called every animation frame. */
  tick() {
    if (this.root.hidden) return;
    const [a, b] = this.has;
    const x = this.mixer.xfader;
    this.els[0].style.opacity = a ? 1 : 0;
    this.els[1].style.opacity = b ? (a ? (x + 1) / 2 : 1) : 0;

    const now = performance.now();
    this.decks.forEach((d, i) => {
      if (!this.has[i]) return;
      const v = this.els[i];
      const pos = d.getPos();
      if (d.playing && !d.touching) {
        const rate = clamp(d.rate, 0.0625, 16);
        if (v.playbackRate !== rate) v.playbackRate = rate;
        if (Math.abs(v.currentTime - pos) > 0.3 && now - this.lastSeek[i] > 250) { v.currentTime = pos; this.lastSeek[i] = now; }
        if (v.paused) v.play().catch(() => { /* not ready yet; retried next frame */ });
      } else {
        if (!v.paused) v.pause();
        if (Math.abs(v.currentTime - pos) > 0.03 && now - this.lastSeek[i] > 40) { v.currentTime = pos; this.lastSeek[i] = now; }
      }
    });
  }

  enableDrag() {
    const bar = this.root.querySelector('.v-bar');
    let start = null;
    bar.addEventListener('pointerdown', (e) => {
      if (e.target.closest('button') || document.fullscreenElement) return;
      const r = this.root.getBoundingClientRect();
      start = { dx: e.clientX - r.left, dy: e.clientY - r.top };
      bar.setPointerCapture(e.pointerId);
    });
    bar.addEventListener('pointermove', (e) => {
      if (!start) return;
      const r = this.root.getBoundingClientRect();
      const left = clamp(e.clientX - start.dx, 0, innerWidth - r.width);
      const top = clamp(e.clientY - start.dy, 0, innerHeight - 40);
      Object.assign(this.root.style, { left: left + 'px', top: top + 'px', right: 'auto' });
    });
    const end = () => { start = null; };
    bar.addEventListener('pointerup', end);
    bar.addEventListener('pointercancel', end);
  }
}
