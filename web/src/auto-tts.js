// Auto reply scheduling only → playback supplied by readaloud.js; no text/audio transport.
/** @typedef {{workspaceId: string, roomId: string}} Origin */
/** @typedef {import('./types.js').UiEvent} UiEvent */
/** @typedef {Extract<UiEvent, {type: 'room-event'}>} Reply */
/** @typedef {{
 * enabled: () => boolean,
 * current: () => Origin|null,
 * acquire: () => Promise<boolean>,
 * owns: () => boolean,
 * manualBusy: () => boolean,
 * play: (eventId: string, origin: Origin) => Promise<void>,
 * policy?: "replace"|"enqueue",
 * log?: (message: string) => void
 * }} QueueDeps */
export class AutoTtsQueue {
  /** @param {QueueDeps} deps */
  constructor(deps) {
    this.deps = deps;
    this.tail = Promise.resolve();
    this.disposed = false;
    this.generation = 0;
    // Duplicate live deliveries → same room event once; no snapshot replay.
    this.seen = new Set();
  }

  /** @param {UiEvent} event @returns {Promise<void>} */
  enqueue(event) {
    if (this.disposed || event.type !== 'room-event') return Promise.resolve();
    const reply = event.event;
    if (['user', 'system', 'tool'].includes(reply.author) || ('kind' in reply && reply.kind) || !reply.text.trim()) return Promise.resolve();
    if (!this.deps.enabled() || !this.inRoom(event) || this.deps.manualBusy()) return Promise.resolve();
    const key = JSON.stringify([event.workspaceId, event.roomId, reply.id]);
    if (this.seen.has(key)) return Promise.resolve();
    this.seen.add(key);
    // Eligibility captured on arrival; queued work rechecked before playback.
    const ownership = this.deps.acquire().catch((error) => { this.log(error); return false; });
    const generation = ++this.generation;
    const replace = (this.deps.policy ?? "replace") === "replace";
    const run = async () => {
      if (!await ownership || this.disposed || !this.deps.enabled() || !this.inRoom(event) || !this.deps.owns() || this.deps.manualBusy()) return;
      if (replace && generation !== this.generation) return;
      // Shared player synchronously retires previous fetch + sources before starting this reply.
      await this.deps.play(reply.id, { workspaceId: event.workspaceId, roomId: event.roomId });
    };
    this.tail = (replace ? run() : this.tail.then(run)).catch((error) => this.log(error));
    return this.tail;
  }

  /** @param {Origin} origin */
  inRoom(origin) {
    const current = this.deps.current();
    if (current?.workspaceId === origin.workspaceId && current.roomId === origin.roomId) return true;
    this.log(`background room skipped: ${origin.workspaceId}/${origin.roomId}`);
    return false;
  }

  dispose() { this.disposed = true; this.seen.clear(); }

  /** @param {unknown} error */
  log(error) {
    try { (this.deps.log ?? console.info)(`auto-tts: ${error instanceof Error ? error.message : String(error)}`); }
    catch { /* Logging failure → FIFO unaffected. */ }
  }
}
