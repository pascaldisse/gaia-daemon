// The env vars Pi (via @mariozechner/pi-ai) reads as a provider API key. When the
// credential proxy is on, the daemon strips these from the sandboxed child's env:
// otherwise Pi's getApiKey() falls back to the env var (it does so regardless of
// the includeFallback flag) and uses the REAL key directly — bypassing the proxy
// AND leaving the raw key in the sandbox, the exact leak the proxy exists to close.
//
// Mirrors pi-ai's env-api-keys.ts provider→var map. Deliberately EXCLUDES the
// general-purpose git tokens GH_TOKEN / GITHUB_TOKEN (pi maps them for the niche
// github-copilot provider, but they also drive `git push` inside a turn; stripping
// them would break legitimate git use for no proxy benefit on the common providers).
export const PROVIDER_KEY_ENV_VARS: readonly string[] = [
  "ANTHROPIC_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "COPILOT_GITHUB_TOKEN",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "DEEPSEEK_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_CLOUD_API_KEY",
  "GROQ_API_KEY",
  "CEREBRAS_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "AI_GATEWAY_API_KEY",
  "ZAI_API_KEY",
  "MISTRAL_API_KEY",
  "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY",
  "MOONSHOT_API_KEY",
  "HF_TOKEN",
  "FIREWORKS_API_KEY",
  "OPENCODE_API_KEY",
  "KIMI_API_KEY",
  "CLOUDFLARE_API_KEY",
  "XIAOMI_API_KEY",
  "XIAOMI_TOKEN_PLAN_CN_API_KEY",
  "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
  "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
];

/** Delete every known LLM provider key from an env object, in place. Returns it
 *  for chaining. The proxy supplies the one key the turn needs over the wire. */
export function stripProviderKeys(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  for (const name of PROVIDER_KEY_ENV_VARS) delete env[name];
  return env;
}
