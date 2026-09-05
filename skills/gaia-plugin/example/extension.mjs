// gaia-plugin example — minimal pi package extension.
// One command (§2), one tool, one ctx.ui.confirm dialog. Copy this file +
// package.json as the starting point for a real gaia plugin; see
// ~/.gaia/skills/gaia-plugin/SKILL.md for the full surface table.
import { Type } from "typebox";

export default function gaiaExampleExtension(pi) {
  // registerCommand -> a real `/gaia-example` slash command, dispatched by
  // gaia's own pi runtime (src/harness/pi/runtime.ts resolveExtCommand).
  pi.registerCommand("gaia-example", {
    description: "gaia-plugin example: confirm, then reply",
    handler: async (args, ctx) => {
      const ok = await ctx.ui.confirm("gaia-example", `Run with args "${args}"?`);
      ctx.ui.setWidget("gaia-example-status", [ok ? "confirmed" : "declined"]);
    },
  });

  // registerTool -> callable by the agent's own model turns, no slash command
  // needed. Visible on session.getActiveToolNames() the instant this
  // extension loads (see skills-gaia-plugin.test.ts).
  pi.registerTool({
    name: "gaia_example_echo",
    label: "Gaia Example Echo",
    description: "Echoes the given text back, prefixed. Marker tool proving this extension loaded.",
    parameters: Type.Object({ text: Type.String() }),
    execute: async (_toolCallId, params) => ({
      content: [{ type: "text", text: `gaia-example: ${params.text}` }],
      details: {},
    }),
  });

  return { dispose() {} };
}
