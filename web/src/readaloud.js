// Read-aloud: the per-message play button + the mini audio player above the
// composer. Two things live here:
//
//   1. AudioTransport — a seekable, progressive PCM player. Both server modes
//      (continuous "stream" PCM, or batch "chunks" WAVs) DECODE INTO ONE growing
//      mono buffer, so playback has a single timeline: play/pause, seek anywhere,
//      currentTime + duration. Playback starts the instant the first audio lands
//      (low latency, like before) and the buffer keeps filling behind the
//      playhead, so you can scrub while it is still arriving. When a message
//      finishes, replay resolves the current voice through the server cache.
//
//   2. The mini player UI — a play/pause button, a clickable + draggable
//      timeline with a thumb, and current/total time, rendered above the running
//      banner. It is driven by a rAF loop while playing and by discrete repaints
//      otherwise. The server still decides the mode; nothing here branches on an
//      engine id (same law as the harness abstraction).
import { apiUrl } from "./api.js";
import { markDirty, setError } from "./render.js";
import { h } from "./dom.js";
import { state } from "./state.js";

/** @typedef {"loading"|"playing"|"paused"|"ended"|"dead"} ReadAloudPhase */

// ---------------------------------------------------------------------------
// The transport. Owns one AudioContext and a growing list of mono PCM segments;
// schedules Web Audio buffer sources from the play frontier and re-anchors on
// underrun so the playhead clock stays honest.

export class AudioTransport {
  /** @param {{context?: AudioContext, stallSeconds?: number, watchdogMs?: number, contextCloseTimeoutMs?: number, minClockAdvanceSeconds?: number, maxStalledRebuilds?: number}} [options] */
  constructor({ context, stallSeconds = 2, watchdogMs = 1000, contextCloseTimeoutMs = 3000, minClockAdvanceSeconds = 0.5, maxStalledRebuilds = 2 } = {}) {
    /** @type {AudioContext} */
    this.ctx = context ?? new AudioContext();
    /** Engine sample rate; buffers are created at it and Web Audio resamples to
     * the context on playback. 0 until the first audio sets the format. */
    this.rate = 0;
    /** @type {Float32Array[]} mono PCM segments in arrival order */
    this.segments = [];
    /** @type {number[]} cumulative sample index at each segment's start */
    this.segStart = [];
    /** Total samples appended so far (grows while streaming). */
    this.total = 0;
    /** No more audio will arrive (stream ended / all chunks decoded). */
    this.done = false;
    /** True between play() and pause()/finish. */
    this.playing = false;
    /** Set ONLY by a real user pause (the toggle button or a timeline drag).
     * Everything else that stops audio (finish races, device migration, an
     * underrun) leaves it false, so late audio may re-arm playback. */
    this.userPaused = false;
    /** play() was called and no user pause/finish has retired it: a late
     * append() belongs to this run and must resume it. */
    this._armed = false;
    /** Bumped by every append(); _maybeFinish() aborts if it moves under it. */
    this._appendSeq = 0;
    /** Appends being prepared upstream (a decode/read in flight). */
    this.pendingAppends = 0;
    /** A finish re-check is already queued. */
    this._finishQueued = false;
    /** ctx.currentTime the current play run was anchored at. */
    this.anchorCtx = 0;
    /** The sample index that anchorCtx corresponds to. */
    this.anchorSample = 0;
    /** Next sample to schedule (the play frontier). */
    this.frontier = 0;
    /** Playhead while paused, in samples. */
    this.pausedSample = 0;
    /** @type {Set<AudioBufferSourceNode>} scheduled, not-yet-ended sources */
    this.sources = new Set();
    this.firstAudioSeen = false;
    /** Guards migrateContext() against overlapping device-change events. */
    this._migrating = false;
    /** @type {(() => void)|null} fired once when the first source is scheduled */
    this.onFirstAudio = null;
    /** @type {(() => void)|null} fired when the last sample finishes playing */
    this.onEnded = null;
    /** @type {((error: unknown) => void)|null} visible AudioContext failures */
    this.onError = null;
    this.stallSeconds = Number.isFinite(stallSeconds) && stallSeconds > 0 ? stallSeconds : 2;
    this.watchdogMs = Number.isFinite(watchdogMs) && watchdogMs > 0 ? watchdogMs : 1000;
    this.contextCloseTimeoutMs = Number.isFinite(contextCloseTimeoutMs) && contextCloseTimeoutMs > 0 ? contextCloseTimeoutMs : 3000;
    this.minClockAdvanceSeconds = Number.isFinite(minClockAdvanceSeconds) && minClockAdvanceSeconds > 0 ? minClockAdvanceSeconds : 0.5;
    this.maxStalledRebuilds = Number.isFinite(maxStalledRebuilds) && maxStalledRebuilds > 0 ? Math.floor(maxStalledRebuilds) : 2;
    this.rebuilds = 0;
    this.stalledRebuilds = 0;
    this.outputDead = false;
    /** @type {(() => void)|null} */
    this.onDead = null;
    this.status = "";
    /** @type {(() => void)|null} */
    this.onStatus = null;
    /** @type {ReturnType<typeof setInterval>|null} */
    this._watchdog = null;
    this._lastProgressAt = performance.now();
    this._lastCtxTime = this.ctx.currentTime;
    this.outputSample = { state: this.ctx.state, ctxTime: this.ctx.currentTime, wallTime: performance.now(), outputLatency: this.ctx.outputLatency ?? 0, cursor: this.frontier };
    this._destroyed = false;
    this._resumeSeq = 0;
    this._bindContextState();
    this._mediaDevices = navigator.mediaDevices;
    this._onDeviceChange = () => { void this.rebuildDeadOutput(); };
    this._mediaDevices?.addEventListener?.("devicechange", this._onDeviceChange);
  }

