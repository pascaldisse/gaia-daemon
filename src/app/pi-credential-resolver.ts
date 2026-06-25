// Host-side resolution of a pi-harness agent's REAL upstream + key. The daemon is
// unsandboxed, so it reads the real `~/.pi/agent/auth.json` here, fetches the key,
// and hands the proxy a concrete UpstreamCredential to inject. The confined turn
// never holds this: it talks to the loopback proxy with only its per-turn token,
// and the real cred store is deny-read inside the sandbox.
//
// Returns undefined when there is no resolvable API key (e.g. an OAuth-only
// provider, or an unconfigured model) — the proxy then refuses the turn rather
// than forwarding without auth (fail-closed; never leak).

import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { AgentDefinition } from "../agents/types.js";
import type { UpstreamCredential } from "./llm-proxy.js";

/** Minimal shapes used here, so tests can inject fakes without standing up the SDK. */
export interface PiResolverDeps {
  authStorage?: { getApiKey(providerId: string): Promise<string | undefined> };
  registry?: { find(provider: string, modelId: string): { baseUrl?: string } | undefined };
}

export async function resolvePiUpstream(agent: AgentDefinition, deps: PiResolverDeps = {}): Promise<UpstreamCredential | undefined> {
  const provider = agent.model?.provider;
  const name = agent.model?.name;
  if (!provider || !name) return undefined;

  const authStorage = deps.authStorage ?? AuthStorage.create();
  const registry = deps.registry ?? ModelRegistry.create(authStorage as AuthStorage);
  const model = registry.find(provider, name);
  if (!model?.baseUrl) return undefined; // unknown model → can't pick an upstream

  const key = await authStorage.getApiKey(provider);
  if (!key) return undefined; // OAuth-only / unconfigured → refuse rather than leak

  // pi's providers are OpenAI-compatible (bearer auth); claude/codex get their own
  // resolver when they're wired (anthropic uses x-api-key).
  return { baseUrl: model.baseUrl, authHeaders: { authorization: `Bearer ${key}` } };
}
