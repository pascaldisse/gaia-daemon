// Shared model-label formatting, used by both the right panel and the composer
// so the two never drift. Kept harness-agnostic: it operates on the label string
// the daemon reports, never on a provider/harness id.

/**
 * Drop the provider prefix from a model label — "deepseek/deepseek-v4-pro" →
 * "deepseek-v4-pro", "anthropic/claude-opus-4-8 (oauth)" → "claude-opus-4-8
 * (oauth)". The model id alone is enough to identify it; the full label (with
 * provider) stays available in the surrounding element's title/tooltip.
 * @param {string} label
 */
export function shortModel(label) {
  const slash = label.lastIndexOf("/");
  return slash >= 0 ? label.slice(slash + 1) : label;
}
