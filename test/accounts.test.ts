import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { accountsPath, ensureAccountsFile, findAccount, listAccounts, redactedAccounts, updateAccount } from "../src/domain/accounts.js";

function withGaiaHome(fn: (home: string) => void): void {
  const previous = process.env.GAIA_HOME;
  process.env.GAIA_HOME = mkdtempSync(join(tmpdir(), "gaia-accounts-test-"));
  try {
    fn(process.env.GAIA_HOME);
  } finally {
    if (previous === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previous;
  }
}

test("missing file lists no accounts", () => {
  withGaiaHome(() => {
    assert.deepEqual(listAccounts(), []);
  });
});

test("ensureAccountsFile seeds once", () => {
  withGaiaHome(() => {
    ensureAccountsFile();
    assert.equal(existsSync(accountsPath()), true);
    assert.deepEqual(JSON.parse(readFileSync(accountsPath(), "utf8")), { accounts: [] });

    writeFileSync(accountsPath(), "marker");
    ensureAccountsFile();
    assert.equal(readFileSync(accountsPath(), "utf8"), "marker");
  });
});

test("records round-trip + filtering", () => {
  withGaiaHome(() => {
    writeFileSync(
      accountsPath(),
      JSON.stringify({
        accounts: [
          { id: "a1", harness: "claude", label: "Second", credentials: { oauthToken: "sk-ant-oat01-x" } },
          { foo: 1 },
        ],
      }),
    );

    assert.deepEqual(listAccounts(), [
      { id: "a1", harness: "claude", label: "Second", credentials: { oauthToken: "sk-ant-oat01-x" } },
    ]);
    assert.equal(findAccount("a1")?.credentials.oauthToken, "sk-ant-oat01-x");
    assert.equal(findAccount("nope"), undefined);
  });
});

test("malformed file throws", () => {
  withGaiaHome(() => {
    writeFileSync(accountsPath(), "not json");
    assert.throws(() => listAccounts());
  });
});

test("display metadata can be updated without exposing credentials", () => {
  withGaiaHome(() => {
    writeFileSync(accountsPath(), JSON.stringify({ accounts: [{ id: "a1", harness: "claude", credentials: { oauthToken: "secret" } }] }));
    assert.deepEqual(updateAccount("a1", { label: "Personal", email: "me@example.com" }), {
      id: "a1",
      harness: "claude",
      label: "Personal",
      email: "me@example.com",
      credentials: { oauthToken: "secret" },
    });
    assert.deepEqual(redactedAccounts(), [{ id: "a1", harness: "claude", label: "Personal", email: "me@example.com" }]);
    assert.equal(updateAccount("missing", { label: "Nope" }), undefined);
  });
});