  // State/device/watchdog failures → one bounded rebuild path; PCM retained.
  _bindContextState() {
    const ctx = this.ctx;
    ctx.onstatechange = () => {
      if (this.ctx !== ctx || this._destroyed || this._migrating || !this.playing || this.userPaused) return;
      if (ctx.state === 'running') {
        this._pump();
        return;
      }
      void this.rebuildDeadOutput();
    };
  }

  /** @param {string} reason */
  _status(reason) {
    if (this.status === reason) return;
    this.status = reason;
    console.info('read-aloud:', JSON.stringify({ reason: reason || 'clock advancing',
      context: this.ctx.state, position: this.currentTime, buffered: this.duration, done: this.done }));
    this.onStatus?.();
  }

  /** Resume synchronously in the gesture task; a previous pending resume must not swallow activation.
   * @param {string} [reason] @param {boolean} [reschedule] */
  recover(reason = 'audio recovery', reschedule = false) {
    if (this._destroyed || this._migrating || !this.playing || this.userPaused) return;
    const ctx = this.ctx;
    if (ctx.state === 'running' && !reschedule) return;
    if (ctx.state === 'closed') { void this.rebuildDeadOutput(); return; }
    this._status(`${reason} — ${ctx.state === 'running' ? 'rescheduling' : 'resume pending; click to enable audio'}`);
    const seq = ++this._resumeSeq;
    void ctx.resume().then(() => {
      if (this._destroyed || this.ctx !== ctx || seq !== this._resumeSeq || !this.playing || this.userPaused) return;
      if (ctx.state !== 'running') return; // Browser policy may resolve without granting output.
      if (reschedule) this.play(Math.round(this.currentTime * this.sampleRate));
      else this._pump();
    }).catch((error) => {
      if (this._destroyed || this.ctx !== ctx || seq !== this._resumeSeq || !this.playing) return;
      this._status(`${reason} — ${error instanceof Error ? error.message : String(error)}; click to retry`);
    });
  }

  _startWatchdog() {
    this._stopWatchdog();
    this._lastCtxTime = this.ctx.currentTime;
    this._lastProgressAt = performance.now();
    this._watchdog = setInterval(() => this.checkProgress(), this.watchdogMs);
  }

  _stopWatchdog() {
    if (this._watchdog !== null) clearInterval(this._watchdog);
    this._watchdog = null;
  }

  /** Independent of rAF (hidden tabs); timers may still be OS-throttled.
   * @param {number} [now] monotonic milliseconds */
  checkProgress(now = performance.now()) {
    if (this._destroyed || !this.playing || this.userPaused || this._migrating) return;
    const ctxTime = this.ctx.currentTime;
    this.outputSample = { state: this.ctx.state, ctxTime, wallTime: now,
      outputLatency: this.ctx.outputLatency ?? 0, cursor: this.frontier };
    this.onStatus?.();
    if (this.ctx.state !== 'running') { void this.rebuildDeadOutput(); return; }
    // No scheduled PCM → download underrun, not dead output.
    if (!this.sources.size && this.frontier >= this.total) {
      this._lastCtxTime = ctxTime;
      this._lastProgressAt = now;
      this._maybeFinish();
      return;
    }
    if (now - this._lastProgressAt < this.stallSeconds * 1000) return;
    const advance = ctxTime - this._lastCtxTime;
    this._lastCtxTime = ctxTime;
    this._lastProgressAt = now;
    if (advance < this.minClockAdvanceSeconds) { void this.rebuildDeadOutput(); return; }
    this.stalledRebuilds = 0;
    if (this.status) this._status('');
    this._maybeFinish();
  }

