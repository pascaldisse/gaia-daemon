// Gaia RPG room plugin. Play happens entirely in this room's chat (the daemon's
// existing routing/roster injection); this plugin only owns two small, transient
// things via the generic panel/forms seam: character creation and GM/NPC
// assignment. No separate app, no iframe, no campaign-selection screen \u2014 the
// "campaign" is just this room's own roster state, carried across turns like
// anything else the room already remembers.
const clean = (value, max = 240) => String(value ?? "").trim().slice(0, max);

function roster(state) {
  return Array.isArray(state?.roster) ? state.roster.filter((entry) => entry && typeof entry === "object") : [];
}

function knownAgent(ctx, id) {
  return ctx.agents.some((agent) => agent.id === id);
}

function agentOptions(ctx) {
  return ctx.agents.map((agent) => ({ value: agent.id, label: `${agent.icon ? `${agent.icon} ` : ""}@${agent.id}` }));
}

// Only present while `open`: a slash command sets it, and every action below
// clears it again on success \u2014 the popup opens, does its one job, and closes
// straight back to chat. Declining to return a panel is what makes it close;
// there is no separate client-side visibility flag to fight with.
function panel(ctx) {
  const state = ctx.state;
  if (!state?.open) return undefined;
  const options = agentOptions(ctx);
  return {
    title: "RPG table",
    description: "Character creation and GM/NPC assignment. Play itself stays in room chat.",
    forms: [
      {
        action: "pc",
        label: "Create character",
        fields: [
          { name: "name", label: "Name", type: "text" },
          { name: "description", label: "Description", type: "text" },
          { name: "archetype", label: "Archetype (optional)", type: "text" },
        ],
      },
      {
        action: "gm",
        label: "Assign GM",
        fields: [{ name: "agent", label: "GM agent", type: "select", options }],
      },
      {
        action: "npc",
        label: "Assign NPC",
        fields: [
          { name: "name", label: "NPC name", type: "text" },
          { name: "agent", label: "Agent", type: "select", options },
        ],
      },
    ],
  };
}

export default {
  command: "rpg",
  description: "open the RPG character/GM/NPC popup for this room",
  run(args, ctx) {
    const [action, ...values] = args;
    const state = { ...(ctx.state ?? {}), roster: roster(ctx.state) };
    if (!action || action === "open") {
      state.open = true;
      return { state, reply: "RPG popup opened." };
    }
    if (action === "close") {
      state.open = false;
      return { state, reply: "RPG popup closed." };
    }
    if (action === "gm") {
      const agent = clean(values[0], 80);
      if (!knownAgent(ctx, agent)) return { reply: `Unknown GM agent: ${agent}` };
      state.gm = agent;
      state.open = false;
      return { state, activeAgent: agent, reply: `RPG GM: @${agent}` };
    }
    if (action === "pc") {
      const [name, description, archetype = ""] = values.map((value) => clean(value));
      if (!name) return { reply: "RPG PC needs a name." };
      state.roster = [...roster(state).filter((entry) => !(entry.kind === "PC" && entry.name === name)), { name, description, archetype, kind: "PC", owner: "human" }];
      state.open = false;
      return { state, reply: `PC ${name} saved.` };
    }
    if (action === "npc") {
      const [name, agent] = values.map((value) => clean(value, 80));
      if (!name || !knownAgent(ctx, agent)) return { reply: "RPG NPC needs a name and a known agent." };
      state.roster = [...roster(state).filter((entry) => !(entry.kind === "NPC" && entry.name === name)), { name, kind: "NPC", owner: agent }];
      state.open = false;
      return { state, reply: `NPC ${name} assigned to @${agent}.` };
    }
    return { reply: "Usage: /rpg; /rpg gm <agent>; /rpg npc <name> <agent>; /rpg close." };
  },
  panel,
  prompt(ctx) {
    const state = ctx.state;
    if (!state?.gm || state.gm !== ctx.agentId) return undefined;
    const cast = roster(state).map((member) => `- ${clean(member.kind, 12) || "PC"} ${clean(member.name, 80)}${member.archetype ? ` (${clean(member.archetype, 80)})` : ""}; owner=${clean(member.owner, 80) || "human"}${member.description ? `; ${clean(member.description, 240)}` : ""}`).join("\n") || "(no PC saved yet)";
    return [
      "# RPG table mode",
      "You are the assigned GM. PCs belong to their listed humans; NPCs belong to their listed agents. Advance play through room chat, preserve player agency, and ask only for needed rolls or choices.",
      "For scene art, invoke the installed imagegen skill. Do not expose private GM reasoning.",
      `GM: @${state.gm}`,
      "Cast:\n" + cast,
    ].join("\n\n");
  },
};
