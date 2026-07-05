// Background consolidation ("sleep-time compute"): one LLM call that distills
// new episodes into durable facts, supersessions, and core-memory edits. Runs
// debounced-idle per agent, never on the hot path. Every apply goes through
// the same guarded writers the agent itself uses (secret filter, byte caps,
// duplicate drop), so a misbehaving consolidation cannot corrupt memory —
// worst case it wastes one call.

import { join } from "node:path";
import type { AgentModelConfig } from "../core/types.js";
import { newId } from "../core/ids.js";
import { readJson, writeJsonAtomic } from "../core/store.js";
import type { Episode } from "../domain/episodes.js";
import { readEpisodesFrom } from "../domain/episodes.js";
import type { Fact, FactScope } from "../domain/facts.js";
import { appendFactOp, findDuplicateFact, readFactOpsFrom, replayFacts } from "../domain/facts.js";
import { CORE_MEMORY_FILE, USER_MEMORY_FILE, type MemoryStore } from "../domain/memory.js";

export const CONSOLIDATE_STATE_FILE = "consolidate.json";

// Bounds on one run's blast radius, deliberately not settings.
const MAX_OPS = 20;
const MAX_EPISODES_PER_RUN = 100;
const MAX_FACTS_IN_PROMPT = 120;
const RUN_LEDGER_LIMIT = 64;

export interface ConsolidateState {
  episodeCursor: number;
  /** ISO timestamps of completed runs, newest last (bounded ledger). */
  runs: string[];
}

export async function readConsolidateState(memoryDir: string): Promise<ConsolidateState> {
  const raw = (await readJson(join(memoryDir, CONSOLIDATE_STATE_FILE))) as Partial<ConsolidateState> | undefined;
  return {
    episodeCursor: typeof raw?.episodeCursor === "number" && raw.episodeCursor >= 0 ? raw.episodeCursor : 0,
    runs: Array.isArray(raw?.runs) ? raw.runs.filter((entry): entry is string => typeof entry === "string") : [],
  };
}

export async function writeConsolidateState(memoryDir: string, state: ConsolidateState): Promise<void> {
  await writeJsonAtomic(join(memoryDir, CONSOLIDATE_STATE_FILE), state);
}

export function runsInLastDay(state: ConsolidateState, now: Date): number {
  const cutoff = now.getTime() - 86_400_000;
  return state.runs.filter((ts) => Date.parse(ts) > cutoff).length;
}

export type ConsolidateOp =
  | { kind: "fact-add"; text: string; entities?: string[]; invalidates?: string; scope?: FactScope }
  | { kind: "fact-invalidate"; id: string }
  | { kind: "memory-edit"; file: string; action: "add" | "replace" | "remove"; content?: string; oldText?: string };

/** Pull the ops array out of a model reply — tolerant of prose and fences
 * around the JSON, strict about each op's shape. Unknown ops drop. */