  _deadOutput() {
    this.pausedSample = Math.round(this.currentTime * this.sampleRate);
    this.outputDead = true;
    this.playing = false;
    this._armed = false;
    this._stopSources();
    this._stopWatchdog();
    this._status('audio dead — click ⟳');
    this.onDead?.();
  }

  async rebuildDeadOutput() {
    if (this._destroyed || this._migrating || !this.playing || this.userPaused) return;
    if (this.stalledRebuilds >= this.maxStalledRebuilds) { this._deadOutput(); return; }
    this.stalledRebuilds++;
    await this.migrateContext(true);
  }

  /** @returns {number} */
  get sampleRate() {
    return this.rate || 16000;
  }

  /** Available (buffered) duration in seconds — grows while streaming. */
  get duration() {
    return this.total / this.sampleRate;
  }

  /** Current playhead in seconds, clamped to what is buffered. */
  get currentTime() {
    if (!this.playing || this._migrating) return this.pausedSample / this.sampleRate;
    // Context clock only → never wall time, download bytes, or unscheduled PCM.
    // Scheduling lead → hold at resume sample; no backwards jump on rebuild.
    const s = this.anchorSample + Math.max(0, this.ctx.currentTime - this.anchorCtx) * this.sampleRate;
    return Math.min(this.frontier, this.total, Math.max(0, s)) / this.sampleRate;
  }

  /** @param {number} rate @param {number} _channels */
  setFormat(rate, _channels) {
    if (!this.rate && rate > 0) this.rate = rate;
  }

  /** Append a mono PCM segment; schedule it if we are playing.
   * @param {Float32Array} mono */
  append(mono) {
    if (this._destroyed || !mono.length) return;
    this.segStart.push(this.total);
    this.segments.push(mono);
    this.total += mono.length;
    this._appendSeq += 1;
    if (this.playing) {
      this._pump();
      return;
    }
    // Audio arrived after playback stopped without the user asking for it (a
    // finish that raced the tail, a migration): re-arm from where we stopped
    // instead of dropping the remainder on the floor. THIS is the stall bug.
    if (this._armed && !this.userPaused) this.play(this.pausedSample);
  }

  /** Read samples [from, to) into one contiguous Float32Array (across segments).
   * @param {number} from @param {number} to @returns {Float32Array} */
  _read(from, to) {
    const out = new Float32Array(Math.max(0, to - from));
    let oi = 0;
    for (let i = 0; i < this.segments.length && oi < out.length; i++) {
      const segA = this.segStart[i];
      const seg = this.segments[i];
      const segB = segA + seg.length;
      if (segB <= from) continue;
      if (segA >= to) break;
      const a = Math.max(from, segA) - segA;
      const b = Math.min(to, segB) - segA;
      out.set(seg.subarray(a, b), oi);
      oi += b - a;
    }
    return out;
  }

  /** Schedule every buffered-but-unscheduled sample ahead of the playhead. */
  _pump() {
    if (this._destroyed || this._migrating || !this.playing || this.ctx.state !== "running") return;
    while (this.frontier < this.total) {
      const start = this.frontier;
      const end = this.total;
      let startCtx = this.anchorCtx + (start - this.anchorSample) / this.sampleRate;
      // First schedule or an underrun (playback caught the download): re-anchor
      // a hair in the future so the clock and the audio agree again.
      if (startCtx < this.ctx.currentTime + 0.02) {
        startCtx = this.ctx.currentTime + 0.08;
        this.anchorCtx = startCtx;
        this.anchorSample = start;
      }
      const buf = this.ctx.createBuffer(1, end - start, this.sampleRate);
      buf.getChannelData(0).set(this._read(start, end));
      const src = this.ctx.createBufferSource();
      src.buffer = buf;
      src.connect(this.ctx.destination);
      src.start(startCtx);
      this.frontier = end;
      this.sources.add(src);
      src.onended = () => {
        this.sources.delete(src);
        this._maybeFinish();
      };
    }
    if (!this.firstAudioSeen && this.sources.size) {
      this.firstAudioSeen = true;
      this.onFirstAudio?.();
    }
  }

