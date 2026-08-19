// The in-process Pi tool factories (memory / recall / summon). Heavy imports
// (Pi SDK, typebox) live here, loaded lazily via tools.ts's makePiTool — the
// registry itself stays cheap for the `gaia` CLI.

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { Type, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { createBashToolDefinition, createEditToolDefinition, createReadToolDefinition, createWriteToolDefinition, defineTool } from "@earendil-works/pi-coding-agent";
import { gaiaToolCompressionBytes } from "../core/config.js";
import { readGaiaImage, type ImageReadDetail, type ImageReadRegion } from "./image-read.js";
import { createArtifact, listArtifacts, readArtifact, updateArtifact } from "../services/artifacts.js";
import { compressCaryll, expandCaryll } from "../services/caryll.js";
import { searchWeb, type WebSearchProvider } from "../services/web-search.js";
import { workspacePaths, workspaceRootFromRoomDir } from "../core/paths.js";
import type { AgentDef, InsightLevel } from "../core/types.js";
import { CORE_MEMORY_FILE, USER_MEMORY_FILE, type MemoryStore } from "../domain/memory.js";
import { RoomHandle } from "../domain/rooms.js";
import { bareWorkspaceRecall, formatMemoryHits, scrollTranscriptWindow, type MemorySearchHit } from "../domain/workspace-index.js";
import type { RecallSearch, SummonCreate } from "../harness/spec.js";
import type { AgentRosterEntry } from "./tools.js";

// Strict-schema providers (e.g. Moonshot) reject property schemas lacking an
// explicit `type` — typebox's Type.Enum emits bare {enum:[...]} and
// Type.Union(Literal...) emits type-less anyOf. Emit {type:"string",enum:[...]}
// instead: valid everywhere.
const stringEnum = <T extends string>(values: readonly T[], description?: string) =>
  Type.Unsafe<T>({ type: "string", enum: [...values], ...(description ? { description } : {}) });

const MEMORY_DESCRIPTION = [
  "Persist long-term notes for the current agent across sessions.",
  `Layout: ${CORE_MEMORY_FILE} (durable notes + index, always visible to you), ${USER_MEMORY_FILE} (what you know about the user, always visible), and topic files like debugging.md or agents/<id>.md (notes about another agent) that you read on demand.`,
  "Keep the always-visible files distilled; move detail into topic files and leave a one-line pointer. When a file nears its limit, consolidate instead of adding.",
  "Save durable facts, preferences, conventions, and lessons. Skip secrets, one-off details, and anything re-discoverable from the project.",
].join(" ");

export function createMemoryTool(store: MemoryStore, agent: AgentDef) {
  return defineTool({
    name: "memory",
    label: "Memory",
    description: MEMORY_DESCRIPTION,
    promptSnippet: `memory: add, replace, or remove notes in your memory files (${CORE_MEMORY_FILE}, ${USER_MEMORY_FILE}, topic files); read and list topic files on demand.`,
    parameters: Type.Object({
      action: stringEnum(["add", "replace", "remove", "read", "list", "batch"]),
      file: Type.Optional(Type.String({ description: `Memory file to act on, relative to your memory dir. Defaults to ${CORE_MEMORY_FILE}.` })),
      content: Type.Optional(Type.String({ description: "New memory content for add or replace." })),
      old_text: Type.Optional(Type.String({ description: "Exact existing text for replace or remove." })),
      operations: Type.Optional(
        Type.Array(
          Type.Object({
            action: stringEnum(["add", "replace", "remove"]),
            content: Type.Optional(Type.String()),
            old_text: Type.Optional(Type.String()),
          }),
          { description: "Batch mode: apply ALL operations to one file atomically, validated together against the file's budget — use this to consolidate (several replaces + removes) in ONE call instead of retrying op-by-op." },
        ),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: {
        action: "add" | "replace" | "remove" | "read" | "list" | "batch";
        file?: string;
        content?: string;
        old_text?: string;
        operations?: Array<{ action: "add" | "replace" | "remove"; content?: string; old_text?: string }>;
      },
    ) => {
      const file = params.file?.trim() || CORE_MEMORY_FILE;
      let text: string;
      let details: unknown;
      try {
        if (params.action === "list") {
          const files = await store.listFiles(agent.memoryDir);
          text = files.map((info) => `${info.file} (${info.chars}/${info.limit} chars)`).join("\n") || "no memory files";
          details = { files };
        } else if (params.action === "read") {
          const state = await store.readState(agent.memoryDir, file);
          text = state.content || `(empty: ${file})`;
          details = state;
        } else if (params.action === "batch" || params.operations?.length) {
          const operations = (params.operations ?? []).map((op) => ({
            action: op.action,
            ...(op.content !== undefined ? { content: op.content } : {}),
            ...(op.old_text !== undefined ? { oldText: op.old_text } : {}),
          }));
          const result = await store.mutateBatch(agent.memoryDir, file, operations);
          text = `${result.ok ? "OK" : "ERROR"}: ${result.message}\n\n${result.state.content}`;
          details = result;
        } else {
          const result = await store.mutate(agent.memoryDir, file, params.action, { content: params.content, oldText: params.old_text });
          text = `${result.ok ? "OK" : "ERROR"}: ${result.message}\n\n${result.state.content}`;
          details = result;
        }
      } catch (error) {
        text = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
        details = { ok: false };
      }
      return { content: [{ type: "text" as const, text }], details };
    },
  });
}

/** Fallback recall when no daemon bridge exists: the workspace memory index
 * opened directly (lexical-only, whole workspace — v3's per-room recall.db
 * fallback retired with the rest of the v3 engine). */
export function localRecallSearch(roomDir: string, _roomId: string, agent?: { id: string; memoryDir: string; insight?: InsightLevel }): RecallSearch {
  const root = workspaceRootFromRoomDir(roomDir);
  const search = async (query: string, limit?: number) =>
    bareWorkspaceRecall(root, query, {
      ...(agent ? { agentId: agent.id, memoryDir: agent.memoryDir } : {}),
      limit: limit ?? 8,
    });
  return Object.assign(search, {
    scroll: async (hitId: number, options?: { span?: number; offset?: number }) =>
      (await scrollTranscriptWindow(root, hitId, options ?? {})) ?? `no transcript hit with id ${hitId} — ids come from recall results ("hit N")`,
    // INSIGHT "full" tier (decree 2026-07-28 part 3), bare/no-daemon fallback:
    // same gate as the daemon-bridge path (harnessGhoulRoomRead), duplicated
    // here because this fallback has no token/claims to check server-side.
    ghoulRoom: async (roomId: string, options?: { offset?: number; limit?: number }) => {
      if (agent?.insight !== "full") throw new Error(`insight "full" required to read another room's raw transcript (caller '${agent?.id ?? "?"}' has insight "${agent?.insight ?? "none"}")`);
      // RoomHandle.open has create-on-open semantics (it seeds a default
      // state.json for any id that doesn't exist yet) — wrong for a read-only
      // "look into the labyrinth" operation, so check existence FIRST and
      // never let a typo'd room id silently create a phantom room on disk.
      if (!existsSync(workspacePaths.roomState(root, roomId))) throw new Error(`no such room: ${roomId}`);
      const handle = await RoomHandle.open(root, roomId);
      const state = await handle.state();
      if (state.incognito !== true) throw new Error(`'${roomId}' is not an incognito room — read it through normal recall instead`);
      const { events } = await handle.eventsFrom(0);
      const offset = Math.max(0, options?.offset ?? 0);
      const limit = Math.min(Math.max(1, options?.limit ?? 40), 200);
      const window = events.slice(offset, offset + limit);
      if (window.length === 0) return `'${roomId}': no events at offset ${offset} (${events.length} total)`;
      const lines = window.map((event, index) => {
        const shown = event.text.length > 800 ? `${event.text.slice(0, 800)}…` : event.text;
        return `[${offset + index}] ${event.author}: ${shown || "(no text)"}`;
      });
      const consumed = offset + window.length;
      const more = consumed < events.length ? `\n\n… ${events.length - consumed} more events; pass offset=${consumed} to continue` : "";
      return `${roomId} (${events.length} events total, showing ${offset}–${consumed - 1}):\n\n${lines.join("\n")}${more}`;
    },
    // Ledger search needs every agent's memoryDir (the full workspace roster),
    // which this room-scoped fallback does not have — honest gap, not a silent
    // one: real implementation lives in the daemon-bridge path every harness
    // actually runs under (bridgeRecallSearch → harnessGhoulLedgerSearch).
    ghoulLedgers: async () => {
      throw new Error("ghoul ledger search requires the daemon bridge (not available in the bare/no-daemon recall fallback)");
    },
  });
}

export function createRecallTool(search: RecallSearch, roomId: string) {
  return defineTool({
    name: "recall",
    label: "Recall",
    description:
      "Search your long-term memory: distilled facts, past task episodes (with outcomes), and the full history of EVERY room — every past session, not just your current context. Use when the conversation references something you do not remember: an earlier decision, a name, a lesson from a failed attempt, a discussion from weeks ago. To read the raw conversation around a transcript result, call again with `around` set to that hit's id. If your insight tier is 'full': `ghoul_room` reads any (even incognito) room's raw transcript directly; `ghoul_ledgers` searches every agent's distilled summon-ledger — both denied for any other agent.",
    promptSnippet: `recall: deep ranked search over your facts, episodes, and all room history (not just ${roomId}); pass around=<hit id> to scroll the raw transcript at a hit; insight:'full' only — ghoul_room=<roomId> / ghoul_ledgers=true.`,
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Words or a phrase to search for (ignored when `around`, `ghoul_room`, or `ghoul_ledgers` is set; required otherwise)." })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 8; also caps ghoul_room's event window)." })),
      around: Type.Optional(Type.Number({ description: "Scroll mode: a transcript hit id from a previous recall — returns the raw conversation around it." })),
      span: Type.Optional(Type.Number({ description: "Scroll window: events each side of the hit (default 12)." })),
      offset: Type.Optional(Type.Number({ description: "Scroll shift: move the window by this many events (negative = earlier); also ghoul_room's paging offset." })),
      ghoul_room: Type.Optional(
        Type.String({ description: "INSIGHT 'full' ONLY: read a specific room's RAW transcript directly, even if incognito (e.g. a ghoul's own room id) — windowed by offset/limit. Denied for any agent without insight:'full'." }),
      ),
      ghoul_ledgers: Type.Optional(
        Type.Boolean({ description: "INSIGHT 'full' ONLY: search every agent's distilled summon ledgers (not raw transcripts) — pass `query` to filter, omit for the full list. Denied for any agent without insight:'full'." }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: { query?: string; limit?: number; around?: number; span?: number; offset?: number; ghoul_room?: string; ghoul_ledgers?: boolean },
    ) => {
      let text: string;
      let hits: MemorySearchHit[] = [];
      try {
        if (params.ghoul_room !== undefined && search.ghoulRoom) {
          text = await search.ghoulRoom(params.ghoul_room, {
            ...(params.offset !== undefined ? { offset: params.offset } : {}),
            ...(params.limit !== undefined ? { limit: params.limit } : {}),
          });
        } else if (params.ghoul_ledgers === true && search.ghoulLedgers) {
          text = await search.ghoulLedgers(params.query);
        } else if (params.around !== undefined && search.scroll) {
          text = await search.scroll(params.around, {
            ...(params.span !== undefined ? { span: params.span } : {}),
            ...(params.offset !== undefined ? { offset: params.offset } : {}),
          });
        } else if (params.query) {
          hits = await search(params.query, params.limit ?? 8);
          text = hits.length ? formatMemoryHits(hits, { full: true }) : "no matches in memory or room history";
        } else {
          text = "ERROR: query is required (unless around, ghoul_room, or ghoul_ledgers is set)";
        }
      } catch (error) {
        text = `ERROR: ${error instanceof Error ? error.message : String(error)}`;
      }
      return { content: [{ type: "text" as const, text }], details: { hits } };
    },
  });
}

const SUMMON_DESCRIPTION = [
  'Summon background worker agents ("whales") to handle tasks in their own sub-rooms.',
  "Pass a single { agent, task } for one worker, or a `whales` list to fan out MANY workers IN PARALLEL.",
  "This tool returns IMMEDIATELY with each worker's sub-room id — workers run in the background and never block your turn.",
  "When a worker finishes, its result is posted back into this room and you are invoked again to continue — do NOT wait, poll, or re-summon while workers run.",
  "Use this to decompose a goal and swarm it: cheap workers for reading/search/triage, heavy workers for reasoning, a codegen worker for large edits; end your turn after summoning (tell the user what you launched) and synthesize when the results come back.",
].join(" ");

export function createSummonTool(summonCreate: SummonCreate, roomId: string, availableAgents: readonly AgentRosterEntry[] = []) {
  const availableAgentIds = availableAgents.map((agent) => agent.id);
  const rosterLine = availableAgentIds.length ? `Available agents: ${availableAgentIds.join(", ")}` : "";
  const agentParameter = () => {
    const description = ["Worker agent id to summon.", rosterLine].filter(Boolean).join(" ");
    return availableAgentIds.length ? stringEnum(availableAgentIds, description) : Type.String({ description });
  };

  return defineTool({
    name: "summon",
    label: "Summon",
    description: [SUMMON_DESCRIPTION, rosterLine].filter(Boolean).join(" "),
    promptSnippet: [
      `summon: fan out background worker agents (whales) — one { agent, task } or a parallel \`whales\` list; returns immediately, and each worker's result is posted back to this room when it finishes (you'll be invoked again — never block on workers).`,
      rosterLine,
    ]
      .filter(Boolean)
      .join(" "),
    parameters: Type.Object({
      agent: Type.Optional(agentParameter()),
      task: Type.Optional(Type.String({ description: "Task for the single summoned agent to complete." })),
      whales: Type.Optional(
        Type.Array(
          Type.Object({
            agent: agentParameter(),
            task: Type.String({ description: "Self-contained task with explicit acceptance criteria and exactly what to return." }),
          }),
          { description: "Fan out multiple workers in parallel. Each runs concurrently and returns its own result." },
        ),
      ),
    }),
    execute: async (_toolCallId: string, params: { agent?: string; task?: string; whales?: Array<{ agent: string; task: string }> }) => {
      const jobs =
        params.whales && params.whales.length > 0 ? params.whales : params.agent && params.task ? [{ agent: params.agent, task: params.task }] : [];

      if (jobs.length === 0) {
        const text = "ERROR: provide either { agent, task } or a non-empty `whales` list.";
        return { content: [{ type: "text" as const, text }], details: { ok: false, results: [] } };
      }

      // Fan out: every whale launches concurrently; awaiting them together runs
      // the swarm in parallel (bounded by the room's maxSummonsPerRoom cap).
      const settled = await Promise.all(
        jobs.map(async (job) => {
          try {
            const result = await summonCreate({ roomId, agentId: job.agent, task: job.task });
            return { agent: job.agent, result, ok: true };
          } catch (error) {
            return { agent: job.agent, result: `ERROR: ${error instanceof Error ? error.message : String(error)}`, ok: false };
          }
        }),
      );

      const text = settled.length === 1 ? settled[0].result : settled.map((entry) => `### @${entry.agent}\n${entry.result.trim()}`).join("\n\n");
      return { content: [{ type: "text" as const, text }], details: { ok: settled.every((entry) => entry.ok), results: settled } };
    },
  });
}

interface ArtifactToolParams {
  action: "create" | "update" | "list" | "read";
  artifact_id?: string;
  name?: string;
  kind?: "html" | "json" | "design";
  media_type?: string;
  content?: string;
}

function artifactParameters() {
  return Type.Object({
    action: stringEnum(["create", "update", "list", "read"]),
    artifact_id: Type.Optional(Type.String({ description: "Artifact id; required for update/read." })),
    name: Type.Optional(Type.String({ description: "Display name; required for create." })),
    kind: Type.Optional(stringEnum(["html", "json", "design"], "Artifact kind; required for create.")),
    media_type: Type.Optional(Type.String({ description: "Payload media type; required for create." })),
    content: Type.Optional(Type.String({ description: "UTF-8 payload; required for create, optional for update." })),
  });
}

async function runArtifactAction(
  ctx: Pick<import("./tools.js").PiToolContext, "roomDir" | "roomId">,
  params: ArtifactToolParams,
): Promise<{ text: string; details: unknown }> {
  const location = { rootDir: workspaceRootFromRoomDir(ctx.roomDir), roomId: ctx.roomId };
  if (params.action === "list") {
    const artifacts = await listArtifacts(location);
    return { text: JSON.stringify(artifacts, null, 2), details: { artifacts } };
  }
  if (params.action === "read") {
    if (!params.artifact_id) throw new Error("artifact_id is required for read");
    const artifact = await readArtifact(location, params.artifact_id);
    const content = Buffer.from(artifact.payload).toString("utf8");
    return { text: `${JSON.stringify(artifact.manifest, null, 2)}\n\n${content}`, details: { manifest: artifact.manifest } };
  }
  if (params.action === "create") {
    if (!params.name || !params.kind || !params.media_type || params.content === undefined) {
      throw new Error("name, kind, media_type, and content are required for create");
    }
    const manifest = await createArtifact(location, {
      name: params.name,
      kind: params.kind,
      mediaType: params.media_type,
      payload: params.content,
    });
    return { text: JSON.stringify(manifest, null, 2), details: { manifest } };
  }
  if (!params.artifact_id) throw new Error("artifact_id is required for update");
  const manifest = await updateArtifact(location, params.artifact_id, {
    ...(params.name !== undefined ? { name: params.name } : {}),
    ...(params.kind !== undefined ? { kind: params.kind } : {}),
    ...(params.media_type !== undefined ? { mediaType: params.media_type } : {}),
    ...(params.content !== undefined ? { payload: params.content } : {}),
  });
  return { text: JSON.stringify(manifest, null, 2), details: { manifest } };
}

export function createArtifactTool(ctx: Pick<import("./tools.js").PiToolContext, "roomDir" | "roomId">) {
  return defineTool({
    name: "artifact",
    label: "Artifact",
    description: "Create, update, list, and read durable artifacts owned by the current room.",
    promptSnippet: "artifact: create/update/list/read room-owned html, json, and design payloads.",
    parameters: artifactParameters(),
    execute: async (_toolCallId: string, params: ArtifactToolParams) => {
      try {
        const result = await runArtifactAction(ctx, params);
        return { content: [{ type: "text" as const, text: result.text || "[]" }], details: result.details };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `ERROR: ${error instanceof Error ? error.message : String(error)}` }], details: { ok: false } };
      }
    },
  });
}

