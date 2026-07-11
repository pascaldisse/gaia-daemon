import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findHarness } from "../src/harness/spec.js";
import { stripAnsi } from "../src/services/account-login.js";
import "../src/harness/claude.js"; // side-effect: registers the claude spec
import "../src/harness/codex.js"; // side-effect: registers the codex spec
import "../src/harness/pi.js"; // side-effect: registers the pi spec

function withGaiaHome(fn: (home: string) => void): void {
  const previous = process.env.GAIA_HOME;
  process.env.GAIA_HOME = mkdtempSync(join(tmpdir(), "gaia-login-test-"));
  try {
    fn(process.env.GAIA_HOME);
  } finally {
    if (previous === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previous;
  }
}

test("stripAnsi: strips CSI color codes without eating adjacent literal `]` text", () => {
  // Regression: codex's own first output line is "Welcome to Codex [v0.144.1]"
  // — a bare `]` with no preceding ESC byte. The old (ESC-less) OSC pattern's
  // `[^]*` treated that `]` as an OSC opener and greedily ate everything after
  // it for the rest of the session, so the sign-in URL + device code never
  // survived stripping and the login flow hung at "starting" forever.
  const raw = "Welcome to Codex [v\x1b[90m0.144.1\x1b[0m]\r\n\x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\r\n   \x1b[94m08R6-8O59Y\x1b[0m\r\n";
  const out = stripAnsi(raw);
  assert.equal(out, "Welcome to Codex [v0.144.1]\r\nhttps://auth.openai.com/codex/device\r\n   08R6-8O59Y\r\n");
});

test("stripAnsi: strips an OSC hyperlink sequence (ESC ] ... BEL)", () => {
  const raw = "before \x1b]8;;https://example.com\x07link text\x1b]8;;\x07 after";
  assert.equal(stripAnsi(raw), "before link text after");
});

const login = findHarness("claude")?.accounts?.login;

test("claude login: signInUrl lifts the OAuth URL", () => {
  assert.ok(login);
  const url = "https://claude.com/cai/oauth/authorize?code=1&scope=x";
  const out = `Browser didn't open? Use the url below...\n${url}\nPaste code here if prompted >`;
  assert.equal(login.signInUrl(out), url);
});

test("claude login: awaitingInput detects the paste prompt", () => {
  assert.ok(login);
  assert.equal(login.awaitingInput("...Pastecodehereifprompted>"), true);
  assert.equal(login.awaitingInput("Opening browser"), false);
});

test("claude login: credentials from the printed token", () => {
  assert.ok(login);
  const token = "sk-ant-oat01-" + "A".repeat(40);
  assert.deepEqual(login.credentials({ output: `your token:\n${token}`, configDir: "/nonexistent" }), {
    oauthToken: token,
  });
});

test("claude login: credentials from the config-dir fallback file", () => {
  assert.ok(login);
  const dir = mkdtempSync(join(tmpdir(), "gaia-login-cfg-"));
  const stored = "sk-ant-oat01-FROMFILE0000000000000000";
  writeFileSync(join(dir, ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: stored } }));
  assert.deepEqual(login.credentials({ output: "no token in output", configDir: dir }), { oauthToken: stored });
});

const codexLogin = findHarness("codex")?.accounts?.login;

test("codex login: signInUrl lifts the device-auth URL", () => {
  assert.ok(codexLogin);
  const out = "1. Open this link in your browser and sign in to your account\n   https://auth.openai.com/codex/device\n\n2. Enter this one-time code (expires in 15 minutes)\n   05Z1-FEOPR\n";
  assert.equal(codexLogin.signInUrl(out), "https://auth.openai.com/codex/device");
});

test("codex login: code lifts the one-time device code", () => {
  assert.ok(codexLogin);
  assert.ok(codexLogin.code);
  const out = "Enter this one-time code (expires in 15 minutes)\n   05Z1-FEOPR\n";
  assert.equal(codexLogin.code(out), "05Z1-FEOPR");
});

