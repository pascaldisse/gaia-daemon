// Every path the system reads or writes is computed here, once. If you are
// join()ing toward ~/.gaia or .gaia/ anywhere else, you are doing it wrong.

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { env } from "./env.js";

/** Global GAIA home (agents, skills, setups, logs). GAIA_HOME overrides. */
export function gaiaHome(): string {
  return resolve(env("GAIA_HOME") ?? join(homedir(), ".gaia"));
}

// --- global layout ---------------------------------------------------------

export const globalPaths = {
  agentsDir: () => join(gaiaHome(), "agents"),
  agentDir: (agentId: string) => join(gaiaHome(), "agents", agentId),
  skillsDir: () => join(gaiaHome(), "skills"),
  setupsDir: () => join(gaiaHome(), "setups"),
  voiceSettings: () => join(gaiaHome(), "voice.json"),
  /** Durable record of live voice-call overrides — swept on boot so a crash
   * mid-call can never leave a "temporary" override applied forever. */
  voiceState: () => join(gaiaHome(), "voice-state.json"),
  voiceLogsDir: () => join(gaiaHome(), "logs", "voice"),
  /** Derived read-aloud audio, content-addressed per speech chunk. */
  ttsCacheDir: () => join(gaiaHome(), "cache", "tts"),
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
  transcript: (rootDir: string, roomId: string) => join(rootDir, ".gaia", "rooms", roomId, "transcript.jsonl"),
  roomState: (rootDir: string, roomId: string) => join(rootDir, ".gaia", "rooms", roomId, "state.json"),
  recallDb: (rootDir: string, roomId: string) => join(rootDir, ".gaia", "rooms", roomId, "recall.db"),
  roomFilesDir: (rootDir: string, roomId: string) => join(rootDir, ".gaia", "rooms", roomId, "files"),
  piSessionsDir: (rootDir: string, roomId: string) => join(rootDir, ".gaia", "rooms", roomId, "pi-sessions"),
};

/** Bundled resources (setups/, web/) shipped inside the install itself. */
export function bundledDir(...segments: string[]): string {
  // src2/core/paths.ts → repo root is two levels up from core/.
  return resolve(new URL("../..", import.meta.url).pathname, ...segments);
}