type GaiaVerb = "bash" | "read" | "write" | "edit" | "web" | "summon" | "resume" | "mem" | "recall" | "artifact" | "caryll";
type GaiaResult = { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; details: unknown };
type GaiaHandler = (args: Record<string, unknown>) => Promise<GaiaResult>;

const ALL_GAIA_VERBS: readonly GaiaVerb[] = ["bash", "read", "write", "edit", "web", "summon", "resume", "mem", "recall", "artifact", "caryll"];

/** Verbs with a real, reusable per-verb `args` schema (mirrors the retired
 * typed native tools exactly — read/write/edit/bash/summon/mem/recall come
 * straight from the Pi tool factories' own `.parameters`, never re-typed by
 * hand, so this can never drift from what `native.<verb>.execute` actually
 * accepts). resume/artifact/caryll stay hand-validated below (§ANCHOR
 * gaiaHandLoop) — small enough that a schema would just duplicate the checks
 * already in their handlers. */
function verbSchemaEntries(schemas: Partial<Record<GaiaVerb, TSchema>>): Array<[GaiaVerb, TSchema]> {
  return ALL_GAIA_VERBS.map((verb) => [verb, schemas[verb]] as const).filter((entry): entry is [GaiaVerb, TSchema] => entry[1] !== undefined);
}

