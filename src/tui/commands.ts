import type { Mode } from "../personas/types.js";

export type SlashCommand =
  | { type: "mode"; mode: Mode }
  | { type: "help" }
  | { type: "quit" }
  | { type: "unknown"; command: string }
  | { type: "message"; text: string };

export function parseCommand(input: string): SlashCommand {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return { type: "message", text: input };
  const [command] = trimmed.slice(1).split(/\s+/, 1);
  switch (command) {
    case "gaia":
    case "sidia":
    case "monad":
      return { type: "mode", mode: command };
    case "help":
      return { type: "help" };
    case "quit":
    case "exit":
      return { type: "quit" };
    default:
      return { type: "unknown", command: command ?? "" };
  }
}

export const HELP_TEXT = `Commands:
  /gaia   switch to Gaia (warm constructive mode)
  /sidia  switch to Sidia (skeptical critical mode)
  /monad  switch to Monad (director orchestration mode)
  /help   show this help
  /quit   exit`;
