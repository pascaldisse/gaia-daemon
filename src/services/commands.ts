// Slash-command parsing + @mention routing. Pure functions — no room state,
// no I/O. Handlers live in room-service.ts as a registry keyed by these types.

import type { SlashCommandDefinition } from "../core/types.js";

export type SlashCommand =
  | { type: "help" }
  | { type: "agents" }
  | { type: "roles"; agent?: string }
  | { type: "role"; agent?: string; role?: string }
  | { type: "summon"; agent?: string; task?: string }
  | { type: "thinking"; agent?: string; level?: string }
  | { type: "model"; agent?: string; spec?: string }
  | { type: "clear" }
  | { type: "fork" }
  | { type: "setup"; sub?: string; id?: string; room?: string }
  | { type: "consolidate"; agent?: string }
  | { type: "compact"; agent?: string }
  | { type: "schedule"; sub: "list" | "run"; id?: string }
  | { type: "steer"; text?: string }
  | { type: "cancel" }
  | { type: "recall"; agent?: string; query?: string }
  | { type: "rewind"; count?: string }
  | { type: "thanks-dario"; sub: "on" | "off" | "run" }
  | { type: "unknown"; command: string }
  | { type: "message"; text: string };

export const SLASH_COMMANDS: SlashCommandDefinition[] = [
  { name: "help", type: "help", description: "show command help" },
  { name: "agents", type: "agents", description: "list available agents" },
  { name: "roles", type: "roles", description: "list roles for an agent" },
  { name: "role", type: "role", description: "set or clear an agent role" },
  { name: "summon", type: "summon", description: "summon a private worker agent: /summon <agent> <task>" },
  { name: "thinking", type: "thinking", description: "set thinking effort: /thinking [agent] <level>" },
  { name: "model", type: "model", description: "switch an agent's model: /model [agent] <provider/name> (or 'none' to clear)" },
  { name: "clear", type: "clear", description: "clear this room's history and reset agent sessions" },
  { name: "fork", type: "fork", description: "fork this room into a new branch you can switch to" },
  { name: "setup", type: "setup", description: "load a saved multi-agent setup into this room: /setup activate <id>" },
  { name: "consolidate", type: "consolidate", description: "distill recent episodes into long-term memory: /consolidate [agent]" },
  { name: "compact", type: "compact", description: "compact an agent's session context via its harness: /compact [agent]" },
  { name: "schedule", type: "schedule", description: "list scheduled jobs or run one now: /schedule [run <id>]" },
  { name: "steer", type: "steer", description: "inject guidance into the running turn: /steer <text>" },
  { name: "cancel", type: "cancel", description: "stop the running turn and drop queued messages", aliases: ["stop"] },
  { name: "recall", type: "recall", description: "search memory + room history: /recall [@agent] <query>" },
  { name: "rewind", type: "rewind", description: "undo the last user turn(s) and their replies: /rewind [n]" },
  {
    name: "thanks-dario",
    type: "thanks-dario",
    description: "have Dario review recent messages for safeguard triggers and propose redactions: /thanks-dario [run|on|off]",
    aliases: ["dario"],
  },
];

const COMMAND_BY_NAME = new Map<string, SlashCommandDefinition>(
  SLASH_COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])].map((name) => [name, command] as const)),
);

