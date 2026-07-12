// `gaia mem|recall|summon` — the CLI harness agents (Claude/Codex) run inside a
// turn to reach memory, recall, and summon without an in-process tool bridge.
//
// Transport split:
//   reads  → direct disk in this subprocess (safe under any read-only sandbox)
//   writes → localhost HTTP to the running daemon, the single writer
//
// Context arrives via env when the daemon spawns the harness:
//   GAIA_MEMORY_DIR, GAIA_ROOM_DIR, GAIA_ROOM_ID, GAIA_AGENT_ID,
//   GAIA_DAEMON_URL, GAIA_DAEMON_TOKEN

import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { daemonPost as postToDaemon } from "../core/daemon-client.js";
import { env } from "../core/env.js";
import { workspacePaths, workspaceRootFromRoomDir } from "../core/paths.js";
import { CORE_MEMORY_FILE, MemoryStore } from "../domain/memory.js";
import { gaiaToolByVerb } from "../harness/tools.js";
import { compressCaryll, expandCaryll } from "./caryll.js";

const MEMORY_USAGE = `Usage:
  gaia mem list                      list memory files
  gaia mem read [file]               print a memory file (default ${CORE_MEMORY_FILE})
  gaia mem add [--file F] <content>  append a memory entry
  gaia mem batch [--file F] '<json>' atomic batch: [{"action":"add|replace|remove","content":"…","old_text":"…"},…]
  gaia mem replace [--file F] --old <text> <content>
  gaia mem remove [--file F] --old <text>
  gaia memory status                 memory index + embedder health
  gaia memory eval [file]            run the recall eval probes (.gaia/memory/eval.json)`;

const RECALL_USAGE = `Usage: gaia recall [--limit N] [--summarize] <query>
       gaia recall --around <hitId> [--span N] [--offset N]   scroll the raw transcript around a previous hit`;
const SUMMON_USAGE = `Usage: gaia summon [--worktree] <agent> <task>`;
const RESUME_USAGE = `Usage: gaia resume <roomId> "<message>"`;
const DREAM_USAGE = `Usage:
  gaia dream [agent]           propose a memory consolidation for [agent] (default: current agent)
  gaia dream [agent] --apply   apply the proposal from the last dream run`;
const CARYLL_USAGE = `Usage:
  gaia caryll compress <file> [-o <out>]  compress a file in place (or to <out>)
  gaia caryll expand <file> [-o <out>]    expand a file (default out: stdout)
  gaia caryll stats <file>                compress in memory and print stats only`;

