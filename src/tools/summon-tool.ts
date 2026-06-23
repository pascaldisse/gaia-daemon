import { Type } from "typebox";
import { defineTool } from "@mariozechner/pi-coding-agent";

export interface SummonCreate {
  (params: { roomId: string; agentId: string; task: string }): Promise<string>;
}

const DESCRIPTION = [
  "Summon private worker agents (\"whales\") to handle tasks in separate sessions.",
  "Pass a single { agent, task } for one worker, or a `whales` list to fan out MANY workers IN PARALLEL.",
  "Each worker runs independently; its transcript stays private (not injected into the room) and it returns a compact result.",
  "Use this to decompose a goal and swarm it: cheap workers for reading/search/triage, heavy workers for reasoning, a codegen worker for large edits.",
].join(" ");

interface WhaleJob {
  agent: string;
  task: string;
}

function formatResult(agent: string, result: string): string {
  return `### @${agent}\n${result.trim()}`;
}

export function createSummonTool(summonCreate: SummonCreate, roomId: string) {
  return defineTool({
    name: "summon",
    label: "Summon",
    description: DESCRIPTION,
    promptSnippet: `summon: fan out private worker agents (whales) — one { agent, task } or a parallel \`whales\` list; returns each worker's final result.`,
    parameters: Type.Object({
      agent: Type.Optional(Type.String({ description: "Single worker agent id to summon (e.g. whale-flash, whale-deep, whale-codex)." })),
      task: Type.Optional(Type.String({ description: "Task for the single summoned agent to complete." })),
      whales: Type.Optional(
        Type.Array(
          Type.Object({
            agent: Type.String({ description: "Worker agent id (e.g. whale-flash, whale-deep, whale-codex)." }),
            task: Type.String({ description: "Self-contained task with explicit acceptance criteria and exactly what to return." }),
          }),
          { description: "Fan out multiple workers in parallel. Each runs concurrently and returns its own result." },
        ),
      ),
      publish: Type.Optional(
        Type.Union([Type.Literal("summary"), Type.Literal("full")], {
          description: "How to publish the result into the room (unused in first pass).",
        }),
      ),
    }),
    execute: async (_toolCallId, params) => {
      const jobs: WhaleJob[] =
        params.whales && params.whales.length > 0
          ? params.whales
          : params.agent && params.task
            ? [{ agent: params.agent, task: params.task }]
            : [];

      if (jobs.length === 0) {
        const text = "ERROR: provide either { agent, task } or a non-empty `whales` list.";
        return { content: [{ type: "text" as const, text }], details: { ok: false, results: [] } };
      }

      // Fan out: every whale is launched concurrently. summonCreate creates the
      // session immediately and resolves when that worker finishes, so awaiting
      // them together runs the swarm in parallel (bounded by the room's
      // maxSummonsPerRoom cap).
      const settled = await Promise.all(
        jobs.map(async (job) => {
          try {
            const result = await summonCreate({ roomId, agentId: job.agent, task: job.task });
            return { agent: job.agent, result, ok: true };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { agent: job.agent, result: `ERROR: ${message}`, ok: false };
          }
        }),
      );

      const text =
        settled.length === 1
          ? settled[0].result
          : settled.map((entry) => formatResult(entry.agent, entry.result)).join("\n\n");

      return { content: [{ type: "text" as const, text }], details: { ok: settled.every((entry) => entry.ok), results: settled } };
    },
  });
}