/** Precise, path-qualified corrective error string for a malformed verb call —
 * the self-healing-loop half of schema tightness: even when the outer
 * tool schema's structural hint (allOf/if-then, see buildGaiaParameters) goes
 * unenforced by a given provider or a pre-restart daemon still serving the old
 * loose schema, this direct Value.Check/Value.Errors pass against the SAME
 * per-verb schema still catches it before dispatch and hands the model back
 * exactly which field is wrong instead of a generic native-tool crash. */
function formatArgErrors(verb: GaiaVerb, schema: TSchema, args: unknown): string {
  const errors = [...Value.Errors(schema, args)].slice(0, 8);
  const detail = errors.length
    ? errors.map((error) => `${error.instancePath || "/"}: ${error.message}`).join("; ")
    : "does not match the expected shape";
  const readDetailHint = verb === "read" && typeof (args as Record<string, unknown>)?.detail === "string" ? "; detail must be low, med, high, or full" : "";
  return `ERROR: gaia ${verb} args invalid — ${detail}${readDetailHint}`;
}

/** The outer `gaia` tool schema: keeps a normal flat object (verb enum + a
 * loose `args`) as the TOP-LEVEL type/properties/required — load-bearing,
 * not cosmetic: pi-ai's Anthropic non-strict conversion path
 * (convertTools → legacyInputSchema in @earendil-works/pi-ai's
 * anthropic-messages.js) rebuilds `input_schema` from ONLY
 * `schema.properties`/`schema.required` at the SCHEMA ROOT, discarding
 * anything that lives inside a root-level `oneOf` branch instead of
 * top-level `properties` — a genuine discriminated-union (option a) would
 * silently degrade to an EMPTY `properties: {}` for every Claude call
 * (verified against the installed pi-ai build, not a version assumption).
 * `allOf` of `if`/`then` branches keyed on `verb` (option b) survives that
 * rebuild untouched since it never touches `properties`/`required`/`type` —
 * confirmed live: pi-agent-core's agent-loop calls
 * `@earendil-works/pi-ai`'s `validateToolArguments(tool, toolCall)` against
 * this exact `tool.parameters` (Compile+if/then honored, see tools-pi
 * schema tests) BEFORE `execute()` ever runs, throwing a formatted error the
 * loop turns into an error tool-result — i.e. Anthropic/OpenAI/etc. all see
 * the same canonical schema pre-provider-transform. */
