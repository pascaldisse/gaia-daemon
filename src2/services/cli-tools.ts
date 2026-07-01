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

import { join } from "node:path";
import { daemonPost as postToDaemon } from "../core/daemon-client.js";
import { env } from "../core/env.js";
import { CORE_MEMORY_FILE, MemoryStore } from "../domain/memory.js";
import { gaiaToolByVerb } from "../harness/tools.js";

const MEMORY_USAGE = `Usage:
  gaia mem list                      list memory files
  gaia mem read [file]               print a memory file (default ${CORE_MEMORY_FILE})
  gaia mem add [--file F] <content>  append a memory entry
  gaia mem replace [--file F] --old <text> <content>
  gaia mem remove [--file F] --old <text>`;

const RECALL_USAGE = `Usage: gaia recall [--limit N] <query>`;
const SUMMON_USAGE = `Usage: gaia summon <agent> <task>`;

// Minimal flag parser: --name value pairs plus positionals.
function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string> } {
  const positional: string[] = [];
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      flags[arg.slice(2)] = args[i + 1] ?? "";
      i++;
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

async function runMem(args: string[]): Promise<number> {
  const sub = args[0];
  const rest = parseFlags(args.slice(1));
  const file = rest.flags.file?.trim() || CORE_MEMORY_FILE;

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

  return fail(MEMORY_USAGE);
}

async function runRecall(args: string[]): Promise<number> {
  const { positional, flags } = parseFlags(args);
  const query = positional.join(" ").trim();
  if (!query) return fail(RECALL_USAGE);
  const roomDir = env("GAIA_ROOM_DIR");
  if (!roomDir) return fail("ERROR: GAIA_ROOM_DIR is not set.");
  const limit = Number.parseInt(flags.limit ?? "", 10);
  // Lazy import so `gaia mem` invocations never load node:sqlite for nothing.
  const { searchTranscript } = await import("../domain/recall.js");
  const hits = searchTranscript(join(roomDir, "transcript.jsonl"), join(roomDir, "recall.db"), query, Number.isFinite(limit) && limit > 0 ? limit : 8);
  console.log(
    hits.length
      ? hits.map((hit) => `[${hit.timestamp}]${hit.channel === "voice" ? " 🎙" : ""} ${hit.author}: ${hit.snippet}`).join("\n")
      : "no matches in the room history",
  );
  return 0;
}

async function runSummon(args: string[]): Promise<number> {
  const { positional } = parseFlags(args);
  const agent = positional[0];
  const task = positional.slice(1).join(" ").trim();
  if (!agent || !task) return fail(SUMMON_USAGE);
  const result = await daemonPost("/api/harness/summon", { agent, task });
  console.log(result.text);
  return result.ok ? 0 : 1;
}

/** Dispatches `gaia mem|recall|summon …`. Returns a process exit code. */
export async function runHarnessCommand(args: string[]): Promise<number> {
  const [command, ...rest] = args;
  const tool = command ? gaiaToolByVerb(command) : undefined;
  switch (tool?.id) {
    case "memory":
      return runMem(rest);
    case "recall":
      return runRecall(rest);
    case "summon":
      return runSummon(rest);
    default:
      return fail(`Unknown command: gaia ${command}`);
  }
}
