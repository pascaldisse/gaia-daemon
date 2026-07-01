/** Minimal typed pub/sub. Subscribers never throw into the emitter. */
export class Bus<T> {
  private listeners = new Set<(event: T) => void>();

  on(listener: (event: T) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: T): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch {
        // A broken subscriber must never break the publisher.
      }
    }
  }
}
