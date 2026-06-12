import { Type } from "typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { searchTranscript, type RecallHit } from "../memory/recall.js";

export function createRecallTool(transcriptPath: string, dbPath: string, roomId: string) {
  return defineTool({
    name: "recall",
    label: "Recall",
    description:
      "Search the full room history (every past session, not just your current context) for messages matching a query. Use when the conversation references something you do not remember - an earlier decision, a name, a discussion from weeks ago.",
    promptSnippet: `recall: full-text search over the complete ${roomId} room history.`,
    parameters: Type.Object({
      query: Type.String({ description: "Words or a phrase to search for." }),
      limit: Type.Optional(Type.Number({ description: "Max results (default 8)." })),
    }),
    execute: async (_toolCallId, params) => {
      let text: string;
      let hits: RecallHit[] = [];
      try {
        hits = searchTranscript(transcriptPath, dbPath, params.query, params.limit ?? 8);
        text = hits.length
          ? hits.map((hit) => `[${hit.timestamp}]${hit.channel === "voice" ? " 🎙" : ""} ${hit.author}: ${hit.snippet}`).join("\n")
          : "no matches in the room history";
      } catch (error) {
        text = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
      }
      return { content: [{ type: "text" as const, text }], details: { hits } };
    },
  });
}
