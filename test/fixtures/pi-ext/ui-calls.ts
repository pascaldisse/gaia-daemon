// pi extension fixture for test/pi-runtime.test.ts's Lane D ui-bridge tests
// (chat-mto9n58s-bjr1). Registers a tool that calls ctx.ui.setWidget +
// ctx.ui.confirm, and a shortcut that also calls ctx.ui.setWidget — both
// exercised directly against the real ExtensionRunner (no LLM call needed;
// the test invokes the tool/shortcut handler itself, same as pi's own
// dispatch would).
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function gaiaLaneDFixtureExtension(pi: ExtensionAPI) {
  pi.registerShortcut("ctrl+g", {
    description: "Gaia Lane D fixture shortcut",
    handler: (ctx) => {
      ctx.ui.setWidget("gaia-lane-d-shortcut", ["fired"]);
    },
  });
  pi.registerTool({
    name: "gaia_lane_d_ui_tool",
    label: "Gaia Lane D UI Tool",
    description: "Marker tool exercising ctx.ui.confirm + ctx.ui.setWidget for Lane D's ui-bridge wiring test.",
    parameters: Type.Object({}),
    execute: async (_toolCallId, _params, _signal, _onUpdate, ctx) => {
      ctx.ui.setWidget("gaia-lane-d-widget", ["hello from lane d"]);
      const confirmed = await ctx.ui.confirm("Proceed?", "Confirm the lane D fixture action");
      return {
        content: [{ type: "text", text: confirmed ? "confirmed" : "declined" }],
        details: { confirmed },
      };
    },
  });
}
