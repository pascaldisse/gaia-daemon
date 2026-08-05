import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkCredential, importCredential, normalizeWorkspaceId, readKeymakerState, setRoomWorkspaceBinding } from "../src/services/keymaker.js";

async function withHome<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.GAIA_HOME;
  process.env.GAIA_HOME = await mkdtemp(join(tmpdir(), "gaia-keymaker-"));
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previous;
  }
}

test("Keymaker seeds workspace registry and room bindings", async () => {
  await withHome(async () => {
    const initial = await readKeymakerState();
    assert.deepEqual(initial.workspaces.map((workspace) => workspace.id), ["FENYX", "PERSONAL", "PALOPTIC"]);

    const state = await setRoomWorkspaceBinding("chat-1", "FENYX");
    assert.equal(state.roomBindings["chat-1"], "FENYX");
    assert.equal(state.audit.at(-1)?.action, "workspace.bind-room");
  });
});

test("Keymaker imports credential metadata without exposing a secret value", async () => {
  await withHome(async () => {
    const { credential, state } = await importCredential({ workspaceId: "PALOPTIC", provider: "HubSpot", capability: "CRM Read", account: "ops", scopes: ["crm.objects.contacts.read"] });
    assert.equal(credential.workspaceId, "PALOPTIC");
    assert.equal(credential.provider, "hubspot");
    assert.equal(credential.capability, "crm-read");
    assert.equal(credential.status, "missing");
    assert.equal(credential.secretBackend, "metadata-only");
    assert.equal(JSON.stringify(state).includes("secret-value"), false);

    const checked = await checkCredential(credential.id);
    assert.equal(checked.credential.status, "missing");
    assert.match(checked.credential.failureReason ?? "", /Metadata only/);
  });
});

test("workspace ids normalize conservatively", () => {
  assert.equal(normalizeWorkspaceId("fenyx"), "FENYX");
  assert.equal(normalizeWorkspaceId(" personal "), "PERSONAL");
  assert.equal(normalizeWorkspaceId("work"), undefined);
});
