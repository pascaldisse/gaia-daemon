// Gaia RPG room plugin. Gaia owns durable room state; the copied TTRPG client
// owns every creator/campaign/archetype visual control.
const clean = (value, max = 240) => String(value ?? "").trim().slice(0, max);

function roster(state) {
  return Array.isArray(state?.roster) ? state.roster.filter((entry) => entry && typeof entry === "object") : [];
}

function knownAgent(ctx, id) {
  return ctx.agents.some((agent) => agent.id === id);
}

function panel() {
  return {
    title: "RPG",
    description: "Campaign and character creation run in the copied TTRPG client.",
    embed: { src: "/rpg/index.html", title: "TTRPG campaign and character creator" },
  };
}

export default {
  command: "rpg",
  description: "open the TTRPG campaign and character creator",
  run(args, ctx) {
    const [action, ...values] = args;
    const state = { ...(ctx.state ?? {}), roster: roster(ctx.state) };
    if (!action) return { state, reply: "RPG creator opened in the room panel." };
    if (action === "gm") {
      const agent = clean(values[0], 80);
      if (!knownAgent(ctx, agent)) return { reply: `Unknown GM agent: ${agent}` };
      state.gm = agent;
      return { state, activeAgent: agent, reply: `RPG GM: @${agent}` };
    }
    if (action === "pc") {
      const [name, description, archetype = ""] = values.map((value) => clean(value));
      if (!name) return { reply: "RPG PC needs a name." };
      state.roster = [...roster(state).filter((entry) => !(entry.kind === "PC" && entry.name === name)), { name, description, archetype, kind: "PC", owner: "human" }];
      return { state, reply: `PC ${name} saved from the creator.` };
    }
    if (action === "npc") {
      const [name, agent] = values.map((value) => clean(value, 80));
      if (!name || !knownAgent(ctx, agent)) return { reply: "RPG NPC needs a name and a known agent." };
      state.roster = [...roster(state).filter((entry) => !(entry.kind === "NPC" && entry.name === name)), { name, kind: "NPC", owner: agent }];
      return { state, reply: `NPC ${name} assigned to @${agent}.` };
    }
    return { reply: "Usage: /rpg; /rpg gm <agent>; /rpg npc <name> <agent>." };
  },
  panel,
  prompt(ctx) {
    const state = ctx.state;
    if (!state?.gm || state.gm !== ctx.agentId) return undefined;
    const cast = roster(state).map((member) => `- ${clean(member.kind, 12) || "PC"} ${clean(member.name, 80)}${member.archetype ? ` (${clean(member.archetype, 80)})` : ""}; owner=${clean(member.owner, 80) || "human"}${member.description ? `; ${clean(member.description, 240)}` : ""}`).join("\n") || "(creator has not saved a PC yet)";
    return [
      "# RPG table mode",
      "You are the assigned GM. PCs belong to their listed humans; NPCs belong to their listed agents. Advance play through room chat, preserve player agency, and ask only for needed rolls or choices.",
      "For scene art, invoke the installed imagegen skill. Do not expose private GM reasoning.",
      `GM: @${state.gm}`,
      "Cast:\n" + cast,
    ].join("\n\n");
  },
};
