import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findHarness } from "../src/harness/spec.js";
import "../src/harness/claude.js"; // side-effect: registers the claude spec

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
