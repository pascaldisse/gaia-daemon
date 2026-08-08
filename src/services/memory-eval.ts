// `gaia memory status` + `gaia memory eval` (MEMORY-DESIGN.md §10, §12).
//
// Status: the health table, read straight from the workspace index — the same
// rows the daemon writes and the composer chips render. Works without a
// running daemon; degradation must be visible from ANY surface.
//
// Eval: the user's own history is the benchmark. A JSON file of
// (query → expected evidence) probes runs against the live index and reports
// hit@k / MRR / injected-token cost — before/after any retrieval change.
// Public leaderboards are explicitly out of scope (their answer keys are
// disputed); within-workspace ablation is the only score that matters here.

import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolveMemoryConfig } from "../core/config.js";
import { workspacePaths } from "../core/paths.js";
import { loadWorkspace } from "../domain/workspace.js";
import {
  formatMemoryHits,
  openWorkspaceIndex,
  readHealth,
  searchWorkspaceIndex,
  sharedMemorySource,
  syncWorkspaceIndex,
  workspaceRoomRefs,
  countEmbeddings,
  type MemorySearchHit,
} from "../domain/workspace-index.js";
import { resolveEmbedder, type EmbedderDeps, type ResolvedEmbedder } from "./embeddings.js";

export async function printMemoryStatus(workspaceRoot: string): Promise<string> {
  const dbPath = workspacePaths.memoryIndexDb(workspaceRoot);
  if (!existsSync(dbPath)) {
    return `memory index: not built yet (${dbPath})\nIt builds incrementally on the first turn or recall in this workspace.`;
  }
  const db = openWorkspaceIndex(workspaceRoot);
  try {
    const lines: string[] = [`memory index: ${dbPath}`];
    const rows = readHealth(db);
    if (!rows.length) lines.push("health: nothing recorded yet (no search has run)");
    for (const row of rows) {
      const icon = row.state === "ok" ? "✓" : row.state === "building" ? "…" : "✗";
      lines.push(`${icon} ${row.component.padEnd(9)} ${row.state.padEnd(9)} ${row.detail}  (${row.ts.slice(0, 19)})`);
    }
    const { cached, pending } = countEmbeddings(db);
    lines.push(`vectors: ${cached} cached · ${pending} pending`);
    return lines.join("\n");
  } finally {
    db.close();
  }
}

// --- eval ------------------------------------------------------------------------

export interface EvalProbe {
  id: string;
  query: string;
  /** Whose facts/episodes scope to search as; default = workspace defaultAgent. */
  agent?: string;
  /** Simulate asking FROM this room: its active context window is excluded
   * (self-match, §7) exactly as a live recall from that room would be. The
   * agent's persisted context floor (state.json contextFloors) is honored. */
  fromRoom?: string;
  /** Pass if any top-k hit comes from one of these rooms… */
  expectRooms?: string[];
  /** …or contains one of these substrings (case-insensitive). */
  expectText?: string[];
  k?: number;
}

export interface EvalReport {
  ok: boolean;
  text: string;
}

interface ProbeOutcome {
  probe: EvalProbe;
  rank: number | undefined;
  k: number;
  tokens: number;
  top: MemorySearchHit[];
  /** The probe ran lexical-only although an embedder resolved — loud, per §10. */
  embedNote?: string;
}

const EVAL_EMBED_TIMEOUT_MS = 30_000;