function buildGaiaParameters(verbSchemas: Partial<Record<GaiaVerb, TSchema>>) {
  const allOf = verbSchemaEntries(verbSchemas).map(([verb, schema]) => ({
    if: { properties: { verb: { const: verb } }, required: ["verb"] },
    then: { properties: { args: schema } },
  }));
  return Type.Unsafe<{
    verb: GaiaVerb;
    args: Record<string, unknown>;
    raw?: boolean;
    compress_above_bytes?: number;
    translator?: "deterministic" | "llm";
  }>({
    type: "object",
    required: ["verb", "args"],
    properties: {
      verb: { type: "string", enum: [...ALL_GAIA_VERBS], description: "Which gaia operation to run." },
      args: {
        type: "object",
        description:
          "Verb-specific arguments. Shape depends on `verb`: bash/read/write/edit/summon/mem/recall/web are strictly typed (see the matching allOf branch below, keyed on verb — mirrors the retired native tools exactly, e.g. edit wants { path, edits: [{ oldText, newText }] }); resume wants { roomId, message }; artifact wants { action, ... }; caryll wants { action, path, output? } — all three validated at call time with a corrective error on mismatch.",
      },
      raw: { type: "boolean", description: "Return native output unchanged." },
      compress_above_bytes: { type: "number", minimum: 0, description: "Override configured gaiago formatting threshold in bytes." },
      translator: { type: "string", enum: ["deterministic", "llm"], description: "llm reserved: translation hook is not wired yet." },
    },
    ...(allOf.length ? { allOf } : {}),
  });
}

