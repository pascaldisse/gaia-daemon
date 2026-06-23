import type { AgentEvent } from "./types.js";

/**
 * The push/queue/notify bridge between a callback-style streaming source (a Pi
 * session subscription, a Claude NDJSON reader, a Codex JSON-RPC notification
 * handler) and the `AsyncIterable<AgentEvent>` that `AgentRuntime.send` yields.
 *
 * Every harness produced this same ~25-line scaffold by hand; it lives here
 * once so backpressure, error propagation and cancellation behave identically
 * across all of them. A runtime now only wires its source's callbacks to
 * `push` / `fail` / `close` and yields from `stream()`.
 */
export interface EventChannel {
  /** Enqueue an event for the consumer and wake a waiting `stream()`. */
  push(event: AgentEvent): void;
  /** Record a turn failure (first one wins). Does not close — call `close()`. */
  fail(error: unknown): void;
  /** Mark the turn done; `stream()` drains the queue then ends (or throws). */
  close(): void;
  /** True once `close()` has been called. */
  readonly closed: boolean;
  /** True once `fail()` has recorded an error. */
  readonly hasError: boolean;
  /** Drains queued events until closed, then throws any recorded error. */
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
