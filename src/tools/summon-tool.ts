import { Type } from "typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";

export interface SummonCreate {
  (params: { roomId: string; agentId: string; task: string }): Promise<string>;
}

const DESCRIPTION = [
  "Summon a private worker agent to handle a task in a separate session.",
  "The worker runs independently and returns its result when done.",
  "The worker's transcript stays private (not injected into the room).",
  "Use this for heavy analysis, implementation, or research that you want done in isolation.",
].join(" ");

export function createSummonTool(summonCreate: SummonCreate, roomId: string) {
  return defineTool({
    name: "summon",
    label: "Summon",
    description: DESCRIPTION,
    promptSnippet: `summon: launch a private worker agent for isolated analysis or implementation; returns the final summary.`,
    parameters: Type.Object({
      agent: Type.String({ description: "Agent id to summon (e.g. scout, reviewer)." }),
      task: Type.String({ description: "Task for the summoned agent to complete." }),
      publish: Type.Optional(
        Type.Union([Type.Literal("summary"), Type.Literal("full")], {
          description: "How to publish the result into the room (unused in first pass).",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      let text: string;
      let details: unknown;
      try {
        const result = await summonCreate({ roomId, agentId: params.agent, task: params.task });
        text = result;
        details = { result };
      } catch (error) {
        text = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
        details = { ok: false };
      }
      return { content: [{ type: "text" as const, text }], details };
    },
  });
}
