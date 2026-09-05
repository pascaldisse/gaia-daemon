// W4 A16 — edit/resend regression: ephemeral-daemon SETUP + evidence-verification
// helpers (unit-tested, gate-safe, never starts a daemon — CPU law) plus one
// OPT-IN live test that drives an already-running ephemeral daemon and reads
// its transcript/rewound/pi-session files as ground truth.
//
// Base: main 51a71cf. Source docs (read before touching this file):
//   docs/REFACTOR-LIVE-RESULTS-20260902.md — A6 mixed-mention/edit PASS,
//     ADV-013 (cwd workspace missing .gaia/config.json -> GET /api/app 500).
//   docs/EDIT-RESEND-LIVETEST.md — Q1/Q2/Q3 playbook this codifies: pi-session-
//     only history, edit/retry forks (forkAtMessage, no WAL replay, old tail
//     stays off-branch), mixed-agent turns don't desync the fork target.
//
// Gate (`bun run check` + `bun test test/edit-resend-live.test.ts`) exercises
// ONLY the seed/env helpers below — file-system assertions, zero network, zero
// subprocess. The live HTTP flow is owned by 陰 (see docs/REFACTOR-LIVE-QUEUE.md)
// and is opt-in via GAIA_LIVE_EDIT_RESEND=1; default runs `test.skip` it.

import { test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import "../src/harness/index.js";
import { ensureAccountsFile } from "../src/domain/accounts.js";
import { scaffoldGlobalAgent } from "../src/domain/agents.js";
import { DEFAULT_ROOM, initWorkspace } from "../src/domain/workspace.js";
import { globalPaths, workspacePaths } from "../src/core/paths.js";
import { readJsonlFrom } from "../src/core/store.js";
import type { WorkspaceRecord } from "../src/core/types/workspace.js";
import type { RoomEvent } from "../src/core/types/events.js";

// ---------------------------------------------------------------------------
// Paths — everything lives under THIS worktree, never /tmp (AGENTS.md 非/tmp).
// ---------------------------------------------------------------------------

const worktreeRoot = fileURLToPath(new URL("..", import.meta.url));
const liveRunsRoot = join(worktreeRoot, ".gaia", "live-test-runs"); // git-ignored (.gaia/)

const LUNA_AGENT_ID = "luna";
const DEFAULT_LIVE_PORT = 18787;

interface EphemeralDaemonSeed {
  /** Isolated GAIA_HOME — agents/luna + accounts.json seeded here. */
  home: string;
  /** Daemon cwd workspace — .gaia/config.json already exists (ADV-013 fix:
   * initWorkspace() runs BEFORE the daemon ever boots against this dir). */
  workspace: string;
  cleanup(): void;
}

/** Seeds an isolated GAIA_HOME (agents/luna + accounts.json) and an
 * initialized workspace directory under this worktree — the ephemeral-daemon
 * pattern from docs/EDIT-RESEND-LIVETEST.md / REFACTOR-LIVE-RESULTS-20260902.
 * Does NOT start a daemon (that step is opt-in + owned by 陰, see below).
 *
 * ADV-011 note: seeds+uses `luna` specifically — the original "Unknown agent:
 * luna" live failure was a seed bug (agent never scaffolded), not a daemon
 * regression; scaffoldGlobalAgent here is the fix, not a copy of a real
 * ~/.gaia/agents/luna (no credentials, no persona bytes travel with the repo).
 *
 * ADV-013 note: `initWorkspace(workspace)` must run against the SAME
 * directory the daemon is later given as `cwd` — daemon boot auto-registers
 * cwd as a workspace whenever the `.gaia/` dir exists, but `loadWorkspace`/
 * `GET /api/app` 500 if `.gaia/config.json` is missing. Registering a
 * *different* workspace after boot (as the live A5c failure did) does not
 * fix this — the cwd auto-workspace itself needs the config file. */
async function seedEphemeralDaemonHome(label: string): Promise<EphemeralDaemonSeed> {
  const runId = `${label}-${randomUUID().slice(0, 8)}`;
  const home = join(liveRunsRoot, `${runId}-home`);
  const workspace = join(liveRunsRoot, `${runId}-ws`);
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });

  const previousHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = home;
  try {
    await scaffoldGlobalAgent(globalPaths.agentsDir(), LUNA_AGENT_ID, { displayName: "Luna" });
    ensureAccountsFile(); // empty shell; a live run needs 陰 to add a real luna-capable OAuth account.
    await initWorkspace(workspace); // writes workspace/.gaia/config.json — ADV-013.
  } finally {
    if (previousHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = previousHome;
  }

  return {
    home,
    workspace,
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}

/** Env for spawning the ephemeral daemon subprocess. GAIA_PARENT_PID is
 * explicitly UNSET — EDIT-RESEND-LIVETEST.md § Incidents: a live daemon
 * restart previously killed a lane's ephemeral daemon because it had
 * inherited GAIA_PARENT_PID from the parent GAIA shell (installParentWatchdog,
 * src/server/http.ts), which polls that pid and exits the moment it's gone —
 * even though the ephemeral daemon's OWN parent shell was unrelated. */
function liveDaemonEnv(seed: EphemeralDaemonSeed, port: number = DEFAULT_LIVE_PORT): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
  delete env.GAIA_PARENT_PID;
  env.GAIA_HOME = seed.home;
  env.GAIA_PORT = String(port);
  return env;
}