  /** Every condition that must hold for playback to be over. */
  _canFinish() {
    return this.playing && !this._migrating && !this._destroyed
      && this.done
      && this.frontier >= this.total
      && this.sources.size === 0
      && this.pendingAppends === 0;
  }

  /** Finish only if nothing lands in between. The last source's onended fires
   * before an in-flight append() has been applied, so a synchronous finish can
   * strand the tail (playing=false, append() no-ops). Re-check on the next
   * microtask and abort if any append arrived. */
  _maybeFinish() {
    if (!this._canFinish() || this._finishQueued) return;
    this._finishQueued = true;
    const seq = this._appendSeq;
    queueMicrotask(() => {
      this._finishQueued = false;
      if (this._appendSeq !== seq || !this._canFinish()) return;
      this.playing = false;
      this._stopWatchdog();
      this.userPaused = false;
      // _armed stays true on purpose: finishing is OUR decision, not the
      // user's, and a truncated stream can still deliver its tail afterwards.
      // Only pause()/destroy() retire the run.
      this.pausedSample = this.total;
      this.onEnded?.();
    });
  }

  /** Start (or resume/seek) playback from a sample index.
   * @param {number} [fromSample] defaults to the current playhead */
  play(fromSample) {
    if (this._destroyed || this.outputDead) return;
    const from = fromSample ?? Math.round(this.currentTime * this.sampleRate);
    this._stopSources();
    this.playing = true;
    this.userPaused = false;
    this._armed = true;
    this.frontier = Math.min(Math.max(0, from), this.total);
    this.pausedSample = this.frontier;
    this.anchorCtx = this.ctx.currentTime + 0.08;
    this.anchorSample = this.frontier;
    this._startWatchdog();
    this.recover('playback');
    this._pump();
    this._maybeFinish();
  }

  /** User-initiated pause (toggle button / drag). Sets userPaused, which blocks
   * append() from re-arming — a paused player must stay paused. */
  pause() {
    if (!this.playing) return;
    this.pausedSample = Math.round(this.currentTime * this.sampleRate);
    this._stopSources();
    this.playing = false;
    this.userPaused = true;
    this._armed = false;
    this._resumeSeq++;
    this._stopWatchdog();
  }

  /** @param {number} seconds */
  seek(seconds) {
    const sample = Math.max(0, Math.min(this.total, Math.round(seconds * this.sampleRate)));
    if (this.playing) this.play(sample);
    else this.pausedSample = sample;
  }

  markDone() {
    this.done = true;
    this._maybeFinish();
  }

  _stopSources() {
    for (const src of this.sources) {
      src.onended = null;
      try {
        src.stop();
      } catch {
        // Not started / already stopped.
      }
    }
    this.sources.clear();
  }

  /** Re-bind playback to the CURRENT default output device.
   *
   * An AudioContext latches onto whatever output was default when it was
   * created. Chromium silently follows a later default-device change; WebKit
   * (the macOS/iOS native shell) does NOT — if the bound device disappears
   * mid-playback (e.g. Bluetooth headphones disconnect), the context keeps
   * ticking ctx.currentTime into a dead route: the timeline advances, the
   * playhead moves, and there is no sound. We recreate the context so it
   * re-binds to the live default, resuming from the current playhead. The
   * buffered PCM (this.segments) survives — only the ctx + scheduled sources
   * are rebuilt. No-op unless we are actually playing.
   * @param {boolean} [deadOutput] watchdog/state failure */
  async migrateContext(deadOutput = false) {
    if (this._destroyed || !this.playing || this._migrating) return;
    this.pausedSample = Math.round(this.currentTime * this.sampleRate);
    this._migrating = true;
    this._status('rebinding audio output');
    try {
      this._stopSources();
      const ctx = this.ctx;
      ctx.onstatechange = null;
      /** @type {ReturnType<typeof setTimeout>|undefined} */
      let deadline;
      try {
        await Promise.race([
          ctx.close().catch(error => { if (ctx.state !== 'closed') throw error; }),
          new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('Audio output rebind timed out')), this.contextCloseTimeoutMs); }),
        ]);
      } finally { clearTimeout(deadline); }
      if (this._destroyed) return;
      this.ctx = new AudioContext();
      this.rebuilds++;
      if (deadOutput) console.info(`read-aloud: output dead → context rebuilt (#${this.rebuilds})`);
      this._bindContextState();
      this._migrating = false;
      if (this.playing && !this.userPaused) this.play(this.pausedSample);
    } catch (error) {
      // Never leave this.ctx closed and silent: the old context is dead, a new
      // one could not be built. Say so instead of freezing the playhead.
      this.playing = false;
      this._armed = false;
      this._stopWatchdog();
      if (!this._destroyed) {
        if (deadOutput) { console.error('read-aloud: context rebuild failed', error); this._deadOutput(); }
        else this.onError?.(error);
      }
    } finally {
      this._migrating = false;
    }
  }

  /** @param {boolean} [closeContext] false only for immediate shared-player handoff */
  destroy(closeContext = true) {
    this._destroyed = true;
    this.playing = false;
    this._armed = false;
    this._resumeSeq++;
    this._stopWatchdog();
    this.ctx.onstatechange = null;
    this._mediaDevices?.removeEventListener?.("devicechange", this._onDeviceChange);
    this._stopSources();
    if (closeContext) void this.ctx.close().catch(() => {});
  }

  /** The whole buffered PCM as one Float32Array (for the client cache). */
  concatPcm() {
    return this._read(0, this.total);
  }
}

