// Every path the system reads or writes is computed here, once. If you are
// join()ing toward ~/.gaia or .gaia/ anywhere else, you are doing it wrong.

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "./env.js";

/** Global GAIA home (agents, skills, setups, logs). GAIA_HOME overrides. */
export function gaiaHome(): string {
  return resolve(env("GAIA_HOME") ?? join(homedir(), ".gaia"));
}

// --- global layout ---------------------------------------------------------

export const globalPaths = {
  /** Daemon-global app state (workspace registry, current workspace). */
  appSettings: () => join(gaiaHome(), "app.json"),
  accounts: () => join(gaiaHome(), "accounts.json"),
  agentsDir: () => join(gaiaHome(), "agents"),
  agentDir: (agentId: string) => join(gaiaHome(), "agents", agentId),
  /** Shared role definitions available to every agent. Agent-local and project
   * role files may layer on top of these defaults. */
  rolesDir: () => join(gaiaHome(), "roles"),
  skillsDir: () => join(gaiaHome(), "skills"),
  setupsDir: () => join(gaiaHome(), "setups"),
  voiceSettings: () => join(gaiaHome(), "voice.json"),
  /** Durable record of live voice-call overrides — swept on boot so a crash
   * mid-call can never leave a "temporary" override applied forever. */
  voiceState: () => join(gaiaHome(), "voice-state.json"),
  voiceLogsDir: () => join(gaiaHome(), "logs", "voice"),
  /** Durable landing spot for dictation audio: per-chunk clips streamed
   * while recording, plus the finalized clip written just before transcribe
   * starts — so a reload or STT failure never loses the recording. */
  voiceClipsDir: () => join(gaiaHome(), "voice-clips"),
  /** Last-known subscription usage per account — the status-bar meter's
   * survives-everything cache: loaded at boot BEFORE the first probe, so a
   * restart (or an unreachable provider) never blanks the chip. */
  usageCache: () => join(gaiaHome(), "usage.json"),
  /** Derived read-aloud audio, content-addressed per speech chunk. */
  ttsCacheDir: () => join(gaiaHome(), "cache", "tts"),
  /** Local model files (embedding/reranker GGUFs) pulled once, checksummed. */
  modelsCacheDir: () => join(gaiaHome(), "cache", "models"),
};

// --- per-agent layout (inside an agent dir, global or project overlay) ------

export const agentPaths = {
  config: (dir: string) => join(dir, "agent.json"),
  personaDir: (dir: string) => join(dir, "persona"),
  soul: (dir: string) => join(dir, "persona", "SOUL.md"),
  intent: (dir: string) => join(dir, "persona", "INTENT.md"),
  rolesDir: (dir: string) => join(dir, "persona", "roles"),
  memoryDir: (dir: string) => join(dir, "persona", "memory"),
};

// --- workspace layout --------------------------------------------------------