// ---------------------------------------------------------------------------
// Unit tests — gate-safe: no daemon, no network, no subprocess.
// ---------------------------------------------------------------------------

test("seedEphemeralDaemonHome: agents/luna scaffolded + accounts.json + workspace .gaia/config.json (ADV-013)", async () => {
  const seed = await seedEphemeralDaemonHome("adv013");
  try {
    assert.ok(existsSync(join(seed.home, "agents", LUNA_AGENT_ID, "agent.json")), "agents/luna must be scaffolded in the ephemeral GAIA_HOME");
    assert.ok(existsSync(join(seed.home, "accounts.json")), "accounts.json must be seeded (empty shell) in the ephemeral GAIA_HOME");

    const configPath = join(seed.workspace, ".gaia", "config.json");
    assert.ok(existsSync(configPath), "daemon cwd .gaia/config.json must exist BEFORE daemon boot (ADV-013)");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as { room?: string };
    assert.equal(typeof config.room, "string", "workspace config must declare its default room");
  } finally {
    seed.cleanup();
  }
});

test("seedEphemeralDaemonHome: home + workspace live under this worktree, never /tmp", async () => {
  const seed = await seedEphemeralDaemonHome("no-tmp");
  try {
    for (const dir of [seed.home, seed.workspace]) {
      assert.ok(dir.startsWith(worktreeRoot), `${dir} must live under the worktree (${worktreeRoot})`);
      assert.ok(!dir.startsWith("/tmp") && !dir.includes("/tmp/"), `${dir} must never be under /tmp`);
    }
  } finally {
    seed.cleanup();
  }
});

test("liveDaemonEnv: GAIA_PARENT_PID stripped even when inherited, GAIA_PORT defaults to 18787", async () => {
  const seed = await seedEphemeralDaemonHome("env");
  const previousParentPid = process.env.GAIA_PARENT_PID;
  process.env.GAIA_PARENT_PID = "99999"; // simulate an inherited watchdog pid
  try {
    const env = liveDaemonEnv(seed);
    assert.equal(env.GAIA_PARENT_PID, undefined, "GAIA_PARENT_PID must be stripped, not merely left inherited");
    assert.equal(env.GAIA_PORT, String(DEFAULT_LIVE_PORT), "GAIA_PORT must default to 18787");
    assert.equal(env.GAIA_HOME, seed.home, "GAIA_HOME must point at the seeded ephemeral home");

    const explicit = liveDaemonEnv(seed, 19999);
    assert.equal(explicit.GAIA_PORT, "19999", "GAIA_PORT must honor an explicit port parameter");
  } finally {
    if (previousParentPid === undefined) delete process.env.GAIA_PARENT_PID;
    else process.env.GAIA_PARENT_PID = previousParentPid;
    seed.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Live evidence readers — pure disk parsing, reused by both the unit test
// below (on hand-written fixtures) and the opt-in live test (on real daemon
// output). "Truth read from disk, not API" (EDIT-RESEND-LIVETEST.md).
// ---------------------------------------------------------------------------

interface PiSessionEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  message?: { role?: string; content?: unknown };
}

async function readTranscript(workspace: string, roomId: string): Promise<RoomEvent[]> {
  const page = await readJsonlFrom<RoomEvent>(workspacePaths.transcript(workspace, roomId), 0, (raw) => raw as RoomEvent);
  return page.items;
}

async function readRewound(workspace: string, roomId: string): Promise<RoomEvent[]> {
  const page = await readJsonlFrom<RoomEvent>(workspacePaths.roomRewound(workspace, roomId), 0, (raw) => raw as RoomEvent);
  return page.items;
}

/** All pi-session entries for one agent in one room, across every session
 * file under pi-sessions/<agentId>/ (fork spawns a NEW file; the pre-fork
 * file is left in place, off-branch — see EDIT-RESEND-LIVETEST.md Q2). */
async function readPiSessionEntries(workspace: string, roomId: string, agentId: string): Promise<PiSessionEntry[]> {
  const dir = join(workspacePaths.piSessionsDir(workspace, roomId), agentId);
  if (!existsSync(dir)) return [];
  const entries: PiSessionEntry[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".jsonl")) continue;
    const page = await readJsonlFrom<PiSessionEntry>(join(dir, name), 0, (raw) => raw as PiSessionEntry);
    entries.push(...page.items);
  }
  return entries;
}