// Minimal flag parser: --name value pairs plus positionals.
function parseFlags(args: string[], booleans: ReadonlySet<string> = new Set()): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const name = arg.slice(2);
      if (booleans.has(name)) {
        flags[name] = "true";
      } else {
        flags[name] = args[i + 1] ?? "";
        i++;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function fail(message: string): number {
  console.error(message);
  return 1;
}

async function daemonPost(path: string, body: unknown): Promise<{ ok: boolean; text: string }> {
  const url = env("GAIA_DAEMON_URL");
  const token = env("GAIA_DAEMON_TOKEN");
  if (!url || !token) {
    return { ok: false, text: "ERROR: this command needs the GAIA daemon; run it from inside a GAIA agent turn." };
  }
  try {
    const { ok, status, payload } = await postToDaemon({ url, token }, path, body);
    if (!ok) return { ok: false, text: `ERROR: ${typeof payload.error === "string" ? payload.error : `daemon returned ${status}`}` };
    return { ok: true, text: typeof payload.result === "string" ? payload.result : "OK" };
  } catch (error) {
    return { ok: false, text: `ERROR: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** Workspace root for user-facing memory commands: inside an agent turn the
 * room dir is in env; from a shell, the cwd must be a GAIA workspace. */
function resolveWorkspaceRoot(): string | undefined {
  const roomDir = env("GAIA_ROOM_DIR");
  if (roomDir) return workspaceRootFromRoomDir(roomDir);
  return existsSync(workspacePaths.dir(process.cwd())) ? process.cwd() : undefined;
}

async function runMem(args: string[]): Promise<number> {
  const sub = args[0];
  const rest = parseFlags(args.slice(1));
  const file = rest.flags.file?.trim() || CORE_MEMORY_FILE;

  // Workspace-level surfaces (health + eval) — read the index directly; they
  // work with or without a running daemon. Lazy import keeps `gaia mem add`
  // from paying for node:sqlite.
  if (sub === "status" || sub === "eval") {
    const root = resolveWorkspaceRoot();
    if (!root) return fail("ERROR: not inside a GAIA workspace (no .gaia/ here and no GAIA_ROOM_DIR).");
    const { printMemoryStatus, runMemoryEval } = await import("./memory-eval.js");
    if (sub === "status") {
      console.log(await printMemoryStatus(root));
      return 0;
    }
    // The eval measures the deployed pipeline, so it gets the same managed
    // sidecar bring-up the daemon has (an already-listening server is reused;
    // only a child spawned here is stopped on the way out).
    const { EmbedSidecar } = await import("./embed-sidecar.js");
    const sidecar = new EmbedSidecar({ log: (message) => console.error(message) });
    try {
      const report = await runMemoryEval(root, rest.positional[0]?.trim() || undefined, {
        ensureLocalSidecar: (modelId) => sidecar.ensure(modelId),
      });
      console.log(report.text);
      return report.ok ? 0 : 1;
    } finally {
      sidecar.dispose();
    }
  }

  // Reads: direct disk via the shared MemoryStore core.
  if (sub === "list" || sub === "read") {
    const dir = env("GAIA_MEMORY_DIR");
    if (!dir) return fail("ERROR: GAIA_MEMORY_DIR is not set.");
    const store = new MemoryStore();
    if (sub === "list") {
      const files = await store.listFiles(dir);
      console.log(files.map((info) => `${info.file} (${info.chars}/${info.limit} chars)`).join("\n") || "no memory files");
      return 0;
    }
    const readFile = rest.positional[0]?.trim() || file;
    const state = await store.readState(dir, readFile);
    console.log(state.content || `(empty: ${readFile})`);
    return 0;
  }

  // Writes: through the daemon (single writer; enforces caps + secret filter).
  if (sub === "add" || sub === "replace" || sub === "remove") {
    const content = rest.positional.join(" ").trim();
    const oldText = rest.flags.old?.trim() ?? "";
    if ((sub === "add" || sub === "replace") && !content) return fail(`ERROR: content is required.\n\n${MEMORY_USAGE}`);
    if ((sub === "replace" || sub === "remove") && !oldText) return fail(`ERROR: --old is required.\n\n${MEMORY_USAGE}`);
    const result = await daemonPost("/api/harness/memory", { action: sub, file, content, old_text: oldText });
    console.log(result.text);
    return result.ok ? 0 : 1;
  }

  // Atomic batch (§5): all ops validate against the final budget, one commit.
  if (sub === "batch") {
    let operations: unknown;
    try {
      operations = JSON.parse(rest.positional.join(" ").trim() || "[]");
    } catch (error) {
      return fail(`ERROR: operations must be valid JSON: ${error instanceof Error ? error.message : String(error)}\n\n${MEMORY_USAGE}`);
    }
    if (!Array.isArray(operations) || !operations.length) return fail(`ERROR: operations must be a non-empty JSON array.\n\n${MEMORY_USAGE}`);
    const result = await daemonPost("/api/harness/memory", { file, operations });
    console.log(result.text);
    return result.ok ? 0 : 1;
  }

  return fail(MEMORY_USAGE);
}

async function runRecall(args: string[]): Promise<number> {
  const { positional, flags } = parseFlags(args, new Set(["summarize"]));
  const around = Number.parseInt(flags.around ?? "", 10);
  const query = positional.join(" ").trim();
  if (!query && !Number.isFinite(around)) return fail(RECALL_USAGE);
  const parsed = Number.parseInt(flags.limit ?? "", 10);
  const limit = Number.isFinite(parsed) && parsed > 0 ? parsed : 8;
  const span = Number.parseInt(flags.span ?? "", 10);
  const offset = Number.parseInt(flags.offset ?? "", 10);

  // Deep search + scroll run daemon-side (facts + episodes + room history,
  // with the embedding index and reranker the daemon owns); the subprocess
  // never holds a key.
  if (env("GAIA_DAEMON_URL") && env("GAIA_DAEMON_TOKEN")) {
    const result = Number.isFinite(around)
      ? await daemonPost("/api/harness/recall", {
          around,
          ...(Number.isFinite(span) ? { span } : {}),
          ...(Number.isFinite(offset) ? { offset } : {}),
        })
      : await daemonPost("/api/harness/recall", { query, limit, ...(flags.summarize !== undefined ? { summarize: true } : {}) });
    console.log(result.text);
    return result.ok ? 0 : 1;
  }

  // No daemon (bare CLI use): the workspace memory index, direct disk,
  // lexical-only. Lazy import so `gaia mem` never loads node:sqlite for nothing.
  const roomDir = env("GAIA_ROOM_DIR");
  if (!roomDir) return fail("ERROR: GAIA_ROOM_DIR is not set.");
  const { bareWorkspaceRecall, formatMemoryHits, scrollTranscriptWindow } = await import("../domain/workspace-index.js");
  if (Number.isFinite(around)) {
    const window = await scrollTranscriptWindow(workspaceRootFromRoomDir(roomDir), around, {
      ...(Number.isFinite(span) ? { span } : {}),
      ...(Number.isFinite(offset) ? { offset } : {}),
    });
    console.log(window ?? `no transcript hit with id ${around} — ids come from recall results ("hit N")`);
    return 0;
  }
  const agentId = env("GAIA_AGENT_ID");
  const memoryDir = env("GAIA_MEMORY_DIR");
  const hits = await bareWorkspaceRecall(workspaceRootFromRoomDir(roomDir), query, {
    ...(agentId && memoryDir ? { agentId, memoryDir } : {}),
    limit,
  });
  console.log(hits.length ? formatMemoryHits(hits, { full: true }) : "no matches in memory or room history");
  return 0;
}

async function runSummon(args: string[]): Promise<number> {
  const ownWorktree = args[0] === "--worktree";
  const { positional } = parseFlags(ownWorktree ? args.slice(1) : args);
  const agent = positional[0];
  const task = positional.slice(1).join(" ").trim();
  if (!agent || !task) return fail(SUMMON_USAGE);
  const result = await daemonPost("/api/harness/summon", { agent, task, ownWorktree });
  console.log(result.text);
  return result.ok ? 0 : 1;
}

// `gaia resume <roomId> "<message>"` — send a follow-up message into an
// EXISTING room/sub-room to resume or steer its worker, instead of firing a
// brand-new summon. Same fire-and-forget shape as summon: the daemon's
// sendMessage steers a running turn or starts a fresh one if idle, and this
// call returns as soon as that's kicked off, never waiting on the turn.
async function runResume(args: string[]): Promise<number> {
  const { positional } = parseFlags(args);
  const room = positional[0];
  const message = positional.slice(1).join(" ").trim();
  if (!room || !message) return fail(RESUME_USAGE);
  const result = await daemonPost("/api/harness/resume", { room, message });
  console.log(result.text);
  return result.ok ? 0 : 1;
}

// `gaia dream` — user-triggered memory consolidation ("Dream v2"). Unlike
// mem/recall/summon it is never granted to an agent (no GaiaTool entry, no
// Claude/Pi grant): a person runs it from a shell against their own workspace.
// It still needs the daemon-wired consolidation LLM (consolidateLlm(), built
// in src/daemon.ts), so — same as memory writes and summon, NOT the caryll
// template — it routes over daemonPost to the running daemon; never runs bare.
async function runDream(args: string[]): Promise<number> {
  const { positional, flags } = parseFlags(args, new Set(["apply"]));
  if (positional.length > 1) return fail(DREAM_USAGE);
  // "current agent" resolution mirrors runRecall's bare-mode fallback below:
  // env GAIA_AGENT_ID is the invoking agent when none is given explicitly.
  const agent = positional[0]?.trim() || env("GAIA_AGENT_ID");
  const apply = flags.apply === "true";

  const result = await daemonPost("/api/harness/dream", { agent, apply });
  console.log(result.text);
  return result.ok ? 0 : 1;
}

function statsLine(stats: { tokensBefore: number; tokensAfter: number; legendEntries: number }): string {
  const saved = stats.tokensBefore > 0 ? Math.round((1 - stats.tokensAfter / stats.tokensBefore) * 100) : 0;
  return `tokens ${stats.tokensBefore} -> ${stats.tokensAfter} (${saved}% saved, ${stats.legendEntries} legend entries)`;
}

async function runCaryll(args: string[]): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  const positional: string[] = [];
  let out: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "-o") {
      out = rest[i + 1];
      i++;
    } else {
      positional.push(rest[i]);
    }
  }
  const file = positional[0]?.trim();
  if (!sub || !file) return fail(CARYLL_USAGE);

  try {
    if (sub === "compress") {
      const text = await readFile(file, "utf8");
      const { output, stats } = compressCaryll(text);
      // Pascal's ruling 2026-07-09: no filename/extension changes — the
      // `~caryll/1` header makes the format self-describing, so default is
      // in-place. Round trip is bit-lossless; `gaia caryll expand` restores.
      await writeFile(out?.trim() || file, output);
      console.log(statsLine(stats));
      return 0;
    }

    if (sub === "expand") {
      const text = await readFile(file, "utf8");
      const output = expandCaryll(text);
      if (out?.trim()) {
        await writeFile(out.trim(), output);
      } else {
        console.log(output);
      }
      return 0;
    }

    if (sub === "stats") {
      const text = await readFile(file, "utf8");
      const { stats } = compressCaryll(text);
      console.log(statsLine(stats));
      return 0;
    }
  } catch (error) {
    return fail(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  }

  return fail(CARYLL_USAGE);
}

/** Dispatches `gaia mem|recall|summon|resume|caryll|dream …`. Returns a process exit code. */
export async function runHarnessCommand(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  // `caryll` is a plain file-transform CLI utility, not an agent GaiaTool
  // (no Claude grant / Pi tool / system-prompt pointer) — dispatched directly,
  // ahead of the registry-driven switch below.
  if (command === "caryll") return runCaryll(rest);
  // `dream` is daemon-backed like memory/recall/summon (needs the daemon's
  // consolidation LLM) but, like caryll, is never granted to an agent — a
  // person runs it, not a harness — so it also dispatches directly rather
  // than through the GAIA_TOOLS registry below.
  if (command === "dream") return runDream(rest);
  const tool = command ? gaiaToolByVerb(command) : undefined;
  switch (tool?.id) {
    case "memory":
      return runMem(rest);
    case "recall":
      return runRecall(rest);
    case "summon":
      return runSummon(rest);
    case "resume":
      return runResume(rest);
    default:
      return fail(`Unknown command: gaia ${command}`);
  }
}