// ---------------------------------------------------------------------------
// Module playback state: at most one message plays at a time (this tab).

/** @type {AudioTransport|null} */
let transport = null;
/** @type {AbortController|null} */
let fetchController = null;
let activeEventId = "";
/** @type {{engine?: string}} */
let activeOptions = {};
/** @type {{workspaceId: string, roomId: string}|null} */
let activeOrigin = null;
// All input stays browser-owned; paused/ended transports are never auto-resumed.
for (const event of ['pointerdown', 'keydown', 'touchend', 'click', 'focus']) {
  window.addEventListener?.(event, () => { transport?.recover(event); updatePlayerUi(); }, { capture: true, passive: true });
}
window.addEventListener?.('visibilitychange', () => {
  if (document.visibilityState === 'visible') { transport?.recover('tab visible'); updatePlayerUi(); }
});

/** @param {ReadAloudPhase} phase */
function setPhase(phase) {
  if (state.readAloud?.eventId === activeEventId && activeOrigin) {
    state.readAloud = { eventId: activeEventId, phase, ...activeOrigin };
  }
  markDirty("transcript", "status");
}

/** Toggle read-aloud for a message: start it, or if it is already the active
 * one, toggle play/pause (during loading, cancel it).
 * @param {string} eventId */
export function toggleReadAloud(eventId) {
  if (activeEventId === eventId && transport && activeOrigin?.workspaceId === state.snapshot?.workspace.id && activeOrigin?.roomId === state.snapshot?.room.id) {
    if (state.readAloud?.phase === "loading") stopReadAloud();
    else playerToggle();
    return;
  }
  void startReadAloud(eventId);
}

/** Tear everything down and hide the player. */
export function stopReadAloud() {
  stopTick();
  if (fetchController) {
    try {
      fetchController.abort();
    } catch {
      // Already settled.
    }
    fetchController = null;
  }
  if (transport) {
    transport.onEnded = null;
    transport.onFirstAudio = null;
    transport.onError = null;
    transport.destroy();
    transport = null;
  }
  activeEventId = "";
  activeOrigin = null;
  if (state.readAloud) {
    state.readAloud = null;
    markDirty("transcript", "status");
  }
  updatePlayerUi();
}

/** @param {string} eventId @param {boolean} [regenerate] skip the server cache and
 * re-synthesize (the ⟳ button), replacing a bad cached clip.
 * @param {{workspaceId: string, roomId: string}|null} [playbackOrigin]
 * @param {{engine?: string}} [options] */