/** Text-substring evidence a token round-tripped through a pi message entry. */
function entryCarriesText(entry: PiSessionEntry, token: string): boolean {
  return entry.type === "message" && JSON.stringify(entry.message ?? {}).includes(token);
}

test("evidence readers: transcript/rewound/pi-session parsing on hand-written fixtures", async () => {
  const seed = await seedEphemeralDaemonHome("fixtures");
  try {
    const roomId = DEFAULT_ROOM;
    const roomDir = workspacePaths.roomDir(seed.workspace, roomId);
    mkdirSync(roomDir, { recursive: true });
    const sessionDir = join(workspacePaths.piSessionsDir(seed.workspace, roomId), LUNA_AGENT_ID);
    mkdirSync(sessionDir, { recursive: true });

    const transcriptLines = [
      { id: "u1", timestamp: "t", author: "user", targets: [], text: "@luna TOKEN-A1" } satisfies RoomEvent,
      { id: "a1", timestamp: "t", author: LUNA_AGENT_ID, text: "TOKEN-A1-REPLY" } satisfies RoomEvent,
      { id: "u2edit", timestamp: "t", author: "user", targets: [], text: "TOKEN-A2-EDITED" } satisfies RoomEvent,
      { id: "a2edit", timestamp: "t", author: LUNA_AGENT_ID, text: "TOKEN-A2-EDITED-REPLY" } satisfies RoomEvent,
    ];
    const rewoundLines = [
      { id: "u2old", timestamp: "t", author: "user", targets: [], text: "TOKEN-A2-OLD" } satisfies RoomEvent,
      { id: "a2old", timestamp: "t", author: LUNA_AGENT_ID, text: "TOKEN-A2-OLD-REPLY" } satisfies RoomEvent,
    ];
    const sessionLines: PiSessionEntry[] = [
      { type: "message", id: "s-u1", parentId: null, timestamp: "t", message: { role: "user", content: [{ type: "text", text: "TOKEN-A1" }] } },
      { type: "message", id: "s-a1", parentId: "s-u1", timestamp: "t", message: { role: "assistant", content: [{ type: "text", text: "TOKEN-A1-REPLY" }] } },
      { type: "message", id: "s-u2old", parentId: "s-a1", timestamp: "t", message: { role: "user", content: [{ type: "text", text: "TOKEN-A2-OLD" }] } },
      { type: "message", id: "s-a2old", parentId: "s-u2old", timestamp: "t", message: { role: "assistant", content: [{ type: "text", text: "TOKEN-A2-OLD-REPLY" }] } },
      // Fork: the edited entry's parent is s-a1 (the reply BEFORE the edited
      // message), not s-u2old — same shape as the real f4b4e0e2/07da2578 pair
      // in REFACTOR-LIVE-RESULTS-20260902.md's A6 result.
      { type: "message", id: "s-u2edit", parentId: "s-a1", timestamp: "t", message: { role: "user", content: [{ type: "text", text: "TOKEN-A2-EDITED" }] } },
      // Fresh tail branches from the edited message, never the rewound tail —
      // the same pi-session evidence shape as REFACTOR-LIVE-RESULTS-20260902.
      { type: "message", id: "s-a2edit", parentId: "s-u2edit", timestamp: "t", message: { role: "assistant", content: [{ type: "text", text: "TOKEN-A2-EDITED-REPLY" }] } },
    ];

    const { appendJsonl } = await import("../src/core/store.js");
    for (const line of transcriptLines) await appendJsonl(workspacePaths.transcript(seed.workspace, roomId), line);
    for (const line of rewoundLines) await appendJsonl(workspacePaths.roomRewound(seed.workspace, roomId), line);
    for (const line of sessionLines) await appendJsonl(join(sessionDir, "session.jsonl"), line);

    const transcript = await readTranscript(seed.workspace, roomId);
    const rewound = await readRewound(seed.workspace, roomId);
    const session = await readPiSessionEntries(seed.workspace, roomId, LUNA_AGENT_ID);

    assert.equal(transcript.length, 4);
    assert.ok(transcript.some((event) => event.text === "TOKEN-A2-EDITED"), "edited text present in the active transcript");
    assert.ok(!transcript.some((event) => event.text.includes("TOKEN-A2-OLD")), "pre-edit old tail must NOT be in the active transcript");

    assert.equal(rewound.length, 2);
    assert.ok(rewound.some((event) => event.text === "TOKEN-A2-OLD"), "pre-edit old tail preserved off-branch in rewound.jsonl");

    const editedMessageEntry = session.find((entry) => entry.message?.role === "user" && entryCarriesText(entry, "TOKEN-A2-EDITED"));
    const oldTailEntry = session.find((entry) => entry.message?.role === "assistant" && entryCarriesText(entry, "TOKEN-A2-OLD"));
    const newTailEntry = session.find((entry) => entry.message?.role === "assistant" && entryCarriesText(entry, "TOKEN-A2-EDITED"));
    assert.ok(editedMessageEntry && oldTailEntry && newTailEntry, "edited message plus old and new pi-session tails must be found");
    assert.equal(newTailEntry!.parentId, editedMessageEntry!.id, "new pi-session tail must parent the edited message");
    assert.notEqual(newTailEntry!.parentId, oldTailEntry!.id, "new pi-session tail must not parent the rewound old tail");
  } finally {
    seed.cleanup();
  }
});