export const workspacePaths = {
  dir: (rootDir: string) => join(rootDir, ".gaia"),
  config: (rootDir: string) => join(rootDir, ".gaia", "config.json"),
  agentsOverrideDir: (rootDir: string) => join(rootDir, ".gaia", "agents"),
  skillsDir: (rootDir: string) => join(rootDir, ".gaia", "skills"),
  setupsDir: (rootDir: string) => join(rootDir, ".gaia", "setups"),
  schedules: (rootDir: string) => join(rootDir, ".gaia", "schedules.json"),
  scheduleState: (rootDir: string) => join(rootDir, ".gaia", "schedule-state.json"),
  roomsDir: (rootDir: string) => join(rootDir, ".gaia", "rooms"),
  roomDir: (rootDir: string, roomId: string) => join(rootDir, ".gaia", "rooms", roomId),
  /** Reversible room deletion moves the whole room dir here rather than rm -rf,
   * so a delete is recoverable (restore = move it back). */
  roomTrashDir: (rootDir: string) => join(rootDir, ".gaia", "trash", "rooms"),
  /** Room git worktrees (collab.isolation "worktree"): one isolated checkout
   * per top-level room (summon rooms inherit their owning ancestor's), sharing
   * the workspace repo's object store. */
  worktreesDir: (rootDir: string) => join(rootDir, ".gaia", "worktrees"),
  worktreeDir: (rootDir: string, roomId: string) => join(rootDir, ".gaia", "worktrees", roomId),
  transcript: (rootDir: string, roomId: string) => join(rootDir, ".gaia", "rooms", roomId, "transcript.jsonl"),
  roomState: (rootDir: string, roomId: string) => join(rootDir, ".gaia", "rooms", roomId, "state.json"),
  /** Memory v4 (MEMORY-DESIGN.md): ONE derived index per workspace. */
  memoryDir: (rootDir: string) => join(rootDir, ".gaia", "memory"),
  memoryIndexDb: (rootDir: string) => join(rootDir, ".gaia", "memory", "index.db"),
  memoryEval: (rootDir: string) => join(rootDir, ".gaia", "memory", "eval.json"),
  roomFilesDir: (rootDir: string, roomId: string) => join(rootDir, ".gaia", "rooms", roomId, "files"),
  piSessionsDir: (rootDir: string, roomId: string) => join(rootDir, ".gaia", "rooms", roomId, "pi-sessions"),
  /** Rewound-away transcript lines (edit/retry fork), append-only beside the transcript. */
  roomRewound: (rootDir: string, roomId: string) => join(rootDir, ".gaia", "rooms", roomId, "rewound.jsonl"),
  /** Original lines of sanitize-redacted events, appended BEFORE each rewrite. */
  roomRedactions: (rootDir: string, roomId: string) => join(rootDir, ".gaia", "rooms", roomId, "redactions.jsonl"),
  /** Durable compaction summary, floor-keyed (fed as [summary + tail] on session loss). */
  roomCompaction: (rootDir: string, roomId: string) => join(rootDir, ".gaia", "rooms", roomId, "compaction.json"),
  /** Per-room durable harness session handles ("<harness>:<agent>" keyed). */
  harnessSessions: (rootDir: string, roomId: string) => join(rootDir, ".gaia", "rooms", roomId, "harness-sessions.json"),
  /** Per-room writable scratch a credential-proxied harness may relocate its
   * store into (see HarnessSpec.credentialProxy) — generic, harness-declared. */
  roomProxyScratch: (rootDir: string, roomId: string) => join(rootDir, ".gaia", "rooms", roomId, "proxy-scratch"),
};

/** Invert workspacePaths.roomDir: <root>/.gaia/rooms/<id> → <root>. The bare
 * CLI fallbacks (no daemon) only get GAIA_ROOM_DIR and need the workspace
 * memory index, which is root-scoped. */
export function workspaceRootFromRoomDir(roomDir: string): string {
  return resolve(roomDir, "..", "..", "..");
}

/** Root holding bundled resources (setups/, web/), resolved once.
 * Source-relative resolution (repo root = two levels up from src/core/) works
 * for node/tsx and interpreted bun, but inside a bun single-file executable
 * import.meta.url points at the virtual /$bunfs root and "../.." collapses to
 * "/" — so when the source-relative root has no web/, fall back to dirs near
 * the real binary (next to it, or ../Resources for a macOS .app bundle).
 * GAIA_BUNDLE_DIR overrides everything. fileURLToPath, not URL.pathname —
 * the latter percent-encodes and breaks install paths containing spaces. */
const bundleRoot: string = (() => {
  const override = process.env.GAIA_BUNDLE_DIR;
  if (override) return resolve(override);
  const fromSource = fileURLToPath(new URL("../..", import.meta.url));
  const candidates = [
    fromSource,
    dirname(process.execPath),
    resolve(dirname(process.execPath), "..", "Resources"),
  ];
  return candidates.find((dir) => existsSync(join(dir, "web"))) ?? fromSource;
})();

/** Bundled resources (setups/, web/) shipped inside the install itself. */
export function bundledDir(...segments: string[]): string {
  return resolve(bundleRoot, ...segments);
}
