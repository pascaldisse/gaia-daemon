// Voice settings live in ~/.gaia/voice.json - a plain JSON file like every
// other GAIA setting, edited through the settings UI (Voice tab) or by hand.
// The file is created with defaults on first server start so the tab always
// has something to show; missing or invalid keys fall back to defaults.
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readJsonFile, writeJsonFile } from "../lib/fs.js";
import { gaiaHome } from "../workspace/workspace-loader.js";

// The unmute voice stack is vendored into the repo (unmute/, MIT licensed,
// Copyright 2025 Kyutai), so the default checkout is the bundled one. Resolved
// at runtime (never persisted) so a renamed/moved repo can't leave a stale
// absolute path baked into voice.json.
export function bundledUnmuteDir(): string {
  return resolve(fileURLToPath(new URL("../../unmute", import.meta.url)));
}

export interface VoiceSettings {
  /** unmute backend the browser connects to (and GAIA health-checks). */
  unmuteUrl: string;
  /** Local unmute checkout used to auto-start services. */
  unmuteDir: string;
  /** Start missing voice services automatically when a call is dialed. */
  autoStart: boolean;
  /** How long the stack may take to become healthy (first start loads models). */
  startTimeoutSec: number;
  /** Whether the agent speaks up on its own after a long user silence. */
  speakOnSilence: boolean;
  /** Seconds of silence before the agent speaks up (when enabled). */
  silenceDelaySec: number;
  /** Force thinking off during voice calls; restored on hang-up. */
  disableThinking: boolean;
}

export const VOICE_SETTINGS_DEFAULTS: VoiceSettings = {
  unmuteUrl: "ws://127.0.0.1:8000",
  // Empty = use the bundled checkout, resolved at runtime by readVoiceSettings.
  // Never seed an absolute path here: it would go stale if the repo is moved.
  unmuteDir: "",
  autoStart: true,
  startTimeoutSec: 180,
  speakOnSilence: true,
  silenceDelaySec: 7,
  disableThinking: true,
};

export function voiceSettingsPath(home = gaiaHome()): string {
  return join(home, "voice.json");
}

export async function ensureVoiceSettingsFile(home = gaiaHome()): Promise<void> {
  const path = voiceSettingsPath(home);
  if (existsSync(path)) return;
  await writeJsonFile(path, VOICE_SETTINGS_DEFAULTS);
}

export async function readVoiceSettings(home = gaiaHome()): Promise<VoiceSettings> {
  const settings = { ...VOICE_SETTINGS_DEFAULTS };
  // Missing or malformed file: defaults apply.
  const raw = ((await readJsonFile(voiceSettingsPath(home))) ?? {}) as Record<string, unknown>;
  if (typeof raw.unmuteUrl === "string" && raw.unmuteUrl) settings.unmuteUrl = raw.unmuteUrl;
  if (typeof raw.unmuteDir === "string" && raw.unmuteDir) settings.unmuteDir = raw.unmuteDir;
  if (typeof raw.autoStart === "boolean") settings.autoStart = raw.autoStart;
  if (typeof raw.startTimeoutSec === "number" && raw.startTimeoutSec > 0) settings.startTimeoutSec = raw.startTimeoutSec;
  if (typeof raw.speakOnSilence === "boolean") settings.speakOnSilence = raw.speakOnSilence;
  if (typeof raw.silenceDelaySec === "number" && raw.silenceDelaySec > 0) settings.silenceDelaySec = raw.silenceDelaySec;
  if (typeof raw.disableThinking === "boolean") settings.disableThinking = raw.disableThinking;
  // No explicit override → resolve the bundled checkout now, so the path tracks
  // wherever the daemon currently runs from instead of a value frozen at seed time.
  if (!settings.unmuteDir) settings.unmuteDir = bundledUnmuteDir();
  return settings;
}
