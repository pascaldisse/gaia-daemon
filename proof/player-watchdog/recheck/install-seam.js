(async () => {
  const mod = await import('/src/readaloud.js');
  const {state} = await import('/src/state.js');
  localStorage.setItem('TTS_DIAG', '1');
  const NativeContext = window.AudioContext;
  const proof = window.playerProof = { contexts: [], transports: [], logs: [], errors: [], freezeNew: false };
  for (const level of ['info', 'warn', 'error']) {
    const original = console[level].bind(console);
    console[level] = (...args) => { proof.logs.push({level, args: args.map(String)}); original(...args); };
  }
  window.addEventListener('error', e => proof.errors.push(e.message));
  window.addEventListener('unhandledrejection', e => proof.errors.push(String(e.reason)));
  window.AudioContext = class extends NativeContext {
    constructor(...args) {
      super(...args);
      this.hold = proof.freezeNew ? 0 : null;
      this.analyser = this.createAnalyser();
      this.analyser.connect(this.destination);
      proof.contexts.push(this);
if (proof.freezeNew) void NativeContext.prototype.suspend.call(this);
    }
    get currentTime() { return this.hold ?? super.currentTime; }
    get state() { return this.hold !== null ? 'running' : super.state; }
    createBufferSource() {
      const src = super.createBufferSource();
      const connect = src.connect.bind(src);
      src.connect = destination => connect(destination === this.destination ? this.analyser : destination);
      return src;
    }
  };
  const play = mod.AudioTransport.prototype.play;
  mod.AudioTransport.prototype.play = function(...args) {
    if (!proof.transports.includes(this)) proof.transports.push(this);
    return play.apply(this,args);
  };
  proof.freeze = async () => {
    const t = proof.transports.at(-1);
    t.ctx.hold = t.ctx.currentTime;
    await NativeContext.prototype.suspend.call(t.ctx);
    return proof.sample();
  };
  proof.sample = () => {
    const t = proof.transports.at(-1);
    const samples = new Float32Array(t?.ctx.analyser.fftSize ?? 0);
    t?.ctx.analyser.getFloatTimeDomainData(samples);
    return {phase: state.readAloud?.phase, playing: t?.playing, dead: t?.outputDead,
      position: t?.currentTime, duration: t?.duration, ctxTime: t?.ctx.currentTime,
      nativeState: t && Object.getOwnPropertyDescriptor(NativeContext.prototype, 'state')?.get?.call(t.ctx),
      rebuilds:t?.rebuilds, stalledRebuilds:t?.stalledRebuilds, sources:t?.sources.size,
      samples:t?.total, peak: samples.reduce((a,v)=>Math.max(a,Math.abs(v)),0),
      bar:document.querySelector('.ap-played')?.getAttribute('style'),
      red:document.querySelector('.audio-player')?.classList.contains('audio-dead'),
      status:document.querySelector('.ap-recovery')?.textContent,
      color: getComputedStyle(document.querySelector('.ap-recovery')).color,
      diag:document.querySelector('.ap-diag')?.textContent, errors:proof.errors};
  };
  proof.start = (index = 3) => document.querySelectorAll('button[title="read this message aloud"]')[index].click();
  return {installed:true, event:state.readAloud, classes:[...document.querySelectorAll('.audio-player')].map(n=>n.className)};
})()
