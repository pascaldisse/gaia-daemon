// Semantic facts as a bi-temporal append-only ops log: supersede, never
// delete. Current state is a replay of the log; invalidated facts stay
// queryable (via `all`) for "what did I believe then".

import { join } from "node:path";
import type { JsonlPage } from "../core/store.js";
import { appendJsonl, readJsonlFrom } from "../core/store.js";
import { looksLikePromptInjection, looksLikeSecret } from "./memory.js";

export type FactSource = "user_stated" | "outcome_verified" | "agent_inferred" | "consolidator";

/** Where a fact lives (§5): agent = the persona's private memoryDir store;
 * workspace = the shared store every persona's recall reads. */
export type FactScope = "agent" | "workspace";

export interface Fact {
  id: string;
  /** When recorded; validFrom (defaults to ts) is when the fact became true. */
  ts: string;
  text: string;
  entities?: string[];
  source: FactSource;
  /** Absent = agent-scope (v3 files are forward-compatible, §14). */
  scope?: FactScope;
  /** Who stated/learned it: "user:<name>" or "agent:<id>". */
  actor?: string;
  validFrom: string;
  validTo?: string;
  supersededBy?: string;
}

export type FactOp =
  | ({ op: "add" } & Fact)
  | { op: "invalidate"; id: string; ts: string; supersededBy?: string };

export const FACTS_FILE = "facts.jsonl";

/** The workspace-shared store (§5): facts about the user/world, readable by
 * every persona. Lives under <workspace>/.gaia/memory/shared/ so it rides the
 * exact same reader/writer/indexer as an agent memoryDir — zero duplication. */
export const WORKSPACE_FACTS_AGENT = "@workspace";
export function sharedFactsDir(workspaceMemoryDir: string): string {
  return join(workspaceMemoryDir, "shared");
}

export interface FactWriteResult {
  ok: boolean;
  message: string;
}

export async function appendFactOp(dir: string, op: FactOp): Promise<FactWriteResult> {
  if (op.op === "add") {
    if (!op.text.trim()) return { ok: false, message: "fact rejected: text is required" };
    if (looksLikeSecret(op.text)) {
      return { ok: false, message: "fact rejected: content looks like a secret" };
    }
    if (looksLikePromptInjection(op.text)) {
      return { ok: false, message: "fact rejected: content looks like a prompt-injection attempt" };
    }
  }
  await appendJsonl(join(dir, FACTS_FILE), op);
  return { ok: true, message: `${op.op} recorded` };
}

export async function readFactOpsFrom(dir: string, cursor: number): Promise<JsonlPage<FactOp>> {
  return readJsonlFrom(join(dir, FACTS_FILE), cursor, factOpFrom);
}

const SOURCES: readonly string[] = ["user_stated", "outcome_verified", "agent_inferred", "consolidator"];

function factOpFrom(raw: unknown): FactOp | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  if (typeof record.id !== "string" || typeof record.ts !== "string") return undefined;
  if (record.op === "invalidate") {
    const op: FactOp = { op: "invalidate", id: record.id, ts: record.ts };
    if (typeof record.supersededBy === "string") op.supersededBy = record.supersededBy;
    return op;
  }
  if (record.op !== "add") return undefined;
  if (typeof record.text !== "string" || !SOURCES.includes(record.source as string)) return undefined;
  if (typeof record.validFrom !== "string") record.validFrom = record.ts;
  if (record.scope !== undefined && record.scope !== "agent" && record.scope !== "workspace") delete record.scope;
  if (record.actor !== undefined && typeof record.actor !== "string") delete record.actor;
  return record as unknown as FactOp;
}

export function replayFacts(ops: FactOp[]): { active: Fact[]; all: Map<string, Fact> } {
  const all = new Map<string, Fact>();
  for (const op of ops) {
    if (op.op === "add") {
      const { op: _kind, ...fact } = op;
      all.set(fact.id, fact);
      continue;
    }
    const target = all.get(op.id);
    if (!target) continue;
    target.validTo = op.ts;
    if (op.supersededBy) target.supersededBy = op.supersededBy;
  }
  const active = [...all.values()]
    .filter((fact) => fact.validTo === undefined)
    .sort((a, b) => b.ts.localeCompare(a.ts));
  return { active, all };
}

export function findDuplicateFact(active: Fact[], text: string): Fact | undefined {
  const needle = normalizeFactText(text);
  return active.find((fact) => normalizeFactText(fact.text) === needle);
}

function normalizeFactText(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}
