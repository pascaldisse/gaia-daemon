/**
 * client/kernel/music.js — procedural mood music (Web Audio, zero assets).
 *
 * A generative ambient engine: a detuned drone pair through a slow-breathing
 * lowpass, a filtered-noise air bed, and sparse plucked motifs on a modal
 * scale — all parameterized per MOOD, with equal-power crossfades between
 * moods. No files, works offline, ships in the repo.
 *
 * Mood resolution (weakest → strongest):
 *   location style (settlement=calm, wilds=eerie, dungeon=tense, …)
 *   → night makes everything one shade darker
 *   → active encounter = combat
 *   → the DM's mood knob (world-state.flags.mood) overrides everything.
 *
 * Autoplay policy: browsers demand a gesture — the 🔊 header toggle starts the
 * AudioContext; preference persists in localStorage.
 */

const MOODS = {
  calm:   { root: 110.00, scale: [0, 3, 5, 7, 10], droneGain: 0.05, airGain: 0.012, motifGain: 0.05, motifEvery: [4, 9],  filter: 900,  detune: 3 },
  eerie:  { root: 92.50,  scale: [0, 1, 5, 6, 10], droneGain: 0.05, airGain: 0.02,  motifGain: 0.04, motifEvery: [6, 14], filter: 600,  detune: 7 },
  tense:  { root: 82.41,  scale: [0, 1, 4, 6, 7],  droneGain: 0.06, airGain: 0.025, motifGain: 0.035, motifEvery: [3, 7], filter: 500,  detune: 11 },
  combat: { root: 73.42,  scale: [0, 2, 3, 7, 8],  droneGain: 0.075, airGain: 0.03, motifGain: 0.06, motifEvery: [1.2, 3], filter: 1400, detune: 14 },
  somber: { root: 98.00,  scale: [0, 3, 7, 8, 10], droneGain: 0.045, airGain: 0.015, motifGain: 0.045, motifEvery: [5, 11], filter: 700, detune: 5 },
};

const DARKER = { calm: 'eerie', eerie: 'eerie', tense: 'tense', combat: 'combat', somber: 'somber' };
const STYLE_MOOD = { settlement: 'calm', entrance: 'calm', interior: 'calm', wilds: 'eerie', landmark: 'eerie', dungeon: 'tense', lair: 'tense', location: 'eerie' };

export class MusicEngine {
  constructor() {
    this.ctx = null;
    this.layers = null;      // active mood layer {mood, nodes, gain}
    this.enabled = false;
    this.mood = 'calm';
    this._motifTimer = null;
    try { this.enabled = localStorage.getItem('ttrpg_music') === 'on'; } catch { /* ok */ }
  }

  /** Resolve the mood from world state. DM knob > combat > style × phase. */
  resolveMood({ locStyle, phase, inCombat, dmMood }) {
    if (dmMood && MOODS[dmMood]) return dmMood;
    if (inCombat) return 'combat';
    let mood = STYLE_MOOD[locStyle] || 'eerie';
    if (phase === 'night') mood = DARKER[mood];
    return mood;
  }

  /** User gesture entry: toggle on/off. Returns the new state. */
  toggle() {
    this.enabled = !this.enabled;
    try { localStorage.setItem('ttrpg_music', this.enabled ? 'on' : 'off'); } catch { /* ok */ }
    if (this.enabled) this._start();
    else this._stop();
    return this.enabled;
  }

  /** Move to a mood (crossfade ~3s). Safe to call any time. */
  setMood(mood) {
    if (!MOODS[mood]) mood = 'calm';
    this.mood = mood;
    if (!this.enabled || !this.ctx) return;
    if (this.layers && this.layers.mood === mood) return;
    const old = this.layers;
    this.layers = this._buildLayer(mood);
    const t = this.ctx.currentTime;
    this.layers.gain.gain.setValueAtTime(0.0001, t);
    this.layers.gain.gain.exponentialRampToValueAtTime(1, t + 3);
    if (old) {
      old.gain.gain.setValueAtTime(1, t);
      old.gain.gain.exponentialRampToValueAtTime(0.0001, t + 3);
      setTimeout(() => this._teardown(old), 3400);
    }
  }

