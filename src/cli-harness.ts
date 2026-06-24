// `gaia` CLI subcommands used by harness agents (Claude/Codex) to reach
// memory, recall, and summon without an in-process tool bridge.
//
// Transport split (see HANDOFF-CLAUDE-HARNESS.md §3):
//   reads  → direct disk in this subprocess (safe under any read-only sandbox)
//   writes → localhost HTTP to the running daemon, the single writer
//
// The daemon injects context via env when it spawns the harness:
//   GAIA_MEMORY_DIR  agent memory dir (reads)
//   GAIA_ROOM_DIR    room dir holding transcript.jsonl + recall.db (reads)
//   GAIA_ROOM_ID     current room (writes/summon)
//   GAIA_AGENT_ID    current agent (writes/summon)
//   GAIA_DAEMON_URL  daemon base url (writes/summon)
//   GAIA_DAEMON_TOKEN bearer token mapping to (workspace, agent, room)
import { join } from "node:path";
import { CORE_MEMORY_FILE, MemoryStore } from "./memory/memory-store.js";
import { gaiaToolByVerb } from "./tools/gaia-tools.js";

const MEMORY_USAGE = `Usage:
  gaia mem list                      list memory files
  gaia mem read [file]               print a memory file (default ${CORE_MEMORY_FILE})
  gaia mem add [--file F] <content>  append a memory entry
  gaia mem replace [--file F] --old <text> <content>
  gaia mem remove [--file F] --old <text>`;

const RECALL_USAGE = `Usage: gaia recall [--limit N] <query>`;
const SUMMON_USAGE = `Usage: gaia summon <agent> <task>`;

interface ParsedFlags {
  positional: string[];
  flags: Record<string, string>;
}

// Minimal flag parser: --name value pairs plus positionals. Unknown flags are
// captured generically so callers decide what is required.
function parseFlags(args: string[]): ParsedFlags {
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

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value : undefined;
}

function fail(message: string): number {
  console.error(message);
  return 1;
}

// Reads come straight off disk; writes/summon post to the daemon.
async function daemonPost(path: string, body: unknown): Promise<{ ok: boolean; text: string }> {
  const base = env("GAIA_DAEMON_URL");
  const token = env("GAIA_DAEMON_TOKEN");
  if (!base || !token) {
    return { ok: false, text: "ERROR: this command needs the GAIA daemon; run it from inside a GAIA agent turn." };
  }
  try {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
    });
    const payload = (await response.json().catch(() => ({}))) as { result?: string; error?: string };
    if (!response.ok) return { ok: false, text: `ERROR: ${payload.error ?? `daemon returned ${response.status}`}` };
    return { ok: true, text: payload.result ?? "OK" };
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

  // Writes: go through the daemon (single writer; enforces caps + secret filter).
  if (sub === "add" || sub === "replace" || sub === "remove") {
    const content = rest.positional.join(" ").trim();
    const oldText = rest.flags.old?.trim() ?? "";
    if ((sub === "add" || sub === "replace") && !content) return fail("ERROR: content is required.\n\n" + MEMORY_USAGE);
    if ((sub === "replace" || sub === "remove") && !oldText) return fail("ERROR: --old is required.\n\n" + MEMORY_USAGE);
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
  // Lazy import so `gaia mem` invocations never load node:sqlite (and its
  // experimental warning) for nothing.
  const { searchTranscript } = await import("./memory/recall.js");
  const hits = searchTranscript(
    join(roomDir, "transcript.jsonl"),
    join(roomDir, "recall.db"),
    query,
    Number.isFinite(limit) && limit > 0 ? limit : 8,
  );
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
