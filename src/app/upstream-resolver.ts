// Host-side resolution of an agent's REAL upstream + key, for ANY harness. The
// daemon is unsandboxed, so it reads the real cred store here (Pi's multi-provider
// `~/.pi/agent/auth.json`), fetches the key for the agent's model PROVIDER, and
// hands the proxy a concrete UpstreamCredential to inject. The confined turn never
// holds this: it talks to the loopback proxy with only its per-turn token, and the
// real cred store is deny-read inside the sandbox.
//
// This is keyed by the model's PROVIDER, not by harness — every harness flows
// through it unchanged (AGENTS.md §RULE #0). Auth-header SHAPE differs by provider
// wire protocol (anthropic uses x-api-key; OpenAI-compatible uses bearer); that is
// provider data, not a harness special-case.
//
// Returns undefined when there is no resolvable API key (e.g. an OAuth/subscription
// login, or an unconfigured model) — the proxy then refuses the turn rather than
// forwarding without auth (fail-closed; never leak).

import { AuthStorage, ModelRegistry } from "@mariozechner/pi-coding-agent";
import type { AgentDefinition } from "../agents/types.js";
import type { UpstreamCredential } from "./llm-proxy.js";

/** Minimal shapes used here, so tests can inject fakes without standing up the SDK. */
export interface UpstreamResolverDeps {
  authStorage?: { getApiKey(providerId: string): Promise<string | undefined> };
  registry?: { find(provider: string, modelId: string): { baseUrl?: string } | undefined };
}

/** Auth headers to present to the upstream, by provider wire protocol (provider data). */
function authHeadersFor(provider: string, key: string): Record<string, string> {
  if (provider === "anthropic") return { "x-api-key": key };
  return { authorization: `Bearer ${key}` };
}

export async function resolveUpstreamCredential(
  agent: AgentDefinition,
  deps: UpstreamResolverDeps = {},
): Promise<UpstreamCredential | undefined> {
  const provider = agent.model?.provider;
  const name = agent.model?.name;
  if (!provider || !name) return undefined;

  const authStorage = deps.authStorage ?? AuthStorage.create();
  const registry = deps.registry ?? ModelRegistry.create(authStorage as AuthStorage);
  const model = registry.find(provider, name);
  if (!model?.baseUrl) return undefined; // unknown model → can't pick an upstream

  const key = await authStorage.getApiKey(provider);
  if (!key) return undefined; // OAuth/subscription/unconfigured → refuse rather than leak

  return { baseUrl: model.baseUrl, authHeaders: authHeadersFor(provider, key) };
}
