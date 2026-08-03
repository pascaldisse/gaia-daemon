import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../plugins/rpg.mjs";

const ctx = {
  homedir: "/tmp/gaia",
  roomId: "rpg-proof",
  workspaceRoot: "/tmp/workspace",
  agents: [{ id: "gm", displayName: "Game Master", icon: "🎲" }, { id: "npc", displayName: "NPC", icon: "🗡️" }],
};

test("rpg plugin opens/closes a transient forms popup and durably maps GM, PC, and NPC roles", async () => {
  const opened = await plugin.run([], ctx);
  assert.equal(opened.state?.open, true);
  const openPanel = await plugin.panel?.({ ...ctx, state: opened.state });
  assert.ok(openPanel?.forms?.length, "panel projects forms while open");
  assert.equal(openPanel?.embed, undefined, "no iframe embed is ever declared");

  const gm = await plugin.run(["gm", "gm"], { ...ctx, state: opened.state });
  assert.equal(gm.activeAgent, "gm");
  assert.equal(gm.state?.open, false, "a completed action closes the popup");
  assert.equal(await plugin.panel?.({ ...ctx, state: gm.state }), undefined, "closed state projects no panel");

  // Reopen for the next action, as the client would via `/rpg`.
  const reopened = await plugin.run([], { ...ctx, state: gm.state });
  const pc = await plugin.run(["pc", "Ada", "swift scout", "repo-man"], { ...ctx, state: reopened.state });
  assert.equal(pc.state?.open, false);
  const npc = await plugin.run(["npc", "Mira", "npc"], { ...ctx, state: pc.state });
  assert.equal(npc.state?.gm, "gm");
  assert.deepEqual(npc.state?.roster, [
    { name: "Ada", description: "swift scout", archetype: "repo-man", kind: "PC", owner: "human" },
    { name: "Mira", kind: "NPC", owner: "npc" },
  ]);
  assert.match((await plugin.prompt?.({ ...ctx, state: npc.state, agentId: "gm" })) ?? "", /NPC Mira; owner=npc/);
  assert.equal(await plugin.prompt?.({ ...ctx, state: npc.state, agentId: "npc" }), undefined);
});

test("rpg plugin's explicit close action clears the popup without touching roster", async () => {
  const opened = await plugin.run([], ctx);
  const closed = await plugin.run(["close"], { ...ctx, state: opened.state });
  assert.equal(closed.state?.open, false);
  assert.equal(await plugin.panel?.({ ...ctx, state: closed.state }), undefined);
});