export function parseCommand(input: string): SlashCommand {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { type: "message", text: input };

  const [name = "", ...args] = trimmed.slice(1).split(/\s+/);
  const command = COMMAND_BY_NAME.get(name);
  if (!command) return { type: "unknown", command: name };

  const stripped = args.map((arg) => arg.replace(/^@/, ""));
  switch (command.type) {
    case "roles":
      return { type: "roles", agent: stripped[0] };
    case "role":
      // "/role matriarch" targets the default agent; "/role ari matriarch" names one.
      return stripped.length >= 2 ? { type: "role", agent: stripped[0], role: stripped[1] } : { type: "role", role: stripped[0] };
    case "summon":
      return { type: "summon", agent: stripped[0] || undefined, task: args.slice(1).join(" ") || undefined };
    case "thinking":
      return stripped.length >= 2 ? { type: "thinking", agent: stripped[0], level: stripped[1] } : { type: "thinking", level: stripped[0] };
    case "model":
      // "/model fable" targets the default agent; "/model nyari fable" names one.
      // The spec keeps its slash intact (provider/name) — split(/\s+/) only breaks on whitespace.
      return stripped.length >= 2 ? { type: "model", agent: stripped[0], spec: stripped[1] } : { type: "model", spec: stripped[0] };
    case "consolidate":
      return { type: "consolidate", agent: stripped[0] || undefined };
    case "compact":
      return { type: "compact", agent: stripped[0] || undefined };
    case "schedule":
      return args[0]?.toLowerCase() === "run" ? { type: "schedule", sub: "run", id: args[1] } : { type: "schedule", sub: "list" };
    case "steer":
      return { type: "steer", text: args.join(" ") || undefined };
    case "recall": {
      // Only an explicit @-prefix names an agent; anything else is the query.
      const hasAgent = args[0]?.startsWith("@") ?? false;
      return {
        type: "recall",
        agent: hasAgent ? stripped[0] : undefined,
        query: args.slice(hasAgent ? 1 : 0).join(" ") || undefined,
      };
    }
    case "rewind":
      return { type: "rewind", count: stripped[0] };
    case "thanks-dario": {
      const sub = args[0]?.toLowerCase();
      return { type: "thanks-dario", sub: sub === "on" || sub === "off" ? sub : "run" };
    }
    case "setup": {
      const sub = args[0]?.toLowerCase();
      if (sub === "activate") return { type: "setup", sub: "activate", id: args[1], room: args[2] };
      if (sub === "status" || sub === "off" || sub === "list") return { type: "setup", sub };
      return { type: "setup", sub: sub ? "unknown" : "list", ...(sub ? { id: args[0] } : {}) };
    }
    default:
      return { type: command.type } as SlashCommand;
  }
}

export const HELP_TEXT = `Commands:\n${SLASH_COMMANDS.map((command) => `  /${command.name.padEnd(8)} ${command.description}`).join(
  "\n",
)}\n\nRole commands:\n  /roles [agent]       list roles (default agent if omitted)\n  /role <role>         set a role on the default agent\n  /role <agent> <role> set a role on a specific agent\n  /role [agent] none   clear a role\n\nSummon commands:\n  /summon <agent> <task>  launch a private worker agent\n\nThinking commands:\n  /thinking <level>          set the default agent's thinking effort\n  /thinking <agent> <level>  set another agent's thinking effort\n  (during a voice call with that agent the change lasts only for the call)\n\nSetup commands:\n  /setup list                list available multi-agent setups\n  /setup activate <id>       load a setup into this room (becomes a monad room)\n  /setup status              show this room's active setup\n  /setup off                 clear the monad from this room\n\nThanks-Dario commands:\n  /thanks-dario              Dario reviews recent messages and proposes redactions (popup shows a diff; originals are preserved)\n  /thanks-dario on|off       auto-review whenever the provider reroutes the model mid-turn\n\nUse @agent mentions to route a message, for example:\n  @sidia critique this plan\n  @gaia @terry compare and implement`;

// --- mention routing -----------------------------------------------------------

const MENTION_PATTERN = /@([a-z0-9_-]+)/gi;

export type RouteResult = { ok: true; targets: string[] } | { ok: false; unknown: string[] };

export function planMentionRoute(message: string, agentIds: string[], defaultAgent: string): RouteResult {
  const known = new Set(agentIds);
  const targets: string[] = [];
  const seen = new Set<string>();
  const unknown: string[] = [];
  const unknownSeen = new Set<string>();

  for (const match of message.matchAll(MENTION_PATTERN)) {
    const id = match[1].toLowerCase();
    if (!known.has(id)) {
      if (!unknownSeen.has(id)) {
        unknown.push(id);
        unknownSeen.add(id);
      }
      continue;
    }
    if (!seen.has(id)) {
      seen.add(id);
      targets.push(id);
    }
  }

  if (unknown.length > 0) return { ok: false, unknown };
  return { ok: true, targets: targets.length > 0 ? targets : [defaultAgent] };
}

export function hasExplicitMention(text: string, agentIds: Set<string>): boolean {
  for (const match of text.matchAll(MENTION_PATTERN)) {
    if (agentIds.has(match[1].toLowerCase())) return true;
  }
  return false;
}
