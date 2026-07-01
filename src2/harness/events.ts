// The push/queue/notify bridge between a callback-style streaming source (a Pi
// session subscription, a Claude NDJSON reader, a Codex JSON-RPC handler) and
// the AsyncIterable<AgentEvent> that AgentRuntime.send yields. Lives once so
// backpressure, error propagation and cancellation behave identically.

import type { AgentEvent } from "../core/types.js";

export interface EventChannel {
  push(event: AgentEvent): void;
  /** Record a turn failure (first one wins). Does not close — call close(). */
  fail(error: unknown): void;
  /** Mark the turn done; stream() drains the queue then ends (or throws). */
  close(): void;
  readonly closed: boolean;
  readonly hasError: boolean;
  stream(): AsyncIterable<AgentEvent>;
}

export function createEventChannel(): EventChannel {
  const queue: AgentEvent[] = [];
  let done = false;
  let errored = false;
  let error: unknown;
  let notify: (() => void) | undefined;

  const wake = (): void => {
    notify?.();
    notify = undefined;
  };

  return {
    push(event) {
      queue.push(event);
      wake();
    },
    fail(err) {
      if (!errored) {
        errored = true;
        error = err;
      }
    },
    close() {
      done = true;
      wake();
    },
    get closed() {
      return done;
    },
    get hasError() {
      return errored;
    },
    async *stream() {
      while (!done || queue.length > 0) {
        if (queue.length === 0) {
          await new Promise<void>((resolve) => {
            notify = resolve;
          });
        }
        while (queue.length > 0) {
          const event = queue.shift();
          if (event) yield event;
        }
      }
      if (errored) throw error instanceof Error ? error : new Error(String(error));
    },
  };
}
