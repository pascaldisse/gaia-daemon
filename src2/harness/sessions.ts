// One session tracker for every harness. v1 grew three hand-rolled copies of
// this (Claude's RoomState, Pi's ManagedPiSession, Codex's ThreadState), each
// re-implementing the per-room map and the "send memory only when it changed"
// diff. A harness supplies only its metadata type M and an optional disposer.

export class SessionMap<M> {
  private sessions = new Map<string, M>();
  private lastMemory = new Map<string, string>();

  constructor(private readonly disposeMeta?: (meta: M) => void) {}

  get(roomId: string): M | undefined {
    return this.sessions.get(roomId);
  }

  ensure(roomId: string, create: () => M): M {
    const existing = this.sessions.get(roomId);
    if (existing !== undefined) return existing;
    const meta = create();
    this.sessions.set(roomId, meta);
    return meta;
  }

  set(roomId: string, meta: M): void {
    this.sessions.set(roomId, meta);
  }

  /** True when `memory` differs from what this room last sent; records it.
   * Backs the "memory travels in the turn prompt only when it changed" rule.
   * The diff dies with the session (reset ⇒ next turn resends memory). */
  memoryChanged(roomId: string, memory: string): boolean {
    if (this.lastMemory.get(roomId) === memory) return false;
    this.lastMemory.set(roomId, memory);
    return true;
  }

  reset(roomId: string): void {
    const meta = this.sessions.get(roomId);
    if (meta !== undefined) this.disposeMeta?.(meta);
    this.sessions.delete(roomId);
    this.lastMemory.delete(roomId);
  }

  disposeAll(): void {
    for (const roomId of [...this.sessions.keys()]) this.reset(roomId);
  }

  rooms(): string[] {
    return [...this.sessions.keys()];
  }
}
