// Minimal pi extension fixture for test/pi-runtime.test.ts's discovery tests
// (LANE A, chat-mto9n58s-bjr1). Registers one custom tool so a test can assert
// it reaches the session's active tool list when discover:true threads this
// file in via additionalExtensionPaths — and is ABSENT when discover is off.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function gaiaLaneAFixtureExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "gaia_lane_a_fixture_tool",
    label: "Gaia Lane A Fixture Tool",
    description: "Marker tool proving this extension file was discovered and loaded.",
    parameters: Type.Object({}),
    execute: async () => ({
      content: [{ type: "text", text: "fixture-tool-ok" }],
      details: {},
    }),
  });
}
