// pi extension fixture for test/pi-runtime.test.ts's Lane E command-
// reachability tests (chat-mto9n58s-bjr1). Registers one real slash command
// so a test can prove: (1) bindPiCommands discovers it via
// runner.getRegisteredCommands() and emits ext.commands, and (2) the SDK's
// own runner.getCommand()/createCommandContext() dispatch actually runs the
// extension's REAL handler (never re-implemented gaia-side) — observed via
// the same ctx.ui.setWidget -> ui-bridge path the tool/shortcut fixtures use.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function gaiaLaneEFixtureExtension(pi: ExtensionAPI) {
  pi.registerCommand("fugu-ping", {
    description: "Gaia Lane E fixture command",
    handler: async (args, ctx) => {
      ctx.ui.setWidget("gaia-lane-e-command", [`pong:${args}`]);
    },
  });
}
