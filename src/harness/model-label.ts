// Shared model-label assembly. Every runtime reports a `${provider}/${name}`
// label for the model it runs, with a `(oauth)` suffix when the login is a
// subscription/OAuth one, and a per-harness fallback string when no model is
// configured. The provider/name/fallback are DATA arguments — these helpers
// never branch on the harness id (AGENTS.md §RULE #0).

/**
 * Label for the model the agent is CONFIGURED with, or `fallback` when provider
 * or name is missing. e.g. `anthropic/opus`, else "Claude default".
 */
export function configuredModelLabel(
  model: { provider?: string; name?: string } | undefined,
  fallback: string,
): string {
  const provider = model?.provider;
  const name = model?.name;
  return provider && name ? `${provider}/${name}` : fallback;
}

/**
 * Label for the model a LIVE turn actually used, with a `(oauth)` suffix for
 * subscription/OAuth logins. e.g. `anthropic/claude-opus-4`, or
 * `deepseek/deepseek-chat (oauth)`.
 */
export function liveModelLabel(provider: string, modelId: string, subscription: boolean): string {
  return `${provider}/${modelId}${subscription ? " (oauth)" : ""}`;
}