// ---------------------------------------------------------------------------
// OPT-IN live regression — never run by `bun test` (CPU law: this lane never
// starts a daemon). 陰 runs it manually against an already-running ephemeral
// daemon; queued in docs/REFACTOR-LIVE-QUEUE.md. See that file for the full
// build+run recipe.
//
// Required env (all live-run-only, none read by the unit tests above):
//   GAIA_LIVE_EDIT_RESEND=1        opt-in switch — REQUIRED to un-skip this test.
//   LIVE_WORKSPACE_DIR=<abs path>  the initialized workspace dir the running
//                                  daemon was booted with `cwd` = this path
//                                  (i.e. seed.workspace from a prior
//                                  seedEphemeralDaemonHome() call, or any dir
//                                  that has been through initWorkspace()).
//   GAIA_PORT=18787                port the live daemon is listening on
//                                  (must match how it was started; 18787 if
//                                  liveDaemonEnv()'s default was used).
//   LIVE_AUTH_TOKEN=<token>        OPTIONAL bearer token — only needed if the
//                                  live daemon has registered human users
//                                  (`createUser`); a fresh ephemeral GAIA_HOME
//                                  with no users needs none (requestingHuman
//                                  returns null, room routes allow it while
//                                  membership is empty).
//
// Build input: a compiled daemon binary (`bun run build`, per AGENTS.md
// "Compiled bun app" — dev mode is deleted) started with the above env and
// `cwd` = LIVE_WORKSPACE_DIR, and accounts.json in GAIA_HOME carrying a REAL
// luna-capable OAuth account (seedEphemeralDaemonHome() only stubs the shell
// — ensureAccountsFile() writes `{accounts:[]}`; a live run needs a real
// credential added on top, e.g. via `updateAccount`/the accounts UI, before
// boot).
const LIVE_OPT_IN = process.env.GAIA_LIVE_EDIT_RESEND === "1";