  _start() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { this.enabled = false; return; }
      this.ctx = new AC();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    if (!this.layers) {
      this.layers = this._buildLayer(this.mood);
      const t = this.ctx.currentTime;
      this.layers.gain.gain.setValueAtTime(0.0001, t);
      this.layers.gain.gain.exponentialRampToValueAtTime(1, t + 2);
    }
    this._scheduleMotif();
  }

  _stop() {
    if (this._motifTimer) { clearTimeout(this._motifTimer); this._motifTimer = null; }
    if (this.layers) { this._teardown(this.layers); this.layers = null; }
    if (this.ctx && this.ctx.state === 'running') this.ctx.suspend();
  }

  /** Build one mood's node graph: drones + air, under a master layer gain. */
  _buildLayer(mood) {
    const p = MOODS[mood];
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.connect(ctx.destination);

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = p.filter;
    filter.Q.value = 0.7;
    filter.connect(gain);

    // The filter breathes — a slow LFO on its cutoff.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 0.05 + Math.random() * 0.04;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = p.filter * 0.35;
    lfo.connect(lfoGain).connect(filter.frequency);
    lfo.start();

    // Detuned drone pair (root + fifth below).
    const oscs = [];
    for (const [freq, det] of [[p.root, 0], [p.root, p.detune], [p.root / 2 * 3, -p.detune / 2]]) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = freq;
      o.detune.value = det;
      const g = ctx.createGain();
      g.gain.value = p.droneGain / 3;
      o.connect(g).connect(filter);
      o.start();
      oscs.push(o);
    }

    // Air: looped filtered noise.
    const noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    const data = noiseBuf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuf;
    noise.loop = true;
    const nFilter = ctx.createBiquadFilter();
    nFilter.type = 'bandpass';
    nFilter.frequency.value = p.filter * 2.2;
    nFilter.Q.value = 0.4;
    const nGain = ctx.createGain();
    nGain.gain.value = p.airGain;
    noise.connect(nFilter).connect(nGain).connect(gain);
    noise.start();

    return { mood, gain, filter, oscs, lfo, noise };
  }

  _teardown(layer) {
    try {
      for (const o of layer.oscs) o.stop();
      layer.lfo.stop();
      layer.noise.stop();
      layer.gain.disconnect();
    } catch { /* already gone */ }
  }

  /** Sparse plucked motif notes on the mood's scale. Self-rescheduling. */
  _scheduleMotif() {
    if (this._motifTimer) clearTimeout(this._motifTimer);
    const loop = () => {
      if (!this.enabled || !this.ctx || !this.layers) return;
      const p = MOODS[this.layers.mood];
      const [lo, hi] = p.motifEvery;
      this._pluck(p);
      this._motifTimer = setTimeout(loop, (lo + Math.random() * (hi - lo)) * 1000);
    };
    this._motifTimer = setTimeout(loop, 1500);
  }

  _pluck(p) {
    const ctx = this.ctx;
    const deg = p.scale[(Math.random() * p.scale.length) | 0];
    const octave = 2 + ((Math.random() * 2) | 0);
    const freq = p.root * Math.pow(2, octave / 1) * Math.pow(2, deg / 12) / 2;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = freq;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(p.motifGain, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.2);
    // A touch of echo.
    const delay = ctx.createDelay();
    delay.delayTime.value = 0.4;
    const fb = ctx.createGain();
    fb.gain.value = 0.35;
    delay.connect(fb).connect(delay);
    o.connect(g);
    g.connect(this.layers.gain);
    g.connect(delay);
    delay.connect(this.layers.gain);
    o.start(t);
    o.stop(t + 2.4);
  }
}