function resultText(result: GaiaResult): string {
  return result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
}

/** Deterministic gaiago formatter: field-style header + compact graph rows.
 * It deliberately does not use Caryll: lexical dictionaries measured 0% on
 * reasoning output. `translator: "llm"` is a reserved hook; no model is
 * invoked until a caller supplies one through the registry context. */
export function formatGaiagoResult(verb: GaiaVerb, text: string, details: unknown): { text: string; formatter: "deterministic" } {
  const lines = text.split("\n");
  const nonblank = lines.filter((line) => line.trim()).length;
  const status = text.startsWith("ERROR") ? "失" : "真";
  const detailKind = details && typeof details === "object" ? Object.keys(details as object).join(",") || "none" : "none";
  // Preserve payload bytes for read/edit and arbitrary command output; structural
  // framing gives the model a stable graph without pretending lossy prose is a
  // compressor. Whitespace-only rows disappear only for bash list/test output.
  const payload = verb === "bash" ? lines.filter((line) => line.trim()).map((line, i) => `${i + 1}→${line.trim()}`).join("\n") : text;
  return { text: `${status} ${verb} · 行=${nonblank} · 詳=${detailKind}\n${payload || "∅"}`, formatter: "deterministic" };
}

async function runWebVerb(args: Record<string, unknown>, bash: any): Promise<GaiaResult> {
  const query = typeof args.query === "string" ? args.query : "";
  // Preserve the pre-existing command-shaped curl escape hatch. Structured
  // {query, provider?} calls use the daemon-owned provider fallback chain.
  if (!query) return bash.execute("gaia", args, undefined, undefined, undefined) as Promise<GaiaResult>;
  const provider = args.provider;
  if (provider !== undefined && provider !== "brave" && provider !== "tavily" && provider !== "serper") {
    return { content: [{ type: "text", text: "ERROR: web provider must be brave, tavily, or serper." }], details: { ok: false } };
  }
  const maxResults = typeof args.maxResults === "number" ? args.maxResults : typeof args.max_results === "number" ? args.max_results : undefined;
  const response = await searchWeb({ query, ...(maxResults === undefined ? {} : { maxResults }), ...(provider === undefined ? {} : { provider: provider as WebSearchProvider }) });
  const output = response.results.map((item, index) => `--- Result ${index + 1} ---\nTitle: ${item.title}\nLink: ${item.url}\nSnippet: ${item.snippet}`).join("\n\n");
  return { content: [{ type: "text", text: `Provider: ${response.provider}\n${output}` }], details: response };
}