test("codex login: browser-flow output — URL lifted, no false code from the URL itself", () => {
  assert.ok(codexLogin);
  assert.ok(codexLogin.code);
  const out = "Starting local login server on http://localhost:1455.\nIf your browser did not open, navigate to this URL to authenticate:\nhttps://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&state=ABCD-EFGH123\n";
  assert.equal(codexLogin.signInUrl(out), "https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&state=ABCD-EFGH123");
  assert.equal(codexLogin.code(out), undefined);
});

test("codex login: real raw codex output survives stripAnsi + extractors end-to-end", () => {
  // The actual bytes `codex login --device-auth` writes to its pty (captured
  // live) — pins the full pipeline stripAnsi() -> signInUrl()/code() together,
  // not just the extractors against already-clean text.
  assert.ok(codexLogin);
  const raw =
    "\r\nWelcome to Codex [v\x1b[90m0.144.1\x1b[0m]\r\n\x1b[90mOpenAI's command-line coding agent\x1b[0m\r\n\r\n" +
    "Follow these steps to sign in with ChatGPT using device code authorization:\r\n\r\n" +
    "1. Open this link in your browser and sign in to your account\r\n   \x1b[94mhttps://auth.openai.com/codex/device\x1b[0m\r\n\r\n" +
    "2. Enter this one-time code \x1b[90m(expires in 15 minutes)\x1b[0m\r\n   \x1b[94m08R6-8O59Y\x1b[0m\r\n\r\n" +
    "\x1b[90mContinue only if you started this login in Codex. If a website or another person gave you this code, cancel.\x1b[0m\r\n";
  const clean = stripAnsi(raw);
  assert.equal(codexLogin.signInUrl(clean), "https://auth.openai.com/codex/device");
  assert.equal(codexLogin.code?.(clean), "08R6-8O59Y");
});

test("codex login: awaitingInput is always false — nothing is ever pasted back", () => {
  assert.ok(codexLogin);
  assert.equal(codexLogin.awaitingInput("Enter this one-time code\n05Z1-FEOPR"), false);
  assert.equal(codexLogin.awaitingInput(""), false);
});

test("codex login: credentials from the config-dir auth.json codex itself writes", () => {
  assert.ok(codexLogin);
  const dir = mkdtempSync(join(tmpdir(), "gaia-login-codex-"));
  writeFileSync(
    join(dir, "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", OPENAI_API_KEY: null, tokens: { id_token: "id1", access_token: "at1", refresh_token: "rt1", account_id: "acct1" } }),
  );
  assert.deepEqual(codexLogin.credentials({ output: "Successfully logged in", configDir: dir }), {
    idToken: "id1",
    accessToken: "at1",
    refreshToken: "rt1",
    accountId: "acct1",
  });
});

test("codex login: credentials undefined before auth.json exists (still polling)", () => {
  assert.ok(codexLogin);
  assert.equal(codexLogin.credentials({ output: "waiting...", configDir: "/nonexistent" }), undefined);
});

test("codex accounts.env: materializes CODEX_HOME/auth.json from the stored bag", () => {
  withGaiaHome(() => {
    const env = findHarness("codex")?.accounts?.env;
    assert.ok(env);
    const result = env({ idToken: "id1", accessToken: "at1", refreshToken: "rt1", accountId: "acct1" });
    assert.ok(result.CODEX_HOME);
    const written = JSON.parse(readFileSync(join(result.CODEX_HOME, "auth.json"), "utf8"));
    assert.equal(written.tokens.access_token, "at1");
    assert.equal(written.tokens.refresh_token, "rt1");
    assert.equal(written.tokens.account_id, "acct1");
  });
});

test("codex accounts.env: never stomps a live-refreshed file with the SAME stored refresh_token", () => {
  withGaiaHome(() => {
    const env = findHarness("codex")?.accounts?.env;
    assert.ok(env);
    const creds = { idToken: "id1", accessToken: "at1", refreshToken: "rt1", accountId: "acct1" };
    const dir = env(creds).CODEX_HOME!;
    // Simulate codex's own in-place refresh of access_token, keeping the same refresh_token.
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "REFRESHED", refresh_token: "rt1", account_id: "acct1" } }));
    const again = env(creds).CODEX_HOME!;
    assert.equal(again, dir);
    const stillThere = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
    assert.equal(stillThere.tokens.access_token, "REFRESHED", "a later spawn must not overwrite codex's own refreshed token");
  });
});

