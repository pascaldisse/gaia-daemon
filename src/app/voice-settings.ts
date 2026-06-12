// Voice settings live in ~/.gaia/voice.json - a plain JSON file like every
// other GAIA setting, edited through the settings UI (Voice tab) or by hand.
// The file is created with defaults on first server start so the tab always
// has something to show; missing or invalid keys fall back to defaults.
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gaiaHome } from "../workspace/workspace-loader.js";

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
  unmuteDir: "/Users/pascaldisse/projects/Codex/AIWaifu/unmute",
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
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, `${JSON.stringify(VOICE_SETTINGS_DEFAULTS, null, 2)}\n`, "utf8");
  await rename(tempPath, path);
}

export async function readVoiceSettings(home = gaiaHome()): Promise<VoiceSettings> {
  const settings = { ...VOICE_SETTINGS_DEFAULTS };
  try {
    const raw = JSON.parse(await readFile(voiceSettingsPath(home), "utf8")) as Record<string, unknown>;
    if (typeof raw.unmuteUrl === "string" && raw.unmuteUrl) settings.unmuteUrl = raw.unmuteUrl;
    if (typeof raw.unmuteDir === "string" && raw.unmuteDir) settings.unmuteDir = raw.unmuteDir;
    if (typeof raw.autoStart === "boolean") settings.autoStart = raw.autoStart;
    if (typeof raw.startTimeoutSec === "number" && raw.startTimeoutSec > 0) settings.startTimeoutSec = raw.startTimeoutSec;
    if (typeof raw.speakOnSilence === "boolean") settings.speakOnSilence = raw.speakOnSilence;
    if (typeof raw.silenceDelaySec === "number" && raw.silenceDelaySec > 0) settings.silenceDelaySec = raw.silenceDelaySec;
    if (typeof raw.disableThinking === "boolean") settings.disableThinking = raw.disableThinking;
  } catch {
    // Missing or malformed file: defaults apply.
  }
  return settings;
}