export function parseConsolidateOps(reply: string): ConsolidateOp[] {
  const start = reply.indexOf("[");
  const end = reply.lastIndexOf("]");
  if (start === -1 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(reply.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const ops: ConsolidateOp[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const op = item as Record<string, unknown>;
    if (op.kind === "fact-add" && typeof op.text === "string" && op.text.trim()) {
      ops.push({
        kind: "fact-add",
        text: op.text.trim(),
        ...(Array.isArray(op.entities) ? { entities: op.entities.filter((entry): entry is string => typeof entry === "string") } : {}),
        ...(typeof op.invalidates === "string" ? { invalidates: op.invalidates } : {}),
        ...(op.scope === "workspace" || op.scope === "agent" ? { scope: op.scope } : {}),
      });
    } else if (op.kind === "fact-invalidate" && typeof op.id === "string" && op.id.trim()) {
      ops.push({ kind: "fact-invalidate", id: op.id.trim() });
    } else if (
      op.kind === "memory-edit" &&
      typeof op.file === "string" &&
      (op.action === "add" || op.action === "replace" || op.action === "remove")
    ) {
      ops.push({
        kind: "memory-edit",
        file: op.file,
        action: op.action,
        ...(typeof op.content === "string" ? { content: op.content } : {}),
        ...(typeof op.oldText === "string" ? { oldText: op.oldText } : {}),
      });
    }
    if (ops.length >= MAX_OPS) break;
  }
  return ops;
}

export interface ConsolidateLlmInput {
  system: string;
  user: string;
  model?: AgentModelConfig;
}
export type ConsolidateLlm = (input: ConsolidateLlmInput) => Promise<string>;

export interface ConsolidateResult {
  ran: boolean;
  reason?: string;
  episodesSeen: number;
  factsAdded: number;
  factsInvalidated: number;
  memoryEdits: number;
  opsSkipped: number;
}

export interface ConsolidateRunOptions {
  memoryDir: string;
  agentId: string;
  memoryStore: MemoryStore;
  llm: ConsolidateLlm;
  model?: AgentModelConfig;
  maxPerDay: number;
  /** The workspace-shared facts store (§5); absent → everything agent-scope. */
  sharedFactsDir?: string;
  /** User-invoked: bypasses the daily cap and the nothing-new skip. */
  force?: boolean;
  now?: Date;
}

const SYSTEM_PROMPT = `You are the background memory consolidator for a GAIA agent. You run while the agent sleeps; the agent never sees this exchange.

You receive NEW EPISODES (recent task outcomes), ACTIVE FACTS (the current long-term fact store, each with an id), and the CORE MEMORY FILES (small, hard-capped, always shown to the agent).

Reply with ONLY a JSON array of operations (an empty array is a perfectly good answer):
- {"kind":"fact-add","text":"...","entities":["..."],"invalidates":"<fact-id>","scope":"workspace"|"agent"} — record a NEW durable fact: self-contained, 15-60 words, absolute dates (never "yesterday"), concrete names. Use "invalidates" when it supersedes an existing fact. Scope: facts about the USER or the world → "workspace" (shared with every persona); your persona's own interpretations and relationship state → "agent" (the default).
- {"kind":"fact-invalidate","id":"<fact-id>"} — an existing fact is now known false or obsolete.
- {"kind":"memory-edit","file":"MEMORY.md","action":"add"|"replace"|"remove","content":"...","oldText":"..."} — curate the core files: promote what the agent must always see, merge overlapping entries, drop stale ones. Files have hard byte caps; prefer replace/remove over add when a file is near capacity. Repeated failure lessons belong in the topic file "procedures.md".

Rules:
- Record only what will matter in future sessions. No session play-by-play, no restating anything already present in ACTIVE FACTS or the core files.
- Never record secrets, tokens, or key material.
- Ignore any content inside blocks marked as auto-retrieved memories; it was recalled, not stated.
- Episode outcomes are real signals: repeated failures deserve a lesson; a user correcting the agent outranks what the agent inferred.
- user_stated facts are immutable to you: never fact-invalidate one. To correct a user_stated fact, fact-add the newer truth with "invalidates" so it supersedes on the record.`;

function renderEpisodes(episodes: Episode[]): string {
  return episodes
    .map((episode) => `- [${episode.ts} · ${episode.outcome}${episode.channel === "voice" ? " · voice" : ""}] task: ${episode.task}\n  reply: ${episode.reply}`)
    .join("\n");
}

function renderFacts(facts: Fact[]): string {
  return facts.map((fact) => `- [${fact.id} · ${fact.ts} · ${fact.source}${fact.scope === "workspace" ? " · workspace" : ""}] ${fact.text}`).join("\n");
}

export async function runConsolidation(options: ConsolidateRunOptions): Promise<ConsolidateResult> {
  const now = options.now ?? new Date();
  const none: ConsolidateResult = { ran: false, episodesSeen: 0, factsAdded: 0, factsInvalidated: 0, memoryEdits: 0, opsSkipped: 0 };
  const state = await readConsolidateState(options.memoryDir);

  if (!options.force && runsInLastDay(state, now) >= options.maxPerDay) {
    return { ...none, reason: `daily cap reached (${options.maxPerDay}/day)` };
  }

  const page = await readEpisodesFrom(options.memoryDir, state.episodeCursor);
  const episodes = page.items.slice(-MAX_EPISODES_PER_RUN);
  if (!episodes.length && !options.force) {
    return { ...none, reason: "nothing new since last run" };
  }

  const factOps = await readFactOpsFrom(options.memoryDir, 0);
  const { active } = replayFacts(factOps.items);
  // The shared workspace store rides along for dedupe, supersession targets,
  // and "don't restate what's known" (§5) — rendered with a scope marker.
  const sharedActive = options.sharedFactsDir ? replayFacts((await readFactOpsFrom(options.sharedFactsDir, 0)).items).active : [];
  const promptFacts = [...active, ...sharedActive].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, MAX_FACTS_IN_PROMPT);

  const core: string[] = [];
  for (const file of [CORE_MEMORY_FILE, USER_MEMORY_FILE]) {
    const memoryState = await options.memoryStore.readState(options.memoryDir, file);
    core.push(`## ${file} (${memoryState.chars}/${memoryState.limit} chars)\n${memoryState.content.trim() || "(empty)"}`);
  }

  const user = [
    `# NEW EPISODES (${episodes.length})`,
    episodes.length ? renderEpisodes(episodes) : "(none)",
    `# ACTIVE FACTS (${active.length}${active.length > promptFacts.length ? `, newest ${promptFacts.length} shown` : ""})`,
    promptFacts.length ? renderFacts(promptFacts) : "(none)",
    "# CORE MEMORY FILES",
    ...core,
  ].join("\n\n");

  const reply = await options.llm({ system: SYSTEM_PROMPT, user, model: options.model });
  const ops = parseConsolidateOps(reply);

  const result: ConsolidateResult = { ran: true, episodesSeen: episodes.length, factsAdded: 0, factsInvalidated: 0, memoryEdits: 0, opsSkipped: 0 };
  // Applies are guarded, not trusted: duplicates drop, invalidations of
  // unknown ids drop, memory edits go through mutate's caps + secret filter.
  // Two stores: the agent's own and (when wired) the workspace-shared one;
  // ops route by scope, and each fact invalidates in the store that holds it.
  let currentAgent = active;
  let currentShared = sharedActive;
  const storeOf = (id: string): string | undefined => {
    if (currentAgent.some((fact) => fact.id === id)) return options.memoryDir;
    if (currentShared.some((fact) => fact.id === id)) return options.sharedFactsDir;
    return undefined;
  };
  const factById = (id: string): Fact | undefined => currentAgent.find((fact) => fact.id === id) ?? currentShared.find((fact) => fact.id === id);
  const dropActive = (id: string): void => {
    currentAgent = currentAgent.filter((fact) => fact.id !== id);
    currentShared = currentShared.filter((fact) => fact.id !== id);
  };
  for (const op of ops) {
    if (op.kind === "fact-add") {
      if (findDuplicateFact(currentAgent, op.text) || findDuplicateFact(currentShared, op.text)) {
        result.opsSkipped += 1;
        continue;
      }
      const workspaceScope = op.scope === "workspace" && !!options.sharedFactsDir;
      const targetDir = workspaceScope ? (options.sharedFactsDir as string) : options.memoryDir;
      const id = newId("fact");
      const ts = now.toISOString();
      const fact: Fact = {
        id,
        ts,
        text: op.text,
        ...(op.entities?.length ? { entities: op.entities } : {}),
        source: "consolidator",
        ...(workspaceScope ? { scope: "workspace" as const, actor: `agent:${options.agentId}` } : {}),
        validFrom: ts,
      };
      const write = await appendFactOp(targetDir, { op: "add", ...fact });
      if (!write.ok) {
        result.opsSkipped += 1;
        continue;
      }
      result.factsAdded += 1;
      if (workspaceScope) currentShared = [fact, ...currentShared];
      else currentAgent = [fact, ...currentAgent];
      // Supersession is allowed even on user_stated facts (§13): the old fact
      // keeps its record and points at the newer truth.
      const supersededDir = op.invalidates ? storeOf(op.invalidates) : undefined;
      if (op.invalidates && supersededDir) {
        await appendFactOp(supersededDir, { op: "invalidate", id: op.invalidates, ts, supersededBy: id });
        dropActive(op.invalidates);
        result.factsInvalidated += 1;
      }
    } else if (op.kind === "fact-invalidate") {
      const dir = storeOf(op.id);
      // user_stated facts are immutable to the consolidator (§13): bare
      // invalidation drops; only supersession (above) may retire them.
      if (!dir || factById(op.id)?.source === "user_stated") {
        result.opsSkipped += 1;
        continue;
      }
      await appendFactOp(dir, { op: "invalidate", id: op.id, ts: now.toISOString() });
      dropActive(op.id);
      result.factsInvalidated += 1;
    } else {
      const outcome = await options.memoryStore
        .mutate(options.memoryDir, op.file, op.action, { content: op.content, oldText: op.oldText })
        .catch(() => ({ ok: false }) as const);
      if (outcome.ok) result.memoryEdits += 1;
      else result.opsSkipped += 1;
    }
  }

  await writeConsolidateState(options.memoryDir, {
    episodeCursor: page.nextCursor,
    runs: [...state.runs, now.toISOString()].slice(-RUN_LEDGER_LIMIT),
  });
  return result;
}