async function runCaryllVerb(args: Record<string, unknown>): Promise<GaiaResult> {
  const action = args.action;
  const path = typeof args.path === "string" ? args.path : "";
  const output = typeof args.output === "string" ? args.output : path;
  if ((action !== "compress" && action !== "expand" && action !== "stats") || !path) {
    return { content: [{ type: "text", text: "ERROR: caryll args require { action: compress|expand|stats, path, output? }." }], details: { ok: false } };
  }
  const source = await readFile(path, "utf8");
  if (action === "compress") {
    const result = compressCaryll(source);
    await writeFile(output, result.output);
    return { content: [{ type: "text", text: `真 caryll.compress · ${path}→${output}` }], details: result.stats };
  }
  if (action === "expand") {
    const result = expandCaryll(source);
    await writeFile(output, result);
    return { content: [{ type: "text", text: `真 caryll.expand · ${path}→${output}` }], details: { bytes: Buffer.byteLength(result) } };
  }
  const result = compressCaryll(source);
  return { content: [{ type: "text", text: `真 caryll.stats · ${result.stats.tokensBefore}→${result.stats.tokensAfter} · legend=${result.stats.legendEntries}` }], details: result.stats };
}

/** One custom Pi tool: table-driven delegation to Pi native tools and the
 * existing daemon tool factories. New verbs add exactly one registry entry. */
