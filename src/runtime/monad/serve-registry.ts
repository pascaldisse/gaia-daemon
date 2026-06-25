// The "answer as one" seam. A ServeAdapter exposes a monad room over some wire
// protocol (e.g. an OpenAI-compatible /v1/chat/completions endpoint), turning the
// whole loop into a single endpoint: a request's last user message runs through
// MonadEngine.run and the one final answer comes back. Same self-registering
// shape as the policy/harness registries — core defines the seam and the `gaia
// serve` command; a concrete adapter (OpenAI-compatible) can be a plugin.

import type { ChatMessage } from "./types.js";

export interface ServeHandle {
  url: string;
  stop(): Promise<void>;
}

export interface ServeStartOptions {
  host: string;
  port: number;
  /** Run the monad over a request's messages; resolves the single final answer. */
  run: (messages: ChatMessage[]) => Promise<string>;
}

export interface ServeAdapter {
  id: string;
  ui?: { label: string; description: string };
  start(options: ServeStartOptions): Promise<ServeHandle>;
}

const registry = new Map<string, ServeAdapter>();

export function registerServeAdapter(adapter: ServeAdapter): void {
  registry.set(adapter.id, adapter);
}

export function serveAdapterIds(): string[] {
  return [...registry.keys()];
}

export function findServeAdapter(id: string): ServeAdapter | undefined {
  return registry.get(id);
}

export function serveAdapterFor(id: string): ServeAdapter {
  const adapter = registry.get(id);
  if (!adapter) throw new Error(`Unsupported serve adapter: ${id}`);
  return adapter;
}