export async function startReadAloud(eventId, regenerate = false, playbackOrigin = null, options = {}) {
  stopReadAloud();
  const snapshot = state.snapshot;
  const origin = playbackOrigin ?? (snapshot ? { workspaceId: snapshot.workspace.id, roomId: snapshot.room.id } : null);
  if (!origin) return;

  const base = apiUrl(`/api/workspaces/${encodeURIComponent(origin.workspaceId)}/rooms/${encodeURIComponent(origin.roomId)}`);
  // Bind playback to the room it started in, so switching rooms mid-play never
  // re-points fetches and the now-playing chip can jump back to this message.
  activeOptions = options;
  activeEventId = eventId;
  activeOrigin = origin;

  /** @type {AudioTransport} */
  let t;
  try { t = new AudioTransport(); }
  catch (error) { stopReadAloud(); setError(error); return; }
  transport = t;
  t.onStatus = updatePlayerUi;
  t.onDead = () => { if (transport !== t) return; stopTick(); setPhase("dead"); updatePlayerUi(); };
  t.onFirstAudio = () => {
    if (activeEventId === eventId && state.readAloud?.phase === "loading") setPhase("playing");
  };
  t.onEnded = () => {
    if (transport !== t) return;
    stopTick();
    if (activeEventId === eventId) setPhase("ended");
    updatePlayerUi();
  };
  t.onError = (error) => {
    if (transport !== t) return;
    stopReadAloud();
    setError(error instanceof Error ? error : new Error(String(error)));
  };

  state.readAloud = { eventId, phase: "loading", ...origin };
  markDirty("transcript", "status");

  // Re-resolve voice/model/text on every replay; eventId alone is not audio identity.
  const controller = new AbortController();
  fetchController = controller;
  try {
    t.play(0); // Arm once; playback begins with the first PCM.
    startTick();
    const response = await fetch(`${base}/read-aloud/stream`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId, ...options, ...(regenerate ? { regenerate: true } : {}) }),
      signal: controller.signal,
    });
    if (transport !== t) return; // stopped/replaced while awaiting
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `Read aloud failed: ${response.status}`);
    }
    if (response.headers.get("x-tts-mode") === "stream" && response.body) {
      await feedStream(t, response, controller);
    } else {
      const info = await response.json().catch(() => ({}));
      const total = Number.isInteger(info?.chunks) && info.chunks > 0 ? info.chunks : 1;
      await feedChunks(t, base, eventId, total, controller, regenerate, options);
    }
  } catch (error) {
    if (transport !== t || controller.signal.aborted) return;
    stopReadAloud();
    if (!(error instanceof DOMException && error.name === "AbortError")) setError(error);
  }
}

/** Continuous PCM: decode each s16le frame to mono and append as it arrives.
 * @param {AudioTransport} t @param {Response} response @param {AbortController} controller */
async function feedStream(t, response, controller) {
  const rate = Number(response.headers.get("x-tts-rate")) || 16000;
  const channels = Number(response.headers.get("x-tts-channels")) || 1;
  t.setFormat(rate, channels);
  const reader = /** @type {ReadableStream<Uint8Array>} */ (response.body).getReader();
  const frameBytes = 2 * channels; // s16le
  /** @type {Uint8Array} */
  let leftover = new Uint8Array(0);
  let pcmFrames = 0;
  for (;;) {
    /** @type {ReadableStreamReadResult<Uint8Array>} */
    let chunk;
    try {
      chunk = await reader.read();
    } catch (error) {
      if (controller.signal.aborted || transport !== t) return;
      // The server destroyed the response mid-stream (see rooms.ts): the clip is
      // TRUNCATED, not finished. Never markDone() here — say where it broke.
      t.onError?.(new Error(`audio stream aborted at ${fmtTime(t.currentTime)}`, { cause: error }));
      return;
    }
    const { done, value } = chunk;
    if (controller.signal.aborted || transport !== t) {
      try {
        await reader.cancel();
      } catch {
        // Already cancelled.
      }
      return;
    }
    if (done) break;
    if (!value || value.length === 0) continue;
    let buf = value;
    if (leftover.length) {
      const merged = new Uint8Array(leftover.length + value.length);
      merged.set(leftover);
      merged.set(value, leftover.length);
      buf = merged;
      leftover = new Uint8Array(0);
    }
    const usable = buf.length - (buf.length % frameBytes);
    if (usable < buf.length) leftover = buf.slice(usable);
    if (usable === 0) continue;
    pcmFrames += usable / frameBytes;
    t.append(s16leToMono(buf.subarray(0, usable), channels));
  }
  if (!pcmFrames) throw new Error("Read aloud stream ended without audio frames");
  t.markDone();
}

/** Batch WAV chunks: fetch each, decode to PCM, append. append() is
 * non-blocking (it just schedules), so the next chunk fetches while the current
 * one plays — natural pipelining, no explicit prefetch needed.
 * @param {AudioTransport} t @param {string} base @param {string} eventId
 * @param {number} total @param {AbortController} controller @param {boolean} [regenerate] @param {{engine?: string}} [options] */
async function feedChunks(t, base, eventId, total, controller, regenerate = false, options = {}) {
  const endpoint = `${base}/read-aloud`;
  for (let index = 0; index < total; index++) {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventId, ...options, chunk: index, ...(regenerate ? { regenerate: true } : {}) }),
      signal: controller.signal,
    });
    if (controller.signal.aborted || transport !== t) return;
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error ?? `Read aloud failed: ${response.status}`);
    }
    const count = Number(response.headers.get("x-tts-chunks"));
    if (Number.isInteger(count) && count > 0) total = count;
    // Decode is async: mark the append as in flight so a finish cannot land
    // between the last source ending and this chunk being appended.
    t.pendingAppends += 1;
    try {
      const decoded = await t.ctx.decodeAudioData(await response.arrayBuffer());
      if (controller.signal.aborted || transport !== t) return;
      t.setFormat(decoded.sampleRate, decoded.numberOfChannels);
      t.append(downmix(decoded));
    } finally {
      t.pendingAppends -= 1;
    }
  }
  t.markDone();
}

