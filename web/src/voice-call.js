/** @typedef {{workspaceId: string, roomId: string}} CallOrigin */
/** @typedef {import('./types.js').UiEvent} UiEvent */
/** @typedef {{origin: CallOrigin, startedAt: number, abort: AbortController, seen: Set<string>, stopMic: (() => void)|null}} Call */
/** @typedef {{now?: () => number, changed: (call: Call|null) => void, stopAudio: () => void, speak: (id: string, origin: CallOrigin) => void, error: (error: unknown) => void, openMic: (signal: AbortSignal, text: (text: string) => Promise<void>) => Promise<() => void>, send: (text: string, origin: CallOrigin, signal: AbortSignal) => Promise<void>}} CallDeps */
export class VoiceCall {
  /** @param {CallDeps} deps */
  constructor(deps) { this.deps = deps; /** @type {Call|null} */ this.current = null; }
  /** @param {CallOrigin} origin @param {string[]} [knownIds] */
  async start(origin, knownIds = []) {
    this.end();
    const call = { origin: { ...origin }, startedAt: (this.deps.now ?? Date.now)(), abort: new AbortController(), seen: new Set(knownIds), stopMic: /** @type {(() => void)|null} */ (null) };
    this.current = call;
    this.deps.changed(call);
    try {
      const stop = await this.deps.openMic(call.abort.signal, async (text) => {
        if (this.current !== call || call.abort.signal.aborted || !text.trim()) return;
        await this.deps.send(text, call.origin, call.abort.signal);
      });
      if (this.current !== call) stop();
      else call.stopMic = stop;
    } catch (error) {
      if (this.current !== call) return;
      this.end();
      this.deps.error(error);
    }
  }
  end() {
    const call = this.current;
    this.current = null; // retire before any abort/onstop callback
    call?.abort.abort();
    call?.stopMic?.();
    this.deps.stopAudio();
    this.deps.changed(null);
  }
  /** @param {CallOrigin|null} origin */
  navigate(origin) {
    const call = this.current;
    if (call && (!origin || origin.workspaceId !== call.origin.workspaceId || origin.roomId !== call.origin.roomId)) this.end();
  }
  /** @param {UiEvent} payload */
  reply(payload) {
    const call = this.current;
    if (!call || payload.type !== "room-event" || payload.workspaceId !== call.origin.workspaceId || payload.roomId !== call.origin.roomId) return;
    const event = payload.event;
    if (["user", "system", "tool"].includes(event.author) || ("kind" in event && event.kind) || !event.text.trim()) return;
    const at = Date.parse(event.timestamp);
    if (!Number.isFinite(at) || at <= call.startedAt || call.seen.has(event.id)) return;
    call.seen.add(event.id);
    // No queue; shared transport retires the previous request synchronously.
    this.deps.speak(event.id, call.origin);
  }
}
