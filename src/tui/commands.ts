export type SlashCommandType = "help" | "quit" | "agents";

export interface SlashCommandDefinition {
  name: string;
  type: SlashCommandType;
  description: string;
  aliases?: string[];
}

export type SlashCommand =
  | { type: "help" }
  | { type: "quit" }
  | { type: "agents" }
  | { type: "unknown"; command: string }
  | { type: "message"; text: string };

export const SLASH_COMMANDS: SlashCommandDefinition[] = [
  { name: "help", type: "help", description: "show command help" },
  { name: "agents", type: "agents", description: "list available agents" },
  { name: "quit", type: "quit", description: "exit GAIA", aliases: ["exit"] },
];

const COMMAND_BY_NAME = new Map<string, SlashCommandDefinition>(
  SLASH_COMMANDS.flatMap((command) => [command.name, ...(command.aliases ?? [])].map((name) => [name, command] as const)),
);

export function parseCommand(input: string): SlashCommand {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { type: "message", text: input };

  const [name = ""] = trimmed.slice(1).split(/\s+/, 1);
  const command = COMMAND_BY_NAME.get(name);
  if (!command) return { type: "unknown", command: name };

  return { type: command.type };
}

export const HELP_TEXT = `Commands:\n${SLASH_COMMANDS.map(
  (command) => `  /${command.name.padEnd(7)} ${command.description}`,
).join("\n")}\n\nUse @agent mentions to route a message, for example:\n  @sidia critique this plan\n  @gaia @terry compare and implement`;
