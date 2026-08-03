import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../plugins/rpg.mjs";

const ctx = {
  homedir: "/tmp/gaia",
  roomId: "rpg-proof",
  workspaceRoot: "/tmp/workspace",
  agents: [{ id: "gm", displayName: "Game Master", icon: "🎲" }, { id: "npc", displayName: "NPC", icon: "🗡️" }],
};

test("rpg plugin projects the copied creator and durably maps GM, PC, and NPC roles", async () => {
  const opened = await plugin.run([], ctx);
  const gm = await plugin.run(["gm", "gm"], { ...ctx, state: opened.state });
  assert.equal(gm.activeAgent, "gm");
  const pc = await plugin.run(["pc", "Ada", "swift scout", "repo-man"], { ...ctx, state: gm.state });
  const npc = await plugin.run(["npc", "Mira", "npc"], { ...ctx, state: pc.state });
  assert.equal(npc.state?.gm, "gm");
  assert.deepEqual(npc.state?.roster, [
    { name: "Ada", description: "swift scout", archetype: "repo-man", kind: "PC", owner: "human" },
    { name: "Mira", kind: "NPC", owner: "npc" },
  ]);
  const panel = await plugin.panel?.({ ...ctx, state: npc.state });
  assert.deepEqual(panel?.embed, { src: "/rpg/index.html", title: "TTRPG campaign and character creator" });
  assert.match((await plugin.prompt?.({ ...ctx, state: npc.state, agentId: "gm" })) ?? "", /NPC Mira; owner=npc/);
  assert.equal(await plugin.prompt?.({ ...ctx, state: npc.state, agentId: "npc" }), undefined);
});