/** @param {Uint8Array} bytes whole s16le frames @param {number} channels @returns {Float32Array} */
function s16leToMono(bytes, channels) {
  const frames = Math.floor(bytes.length / (2 * channels));
  const out = new Float32Array(frames);
  const view = new DataView(bytes.buffer, bytes.byteOffset, frames * 2 * channels);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += view.getInt16((i * channels + c) * 2, true);
    out[i] = sum / channels / 32768;
  }
  return out;
}

/** @param {AudioBuffer} buffer @returns {Float32Array} */
function downmix(buffer) {
  const channels = buffer.numberOfChannels;
  if (channels === 1) return buffer.getChannelData(0).slice();
  const out = new Float32Array(buffer.length);
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += data[i];
  }
  for (let i = 0; i < out.length; i++) out[i] /= channels;
  return out;
}

// ---------------------------------------------------------------------------
// The mini player UI (built once, mounted in the composer above the banner).

/** @type {HTMLElement|null} */
let playerRoot = null;
/** @type {HTMLButtonElement|null} */
let toggleBtn = null;
/** @type {HTMLElement|null} */
let curTimeEl = null;
/** @type {HTMLElement|null} */
let durTimeEl = null;
/** @type {HTMLElement|null} */
let liveEl = null;
/** @type {HTMLElement|null} */
let recoveryEl = null;
/** @type {HTMLElement|null} */
let diagEl = null;
/** @type {HTMLElement|null} */
let trackEl = null;
/** @type {HTMLElement|null} */
let playedEl = null;
/** @type {HTMLElement|null} */
let thumbEl = null;

let rafId = 0;
let dragging = false;
let dragWasPlaying = false;
let dragFrac = 0;

/** Build the player element once. Called by the composer at init. */
export function buildAudioPlayer() {
  playedEl = h("div", { class: "ap-played" });
  thumbEl = h("div", { class: "ap-thumb" });
  trackEl = h("div", { class: "ap-track", title: "click or drag to seek" }, playedEl, thumbEl);
  toggleBtn = /** @type {HTMLButtonElement} */ (
    h("button", { type: "button", class: "ap-toggle", title: "play", text: "▶", onclick: playerToggle })
  );
  curTimeEl = h("span", { class: "ap-time" }, "0:00");
  durTimeEl = h("span", { class: "ap-time ap-dur" }, "0:00");
  // Shown only while the stream is still synthesizing: the total is provisional
  // and grows in real-time (claude-voice generates at ~speaking speed), so this
  // says "still generating" instead of letting a partial length look truncated.
  liveEl = h("span", { class: "ap-live", hidden: true, title: "still generating — the length grows until synthesis finishes" }, "⋯ live");
  recoveryEl = h("span", { class: "ap-recovery", role: "status", hidden: true });
  diagEl = h("span", { class: "ap-diag", hidden: true, title: "AudioContext state · ctxTime (s) · scheduled-sample cursor · rebuilds" });
  playerRoot = h(
    "div",
    { class: "audio-player", hidden: true },
    toggleBtn,
    curTimeEl,
    trackEl,
    durTimeEl,
    liveEl,
    recoveryEl,
    diagEl,
    h("button", { type: "button", class: "ap-regen", title: "regenerate audio (re-synthesize, replaces the cached clip)", text: "⟳", onclick: regenerateAudio }),
    h("button", { type: "button", class: "ap-stop", title: "close player", text: "✕", onclick: stopReadAloud }),
  );
  attachTrackHandlers(trackEl);
  return playerRoot;
}

