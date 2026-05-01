export type SlashCommand =
  | { type: "help" }
  | { type: "quit" }
  | { type: "agents" }
  | { type: "legacy-mode"; command: string }
  | { type: "unknown"; command: string }
  | { type: "message"; text: string };

const LEGACY_AGENT_COMMANDS = new Set(["gaia", "sidia", "monad", "terry"]);

export function parseCommand(input: string): SlashCommand {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { type: "message", text: input };
  const [command] = trimmed.slice(1).split(/\s+/, 1);

  if (LEGACY_AGENT_COMMANDS.has(command ?? "")) {
    return { type: "legacy-mode", command: command ?? "" };
  }

  switch (command) {
    case "help":
      return { type: "help" };
    case "agents":
      return { type: "agents" };
    case "quit":
    case "exit":
      return { type: "quit" };
    default:
      return { type: "unknown", command: command ?? "" };
  }
}

export const HELP_TEXT = `Commands:\n  /help    show this help\n  /agents  list available agents\n  /quit    exit\n\nUse @agent mentions to route a message, for example:\n  @sidia critique this plan\n  @gaia @terry compare and implement`;