test(
  "LIVE opt-in: edit/resend regression — token evidence + fork parent chain + old-tail exclusion",
  { skip: !LIVE_OPT_IN ? "set GAIA_LIVE_EDIT_RESEND=1 against a running ephemeral daemon (docs/REFACTOR-LIVE-QUEUE.md) to run this" : false },
  async () => {
    const workspaceDir = process.env.LIVE_WORKSPACE_DIR;
    assert.ok(workspaceDir?.trim(), "LIVE_WORKSPACE_DIR must point at the running daemon's initialized cwd workspace");
    const port = Number.parseInt(process.env.GAIA_PORT ?? String(DEFAULT_LIVE_PORT), 10);
    const base = `http://127.0.0.1:${port}`;
    const authToken = process.env.LIVE_AUTH_TOKEN;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (authToken) headers.authorization = `Bearer ${authToken}`;

    async function api<T>(path: string, init?: RequestInit): Promise<T> {
      const response = await fetch(`${base}${path}`, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
      if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${response.status} ${await response.text()}`);
      return response.json() as Promise<T>;
    }

    // Discover the workspaceId the running daemon assigned its cwd auto-
    // workspace (registry id format is internal; matching by resolved `path`
    // is the stable contract — see WorkspaceRecord).
    const app = await api<{ workspaces: WorkspaceRecord[] }>("/api/app");
    const record = app.workspaces.find((workspace) => resolve(workspace.path) === resolve(workspaceDir!));
    assert.ok(record, `no workspace registered for ${workspaceDir} — daemon must be booted with cwd=LIVE_WORKSPACE_DIR after initWorkspace()`);
    const workspaceId = record!.id;
    const roomId = DEFAULT_ROOM;

    async function send(text: string): Promise<void> {
      await api(`/api/workspaces/${workspaceId}/rooms/${roomId}/messages`, { method: "POST", body: JSON.stringify({ text }) });
    }
    async function editEvent(eventId: string, text: string): Promise<void> {
      await api(`/api/workspaces/${workspaceId}/rooms/${roomId}/edit`, { method: "POST", body: JSON.stringify({ eventId, text }) });
    }
    async function waitForTranscriptEvent(predicate: (events: RoomEvent[]) => boolean, timeoutMs = 60_000): Promise<RoomEvent[]> {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const events = await readTranscript(workspaceDir!, roomId);
        if (predicate(events)) return events;
        if (Date.now() > deadline) throw new Error("timed out waiting for transcript evidence");
        await new Promise((r) => setTimeout(r, 500));
      }
    }

    const stamp = randomUUID().slice(0, 8);
    const tokenA1 = `TOKEN-${stamp}-A1`;
    const tokenA2Old = `TOKEN-${stamp}-A2-OLD`;
    const tokenA2Edited = `TOKEN-${stamp}-A2-EDITED`;

    // U1 -> reply, U2(old) -> reply, then edit U2's text — mirrors
    // EDIT-RESEND-LIVETEST.md Q2 ("edit/retry: old tail re-sent? -> NO").
    await send(`@${LUNA_AGENT_ID} exact-reply only: ${tokenA1}`);
    await waitForTranscriptEvent((events) => events.some((e) => e.author === LUNA_AGENT_ID && e.text.includes(tokenA1)));

    await send(`exact-reply only: ${tokenA2Old}`);
    const preEdit = await waitForTranscriptEvent((events) => events.some((e) => e.author === LUNA_AGENT_ID && e.text.includes(tokenA2Old)));
    const userU2 = preEdit.find((e) => e.author === "user" && e.text.includes(tokenA2Old));
    assert.ok(userU2, "U2 user event must exist before it can be edited");

    await editEvent(userU2!.id, `exact-reply only: ${tokenA2Edited}`);
    const postEdit = await waitForTranscriptEvent((events) => events.some((e) => e.author === LUNA_AGENT_ID && e.text.includes(tokenA2Edited)));

    // 1) Transcript evidence: edited text present, pre-edit old tail absent.
    assert.ok(postEdit.some((e) => e.text.includes(tokenA2Edited)), "edited token must be in the active transcript");
    assert.ok(!postEdit.some((e) => e.text.includes(tokenA2Old)), "pre-edit old tail must be gone from the active transcript");

    // 2) Rewound evidence: the pre-edit old tail is preserved off-branch.
    const rewound = await readRewound(workspaceDir!, roomId);
    assert.ok(rewound.some((e) => e.text.includes(tokenA2Old)), "pre-edit old tail must be preserved in rewound.jsonl");

    // 3) Pi session parent chain: read the actual fresh assistant tail, then
    // prove it parents the edited user message rather than the rewound tail.
    const session = await readPiSessionEntries(workspaceDir!, roomId, LUNA_AGENT_ID);
    const editedMessageEntry = session.find((entry) => entry.message?.role === "user" && entryCarriesText(entry, tokenA2Edited));
    const oldTailEntry = session.find((entry) => entry.message?.role === "assistant" && entryCarriesText(entry, tokenA2Old));
    const newTailEntry = session.find((entry) => entry.message?.role === "assistant" && entryCarriesText(entry, tokenA2Edited));
    assert.ok(editedMessageEntry && oldTailEntry && newTailEntry, "edited message plus old and new pi-session tails must be found");
    assert.equal(newTailEntry!.parentId, editedMessageEntry!.id, "new pi-session tail must parent the edited message");
    assert.notEqual(newTailEntry!.parentId, oldTailEntry!.id, "new pi-session tail must not parent the rewound old tail");
  },
);