/** @param {HTMLElement} track */
function attachTrackHandlers(track) {
  /** @param {PointerEvent} ev @returns {number} */
  const fracAt = (ev) => {
    const rect = track.getBoundingClientRect();
    return rect.width > 0 ? Math.min(1, Math.max(0, (ev.clientX - rect.left) / rect.width)) : 0;
  };
  track.addEventListener("pointerdown", (ev) => {
    if (!transport || transport.duration <= 0) return;
    ev.preventDefault();
    try {
      track.setPointerCapture(ev.pointerId);
    } catch {
      // Capture unsupported; drag still tracks via the element listeners.
    }
    dragging = true;
    dragWasPlaying = transport.playing;
    if (transport.playing) transport.pause();
    dragFrac = fracAt(ev);
    updatePlayerUi(dragFrac);
  });
  track.addEventListener("pointermove", (ev) => {
    if (!dragging) return;
    dragFrac = fracAt(ev);
    updatePlayerUi(dragFrac);
  });
  const end = (/** @type {PointerEvent} */ ev) => {
    if (!dragging) return;
    dragging = false;
    try {
      track.releasePointerCapture(ev.pointerId);
    } catch {
      // Already released.
    }
    if (!transport) return;
    transport.seek(dragFrac * transport.duration);
    if (dragWasPlaying) {
      transport.play();
      setPhase("playing");
      startTick();
    } else {
      setPhase("paused");
      updatePlayerUi();
    }
  };
  track.addEventListener("pointerup", end);
  track.addEventListener("pointercancel", end);
}

/** Play/pause/resume/replay from the player or the message button. */
function playerToggle() {
  if (!transport) return;
  if (transport.outputDead) { regenerateAudio(); return; }
  if (transport.playing && transport.ctx.state !== 'running') {
    transport.recover('play button');
    updatePlayerUi();
    return;
  }
  if (transport.playing) {
    transport.pause();
    setPhase("paused");
    stopTick();
    updatePlayerUi();
    return;
  }
  // Resume, or replay from the top if we were sitting at the end.
  const atEnd = transport.done && transport.currentTime >= transport.duration - 0.05;
  if (atEnd) {
    void startReadAloud(activeEventId, false, activeOrigin, activeOptions);
    return;
  }
  transport.play();
  setPhase("playing");
  startTick();
}

/** Re-synthesize the active message from scratch, replacing a bad cached clip
 * (e.g. an old truncated stream). Tells the
 * server to skip its disk cache and overwrite the entry. */
function regenerateAudio() {
  const id = activeEventId;
  if (!id) return;
  void startReadAloud(id, true, activeOrigin, activeOptions);
}

function startTick() {
  cancelAnimationFrame(rafId);
  const step = () => {
    if (!transport) return;
    updatePlayerUi();
    if (transport.playing) rafId = requestAnimationFrame(step);
  };
  rafId = requestAnimationFrame(step);
}

function stopTick() {
  cancelAnimationFrame(rafId);
  rafId = 0;
}

/** Repaint the player nodes. `overrideFrac` (during a drag) shows the dragged
 * position without moving the transport.
 * @param {number} [overrideFrac] */
function updatePlayerUi(overrideFrac) {
  if (!playerRoot || !toggleBtn || !curTimeEl || !durTimeEl || !liveEl || !playedEl || !thumbEl) return;
  if (!transport) {
    playerRoot.hidden = true;
    return;
  }
  playerRoot.hidden = false;
  playerRoot.classList.toggle("audio-dead", transport.outputDead);
  if (recoveryEl) { recoveryEl.textContent = transport.status; recoveryEl.title = transport.status; recoveryEl.hidden = !transport.status; }
  if (diagEl) {
    diagEl.hidden = localStorage.getItem("TTS_DIAG") !== "1";
    diagEl.textContent = diagEl.hidden ? "" : `${transport.ctx.state} · ctxTime=${transport.ctx.currentTime.toFixed(2)} · cursor=${transport.frontier} · rebuilds=${transport.rebuilds}`;
  }
  const dur = transport.duration;
  const cur = overrideFrac != null ? overrideFrac * dur : transport.currentTime;
  const frac = dur > 0 ? Math.min(1, cur / dur) : 0;
  const pct = `${(frac * 100).toFixed(2)}%`;
  playedEl.style.width = pct;
  thumbEl.style.left = pct;
  curTimeEl.textContent = fmtTime(cur);
  // Until synthesis finishes, the length is provisional and still growing — mark
  // it (~) and show the "⋯ live" badge so a partial total never reads as truncated.
  const generating = !transport.done;
  durTimeEl.textContent = `${generating ? "~" : ""}${fmtTime(dur)}`;
  liveEl.hidden = !generating;
  const playing = transport.playing;
  toggleBtn.textContent = playing ? "⏸" : "▶";
  toggleBtn.title = playing ? "pause" : "play";
  playerRoot.classList.toggle("loading", state.readAloud?.phase === "loading" && dur === 0);
  playerRoot.classList.toggle("generating", generating);
}

/** @param {number} seconds @returns {string} */
function fmtTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}