export async function runMemoryEval(workspaceRoot: string, filePath?: string, embedderDeps: EmbedderDeps = {}): Promise<EvalReport> {
  const path = filePath ?? workspacePaths.memoryEval(workspaceRoot);
  if (!existsSync(path)) {
    return {
      ok: false,
      text: `ERROR: no eval file at ${path}\nSeed it with probes: {"probes":[{"id":"…","query":"…","expectRooms":["room-id"],"k":5}]}`,
    };
  }
  let probes: EvalProbe[];
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as { probes?: EvalProbe[] };
    probes = (parsed.probes ?? []).filter((probe) => typeof probe?.id === "string" && typeof probe?.query === "string");
    if (!probes.length) return { ok: false, text: `ERROR: ${path} has no valid probes.` };
  } catch (error) {
    return { ok: false, text: `ERROR: could not parse ${path}: ${error instanceof Error ? error.message : String(error)}` };
  }

  const workspace = await loadWorkspace(workspaceRoot);
  const agents = [
    ...Object.values(workspace.agents).map((agent) => ({ agentId: agent.id, memoryDir: agent.memoryDir })),
    sharedMemorySource(workspaceRoot),
  ];
  const db = openWorkspaceIndex(workspaceRoot);
  try {
    await syncWorkspaceIndex(db, { rooms: workspaceRoomRefs(workspaceRoot), agents });

    // The eval measures the DEPLOYED pipeline: probe queries embed through the
    // same config resolution as live recall, so a lexical-only pass can never
    // silently stand in for the hybrid path. Which arm ran is printed.
    const embedders = new Map<string, ResolvedEmbedder>();
    const configFor = (agentId: string) => resolveMemoryConfig(workspace.config.memory, workspace.agents[agentId]?.memory);
    const embedderFor = async (agentId: string): Promise<ResolvedEmbedder> => {
      const config = configFor(agentId).embeddings;
      const key = JSON.stringify(config);
      let resolved = embedders.get(key);
      if (!resolved) {
        resolved = await resolveEmbedder(config, embedderDeps).catch(
          (error): ResolvedEmbedder => ({ status: "dead", detail: error instanceof Error ? error.message : String(error) }),
        );
        embedders.set(key, resolved);
      }
      return resolved;
    };

    const outcomes: ProbeOutcome[] = [];
    for (const probe of probes) {
      const k = probe.k && probe.k > 0 ? probe.k : 5;
      const agentId = probe.agent ?? workspace.config.defaultAgent;
      const exclude = probe.fromRoom ? { roomId: probe.fromRoom, floorIdx: await contextFloorFor(workspaceRoot, probe.fromRoom, agentId) } : undefined;
      const resolved = await embedderFor(agentId);
      let queryVec: Float32Array | undefined;
      let embedNote: string | undefined;
      if (resolved.embedder) {
        try {
          [queryVec] = await resolved.embedder.embed([probe.query], { timeoutMs: EVAL_EMBED_TIMEOUT_MS, kind: "query" });
        } catch (error) {
          embedNote = `query embed failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      const hits = searchWorkspaceIndex(db, probe.query, {
        agentId,
        limit: k,
        halfLifeDays: configFor(agentId).decayHalfLifeDays,
        ...(queryVec ? { queryVec } : {}),
        ...(exclude ? { exclude } : {}),
      });
      const rank = hits.findIndex((hit) => probeMatches(probe, hit));
      outcomes.push({
        probe,
        rank: rank >= 0 ? rank + 1 : undefined,
        k,
        tokens: Math.ceil(formatMemoryHits(hits).length / 4),
        top: hits,
        ...(embedNote ? { embedNote } : {}),
      });
    }

    const passed = outcomes.filter((outcome) => outcome.rank !== undefined);
    const mrr = outcomes.reduce((sum, outcome) => sum + (outcome.rank ? 1 / outcome.rank : 0), 0) / outcomes.length;
    const lines: string[] = [];
    for (const resolved of embedders.values()) {
      lines.push(
        resolved.status === "ok"
          ? `dense arm: ${resolved.provider}/${resolved.model} (dim ${resolved.embedder?.dim})`
          : `dense arm: OFF — ${resolved.detail}`,
      );
    }
    for (const outcome of outcomes) {
      const status = outcome.rank !== undefined ? `PASS (rank ${outcome.rank})` : "FAIL";
      const note = outcome.embedNote ? ` · lexical-only (${outcome.embedNote})` : "";
      lines.push(`${outcome.rank !== undefined ? "✓" : "✗"} ${outcome.probe.id}: ${status} · hit@${outcome.k} · ~${outcome.tokens} tok injected${note}`);
      if (outcome.rank === undefined) {
        const got = outcome.top.length ? formatMemoryHits(outcome.top).split("\n").map((line) => `    ${line.slice(0, 140)}`).join("\n") : "    (no hits)";
        lines.push(`  expected ${describeExpectation(outcome.probe)}; got:\n${got}`);
      }
    }
    lines.push("");
    lines.push(`eval: ${passed.length}/${outcomes.length} probes pass · MRR ${mrr.toFixed(3)}`);
    return { ok: passed.length === outcomes.length, text: lines.join("\n") };
  } finally {
    db.close();
  }
}

async function contextFloorFor(workspaceRoot: string, roomId: string, agentId: string): Promise<number> {
  try {
    const raw = JSON.parse(await readFile(workspacePaths.roomState(workspaceRoot, roomId), "utf8")) as { contextFloors?: Record<string, number> };
    const floor = raw.contextFloors?.[agentId];
    return typeof floor === "number" && floor > 0 ? floor : 0;
  } catch {
    return 0;
  }
}

function probeMatches(probe: EvalProbe, hit: MemorySearchHit): boolean {
  if (probe.expectRooms?.length && hit.roomId && probe.expectRooms.includes(hit.roomId)) return true;
  if (probe.expectText?.length) {
    const text = hit.text.toLowerCase();
    if (probe.expectText.some((needle) => text.includes(needle.toLowerCase()))) return true;
  }
  return false;
}

function describeExpectation(probe: EvalProbe): string {
  const parts: string[] = [];
  if (probe.expectRooms?.length) parts.push(`room ∈ [${probe.expectRooms.join(", ")}]`);
  if (probe.expectText?.length) parts.push(`text ⊇ one of [${probe.expectText.join(" | ")}]`);
  return parts.join(" or ") || "(no expectation set)";
}