test("codex accounts.env: re-materializes once the stored refresh_token actually changes", () => {
  withGaiaHome(() => {
    const env = findHarness("codex")?.accounts?.env;
    assert.ok(env);
    env({ idToken: "id1", accessToken: "at1", refreshToken: "rt1", accountId: "acct1" });
    const dir = env({ idToken: "id2", accessToken: "at2", refreshToken: "rt2", accountId: "acct1" }).CODEX_HOME!;
    const written = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
    assert.equal(written.tokens.access_token, "at2");
    assert.equal(written.tokens.refresh_token, "rt2");
  });
});

test("pi accounts: env materializes an isolated PI_CODING_AGENT_DIR", () => {
  withGaiaHome(() => {
    const env = findHarness("pi")?.accounts?.env;
    assert.ok(env);
    const result = env({ accessToken: "at1", refreshToken: "rt1", accountId: "acct1" });
    assert.ok(result.PI_CODING_AGENT_DIR);
    const written = JSON.parse(readFileSync(join(result.PI_CODING_AGENT_DIR, "auth.json"), "utf8"));
    assert.deepEqual(written, {
      "openai-codex": { type: "oauth", refresh: "rt1", access: "at1", expires: 0, accountId: "acct1" },
    });
  });
});

test("pi accounts: unchanged refresh token does not rewrite auth.json", () => {
  withGaiaHome(() => {
    const env = findHarness("pi")?.accounts?.env;
    assert.ok(env);
    const creds = { accessToken: "at1", refreshToken: "rt1", accountId: "acct1" };
    const dir = env(creds).PI_CODING_AGENT_DIR!;
    // Simulate pi's own in-place refresh of the access token, keeping the same refresh token.
    writeFileSync(join(dir, "auth.json"), JSON.stringify({ "openai-codex": { type: "oauth", refresh: "rt1", access: "REFRESHED", expires: 0, accountId: "acct1" } }));
    const again = env(creds).PI_CODING_AGENT_DIR!;
    assert.equal(again, dir);
    const stillThere = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
    assert.equal(stillThere["openai-codex"].access, "REFRESHED", "a later spawn must not overwrite pi's own refreshed token");
  });
});

test("pi accounts: changed refresh token re-materializes auth.json", () => {
  withGaiaHome(() => {
    const env = findHarness("pi")?.accounts?.env;
    assert.ok(env);
    env({ accessToken: "at1", refreshToken: "rt1", accountId: "acct1" });
    const dir = env({ accessToken: "at2", refreshToken: "rt2", accountId: "acct1" }).PI_CODING_AGENT_DIR!;
    const written = JSON.parse(readFileSync(join(dir, "auth.json"), "utf8"));
    assert.deepEqual(written, {
      "openai-codex": { type: "oauth", refresh: "rt2", access: "at2", expires: 0, accountId: "acct1" },
    });
  });
});

test("addAccount / listAccounts round-trip + duplicate throws", async () => {
  const { addAccount, listAccounts } = await import("../src/domain/accounts.js");
  withGaiaHome(() => {
    addAccount({ id: "work", harness: "claude", label: "Work", credentials: { oauthToken: "sk-ant-oat01-z" } });
    assert.equal(listAccounts().find((a) => a.id === "work")?.credentials.oauthToken, "sk-ant-oat01-z");
    assert.throws(() => addAccount({ id: "work", harness: "claude", credentials: {} }), /already exists/);
  });
});

test("removeAccount true then false", async () => {
  const { addAccount, removeAccount } = await import("../src/domain/accounts.js");
  withGaiaHome(() => {
    addAccount({ id: "gone", harness: "claude", credentials: {} });
    assert.equal(removeAccount("gone"), true);
    assert.equal(removeAccount("gone"), false);
  });
});

test("newAccountId: label slug, then next free id, then harness-2", async () => {
  const { addAccount, newAccountId } = await import("../src/domain/accounts.js");
  withGaiaHome(() => {
    assert.equal(newAccountId("claude", "Work Account"), "work-account");
    addAccount({ id: "work-account", harness: "claude", credentials: {} });
    assert.notEqual(newAccountId("claude", "Work Account"), "work-account");
    assert.equal(newAccountId("claude"), "claude-2");
  });
});
