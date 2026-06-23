export type SlashCommandType = "help" | "agents" | "roles" | "role" | "summon" | "thinking";

export interface SlashCommandDefinition {
  name: string;
  type: SlashCommandType;
  description: string;
  aliases?: string[];
}

export type SlashCommand =
  | { type: "help" }
  | { type: "agents" }
  | { type: "roles"; agent?: string }
  | { type: "role"; agent?: string; role?: string }
  | { type: "summon"; agent?: string; task?: string }
  | { type: "thinking"; agent?: string; level?: string }
  | { type: "unknown"; command: string }
  | { type: "message"; text: string };

export const SLASH_COMMANDS: SlashCommandDefinition[] = [
  { name: "help", type: "help", description: "show command help" },
  { name: "agents", type: "agents", description: "list available agents" },
  { name: "roles", type: "roles", description: "list roles for an agent" },
  { name: "role", type: "role", description: "set or clear an agent role" },
  { name: "summon", type: "summon", description: "summon a private worker agent: /summon <agent> <task>" },
  { name: "thinking", type: "thinking", description: "set thinking effort: /thinking [agent] <level>" },
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

  if (command.type === "roles") return { type: "roles", agent: args[0]?.replace(/^@/, "") };
  if (command.type === "role") {
    // "/role matriarch" targets the default agent; "/role ari matriarch"
    // (with or without @) names one explicitly. Mirrors /thinking.
    const stripped = args.map((arg) => arg.replace(/^@/, ""));
    if (stripped.length >= 2) return { type: "role", agent: stripped[0], role: stripped[1] };
    return { type: "role", role: stripped[0] };
  }
  if (command.type === "summon") {
    const agent = args[0];
    const task = args.slice(1).join(" ");
    return { type: "summon", agent: agent || undefined, task: task || undefined };
  }
  if (command.type === "thinking") {
    // "/thinking high" targets the default agent; "/thinking gaia high"
    // (with or without @) names one explicitly.
    const stripped = args.map((arg) => arg.replace(/^@/, ""));
    if (stripped.length >= 2) return { type: "thinking", agent: stripped[0], level: stripped[1] };
    return { type: "thinking", level: stripped[0] };
  }

  return { type: command.type };
}

export const HELP_TEXT = `Commands:\n${SLASH_COMMANDS.map(
  (command) => `  /${command.name.padEnd(8)} ${command.description}`,
).join("\n")}\n\nRole commands:\n  /roles [agent]       list roles (default agent if omitted)\n  /role <role>         set a role on the default agent\n  /role <agent> <role> set a role on a specific agent\n  /role [agent] none   clear a role\n\nSummon commands:\n  /summon <agent> <task>  launch a private worker agent\n\nThinking commands:\n  /thinking <level>          set the default agent's thinking effort\n  /thinking <agent> <level>  set another agent's thinking effort\n  (during a voice call with that agent the change lasts only for the call)\n\nUse @agent mentions to route a message, for example:\n  @sidia critique this plan\n  @gaia @terry compare and implement`;
