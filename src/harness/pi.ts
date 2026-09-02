// Pi harness registration: data + runtime assembly only.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { registerBunOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { gaiaHome } from "../core/paths.js";
import type { UsageProbeResult } from "../core/types.js";
import { registerHarness } from "./spec.js";
import { emailFromJwt, expiryMsFromJwt, fetchAnthropicUsage, fetchChatGptUsage } from "./usage.js";
import { hasPersistedPiSession, PI_CAPABILITIES, PiRuntime } from "./pi/session.js";
export { PiRuntime, mechanicalCompactionFallback, piRoomSessionDir } from "./pi/session.js";
export type { PiRuntimeOptions, PiRuntimeSessionFactory, PiRuntimeSessionFactoryOptions, PiSessionLike } from "./pi/session.js";
export { redirectProviderFetch, rewriteProviderUrl } from "./pi/tools.js";
registerBunOAuthFlows();
function realPiAuthJson(): string { return join(homedir(), ".pi", "agent", "auth.json"); }
async function probePiUsage(provider: "anthropic" | "openai-codex"): Promise<UsageProbeResult> {
  let cred: { type?: string; accountId?: unknown } | undefined; let token: string | undefined;
  try { cred = readStoredCredential(provider); if (!cred || cred.type !== "oauth") return { status: "none" }; const runtime = await ModelRuntime.create(); token = (await runtime.getAuth(provider))?.auth.apiKey; } catch { return { status: "error" }; }
  return token ? provider === "anthropic" ? fetchAnthropicUsage(token) : fetchChatGptUsage(token, typeof cred.accountId === "string" ? cred.accountId : undefined) : { status: "error" };
}
async function probePiAccountUsage(credentials: Record<string, string>): Promise<UsageProbeResult> { return credentials.oauthToken ? fetchAnthropicUsage(credentials.oauthToken) : credentials.accessToken ? fetchChatGptUsage(credentials.accessToken, credentials.accountId) : { status: "none" }; }
function materializePiAgentDir(credentials: Record<string, string>): string {
  const source = credentials.accountId?.trim() || credentials.refreshToken || credentials.oauthToken || credentials.accessToken || ""; const dir = join(gaiaHome(), "pi-accounts", createHash("sha256").update(source).digest("hex").slice(0, 16)); mkdirSync(dir, { recursive: true });
  const modelsSrc = join(homedir(), ".pi", "agent", "models.json"); const modelsDst = join(dir, "models.json"); if (existsSync(modelsSrc) && !existsSync(modelsDst)) copyFileSync(modelsSrc, modelsDst);
  const authPath = join(dir, "auth.json"); const entry = { type: "oauth", refresh: credentials.refreshToken ?? "", access: credentials.oauthToken ?? credentials.accessToken ?? "", expires: expiryMsFromJwt(credentials.oauthToken ?? credentials.accessToken), ...(!credentials.oauthToken && credentials.accountId ? { accountId: credentials.accountId } : {}) }; const provider = credentials.oauthToken ? "anthropic" : "openai-codex";
  let existing: Record<string, { access?: string }> = {}; try { existing = JSON.parse(readFileSync(authPath, "utf8")) as typeof existing; } catch {}
  if (!existing[provider]?.access || entry.expires > expiryMsFromJwt(existing[provider].access)) writeFileSync(authPath, JSON.stringify({ ...existing, [provider]: entry }, null, 2) + "\n", { mode: 0o600 }); return dir;
}
registerHarness({
  id: "pi",
  capabilities: PI_CAPABILITIES,
  transientAuthPatterns: [/not logged in/i, /token .*expired/i, /re-?authenticat/i, /\bunauthorized\b/i],
  ui: { label: "pi", description: "Pi coding agent (local SDK)" },
  create: (ctx) => new PiRuntime(ctx),
  // Pi self-persists sessions as files under the room's pi-sessions/<agent>/
  // dir (SessionManager.continueRecent resumes the most recent one). Any file
  // there means the conversation behind the cursor is resumable; an empty or
  // missing dir means a fresh session — its history must be replayed.
  hasDurableSession: (rootDir, roomId, agentId) => hasPersistedPiSession(rootDir, roomId, agentId),
  // Legacy account ownership normalizes to Pi. RunnerHost applies this before
  // credential-proxy stripping, so bound OAuth credentials remain isolated.
  accounts: {
    label: "Pi OAuth account",
    fields: [
      { key: "accessToken", label: "ChatGPT access token", secret: true, hint: "~/.pi/agent/auth.json → openai-codex.access" },
      { key: "refreshToken", label: "Refresh token", secret: true, hint: "~/.pi/agent/auth.json → provider refresh" },
      { key: "accountId", label: "ChatGPT account ID", hint: "~/.pi/agent/auth.json → openai-codex.accountId" },
      { key: "oauthToken", label: "Anthropic OAuth token", secret: true, hint: "Legacy Claude account records use this field and load as Pi Anthropic OAuth accounts." },
    ],
    env: (credentials) => ({ PI_CODING_AGENT_DIR: materializePiAgentDir(credentials) }),
    email: (credentials) => emailFromJwt(credentials.oauthToken ?? credentials.accessToken),
  },
  // Pi's proxy wiring (the in-process fetch redirect lives in applyCredentialProxy):
  // relocate its agent dir to an empty store so AuthStorage resolves no real key
  // (the token registered against the proxy is then what reaches the wire), and
  // deny-read the real store. The runner sets GAIA_LLM_PROXY_URL uniformly.
  credentialProxy: ({ scratchDir }) => {
    const authJson = join(scratchDir, "auth.json");
    if (!existsSync(authJson)) writeFileSync(authJson, "{}\n");
    return { env: { PI_CODING_AGENT_DIR: scratchDir }, denyRead: [realPiAuthJson()] };
  },
  // Pi keeps session + model state under ~/.pi (a sandboxed turn deadlocks if
  // denied writes there); its credential store inside that tree is carved back
  // to read-only so a confined turn can't tamper with the key it can read.
  sandboxPaths: { writable: ["~/.pi", join(gaiaHome(), "pi-accounts")], readonly: ["~/.pi/agent/auth.json"] },
  usageAccounts: (accounts) => [
    { account: "ambient:pi:anthropic", probe: () => probePiUsage("anthropic") },
    { account: "ambient:pi", probe: () => probePiUsage("openai-codex") },
    ...accounts.map((account) => ({ account: account.id, probe: () => probePiAccountUsage(account.credentials) })),
  ],
  ambientUsageAccount: (agent) => (agent.model?.provider === "anthropic" ? "ambient:pi:anthropic" : "ambient:pi"),
});