export function createGaiaTool(ctx: import("./tools.js").PiToolContext) {
  const cwd = ctx.workDir ?? process.cwd();
  const native = {
    bash: createBashToolDefinition(cwd),
    read: createReadToolDefinition(cwd),
    write: createWriteToolDefinition(cwd),
    edit: createEditToolDefinition(cwd),
  };
  // Deliberately hand-extended rather than mutating Pi's shared schema object:
  // native:true preserves Pi exactly; all other image paths are rendered here.
  const readArgsSchema = Type.Object({
    path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
    offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed); text files only." })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read; text files only." })),
    detail: Type.Optional(stringEnum(["low", "med", "high", "full"], "Image detail: low=768, med=1280, high=1568, full=original (provider byte cap still applies).")),
    region: Type.Optional(Type.String({ pattern: "^[A-C][1-3]$", description: "Image grid cell to crop from original pixels, e.g. B2. A 768px full thumbnail is always also sent." })),
    native: Type.Optional(Type.Boolean({ description: "Bypass GAIA image rendering and delegate unchanged to Pi native read." })),
  });
  const memory = createMemoryTool(ctx.memoryStore, ctx.agent);
  const recall = createRecallTool(
    ctx.recallSearch ?? localRecallSearch(ctx.roomDir, ctx.roomId, { id: ctx.agent.id, memoryDir: ctx.agent.memoryDir, insight: ctx.agent.insight }),
    ctx.roomId,
  );
  const summon = ctx.summonCreate ? createSummonTool(ctx.summonCreate, ctx.roomId, ctx.availableAgents) : undefined;

  // Web's args are a union: the {query, provider?, maxResults?} search shape,
  // OR the bash-shaped {command, timeout?} curl escape hatch runWebVerb falls
  // back to verbatim when `query` is absent — reuses native.bash's own schema
  // rather than re-typing "command" by hand.
  const webArgsSchema = Type.Union([
    native.bash.parameters as TSchema,
    Type.Object({
      query: Type.Optional(Type.String({ description: "Search query text." })),
      provider: Type.Optional(stringEnum(["brave", "tavily", "serper"], "Explicit provider override; default falls back Brave \u2192 Tavily \u2192 Serper.")),
      maxResults: Type.Optional(Type.Number({ description: "Max results to return." })),
      max_results: Type.Optional(Type.Number({ description: "Snake_case alias for maxResults." })),
    }),
  ]);

  // Reused VERBATIM from the already-instantiated native/daemon tool objects
  // — never hand-retyped — so this can't drift from what each verb's handler
  // actually accepts (see verbSchemaEntries doc comment above).
  const verbSchemas: Partial<Record<GaiaVerb, TSchema>> = {
    bash: native.bash.parameters as TSchema,
    read: readArgsSchema,
    write: native.write.parameters as TSchema,
    edit: native.edit.parameters as TSchema,
    web: webArgsSchema,
    mem: memory.parameters as TSchema,
    recall: recall.parameters as TSchema,
    ...(summon ? { summon: summon.parameters as TSchema } : {}),
  };

  // Pi's exported tool definitions are the native implementations. The custom
  // wrapper deliberately calls their executor rather than copying filesystem or
  // shell semantics; they accept unused lifecycle arguments after call+params.
  const executeNative = (tool: any, args: Record<string, unknown>) => tool.execute("gaia", args, undefined, undefined, undefined) as Promise<GaiaResult>;
  const registry: Record<GaiaVerb, GaiaHandler> = {
    bash: (args) => executeNative(native.bash, args),
    read: async (args) => {
      if (args.native === true || ctx.imageRead === "native") return executeNative(native.read, args);
      const path = typeof args.path === "string" ? args.path : "";
      try {
        const image = await readGaiaImage(path, cwd, { detail: args.detail as ImageReadDetail | undefined, region: args.region as ImageReadRegion | undefined });
        if (image) return image;
      } catch (error) {
        // An image decoder/encoder failure must never turn a read into a dead end.
        console.warn(`[gaia image-read] falling back to Pi native read for ${path}: ${error instanceof Error ? error.message : String(error)}`);
      }
      return executeNative(native.read, args);
    },
    write: (args) => executeNative(native.write, args),
    edit: (args) => executeNative(native.edit, args),
    web: (args) => runWebVerb(args, native.bash),
    mem: (args) => executeNative(memory, args),
    recall: (args) => executeNative(recall, args),
    summon: (args) => (summon ? executeNative(summon, args) : Promise.resolve({ content: [{ type: "text", text: "ERROR: summon is unavailable for this room." }], details: { ok: false } })),
    resume: async (args) => {
      const roomId = typeof args.roomId === "string" ? args.roomId : "";
      const message = typeof args.message === "string" ? args.message : "";
      if (!roomId || !message) return { content: [{ type: "text", text: "ERROR: resume args require { roomId, message }." }], details: { ok: false } };
      if (!ctx.resumeCreate) return { content: [{ type: "text", text: "ERROR: resume is unavailable for this room." }], details: { ok: false } };
      try {
        return { content: [{ type: "text", text: await ctx.resumeCreate({ roomId, message }) }], details: { ok: true } };
      } catch (error) {
        return { content: [{ type: "text", text: `ERROR: ${error instanceof Error ? error.message : String(error)}` }], details: { ok: false } };
      }
    },
    artifact: async (args) => {
      const result = await runArtifactAction(ctx, args as unknown as ArtifactToolParams);
      return { content: [{ type: "text", text: result.text || "[]" }], details: result.details };
    },
    caryll: runCaryllVerb,
  };

  return defineTool({
    name: "gaia",
    label: "Gaia",
    description: "Unified GAIA tool. verb dispatches to native bash/read/write/edit, web search (Brave → Tavily → Serper; {query, provider?}) or curl fallback, daemon memory/recall/summon/resume, room artifacts, or caryll. Results above compress_above_bytes use deterministic gaiago graph notation; raw:true bypasses it.",
    promptSnippet: "gaia: unified { verb, args }; web accepts {query, provider?, maxResults?} and falls back Brave → Tavily → Serper; also files, commands, memory, artifacts, workers, steering.",
    parameters: buildGaiaParameters(verbSchemas),
    execute: async (_toolCallId: string, params: { verb: GaiaVerb; args: Record<string, unknown>; raw?: boolean; compress_above_bytes?: number; translator?: "deterministic" | "llm" }) => {
      try {
        const schema = verbSchemas[params.verb];
        if (schema && !Value.Check(schema, params.args)) {
          const text = formatArgErrors(params.verb, schema, params.args);
          return { content: [{ type: "text" as const, text }], details: { ok: false, verb: params.verb } };
        }
        const result = await registry[params.verb](params.args);
        const text = resultText(result);
        const threshold = Number.isFinite(params.compress_above_bytes) && (params.compress_above_bytes ?? 0) >= 0 ? (params.compress_above_bytes as number) : gaiaToolCompressionBytes();
        if (params.raw || Buffer.byteLength(text) <= threshold) return result;
        const formatted = formatGaiagoResult(params.verb, text, result.details);
        return { content: [{ type: "text" as const, text: formatted.text }], details: { native: result.details, formatter: formatted.formatter, translator: params.translator ?? "deterministic", threshold } };
      } catch (error) {
        return { content: [{ type: "text" as const, text: `ERROR: ${error instanceof Error ? error.message : String(error)}` }], details: { ok: false } };
      }
    },
  });
}
