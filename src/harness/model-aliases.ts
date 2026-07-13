// Claude Code's own model aliases (fable/opus/sonnet/haiku) mean "latest of
// this tier" and are understood only by the `claude` CLI itself, passed
// verbatim as --model. A caller that talks to a model DIRECTLY through pi-ai
// (bypassing the CLI — e.g. the pi harness runtime, or the daemon's
// consolidation/dream LLM reusing an agent's configured model) needs a real
// pi-ai registry id instead. This table is that one translation, shared as
// data (RULE #0) instead of duplicated per harness — kept current by hand as
// pi-ai's bundled registry adds newer dated snapshots under each tier.
const API_MODEL_ID_ALIASES: Record<string, string> = {
  fable: "claude-fable-5",
  opus: "claude-opus-4-8",
  sonnet: "claude-sonnet-5",
  haiku: "claude-haiku-4-5",
};

export function resolveApiModelAlias(name: string): string {
  return API_MODEL_ID_ALIASES[name] ?? name;
}

// Registry lookup with transparent alias fallback: try the configured name
// as-is, then its canonical id. Every direct-to-pi-ai call site that bypasses
// the harness CLI (pi runtime resolveModel, oauth base-url, credential proxy,
// daemon consolidation/dream LLM) goes through this ONE place (RULE #0) —
// never re-inline `find(name) ?? find(alias(name))`. Generic over the model
// type so it needs no ModelRegistry import.
export function findModelWithAlias<M>(
  registry: { find(provider: string, name: string): M | undefined },
  provider: string,
  name: string,
): M | undefined {
  return registry.find(provider, name) ?? registry.find(provider, resolveApiModelAlias(name));
}
