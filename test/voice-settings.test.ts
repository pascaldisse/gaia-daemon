import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { ensureVoiceSettingsFile, readVoiceSettings, voiceSettingsPath, VOICE_SETTINGS_DEFAULTS } from "../src/app/voice-settings.ts";
import { createTempDir } from "./helpers/temp.ts";

test("ensureVoiceSettingsFile seeds defaults once and never overwrites", async () => {
  const temp = await createTempDir();
  try {
    await ensureVoiceSettingsFile(temp.path);
    assert.ok(existsSync(voiceSettingsPath(temp.path)));
    const written = JSON.parse(await readFile(voiceSettingsPath(temp.path), "utf8"));
    assert.deepEqual(written, VOICE_SETTINGS_DEFAULTS);

    await writeFile(voiceSettingsPath(temp.path), JSON.stringify({ speakOnSilence: false }), "utf8");
    await ensureVoiceSettingsFile(temp.path);
    const kept = JSON.parse(await readFile(voiceSettingsPath(temp.path), "utf8"));
    assert.deepEqual(kept, { speakOnSilence: false });
  } finally {
    await temp.cleanup();
  }
});

test("readVoiceSettings overlays valid keys onto defaults", async () => {
  const temp = await createTempDir();
  try {
    await writeFile(
      voiceSettingsPath(temp.path),
      JSON.stringify({ speakOnSilence: false, silenceDelaySec: 15, disableThinking: false, startTimeoutSec: -5, unmuteUrl: 42 }),
      "utf8",
    );
    const settings = await readVoiceSettings(temp.path);
    assert.equal(settings.speakOnSilence, false);
    assert.equal(settings.silenceDelaySec, 15);
    assert.equal(settings.disableThinking, false);
    // Invalid values fall back to defaults.
    assert.equal(settings.startTimeoutSec, VOICE_SETTINGS_DEFAULTS.startTimeoutSec);
    assert.equal(settings.unmuteUrl, VOICE_SETTINGS_DEFAULTS.unmuteUrl);
  } finally {
    await temp.cleanup();
  }
});

test("readVoiceSettings returns defaults when the file is missing", async () => {
  const temp = await createTempDir();
  try {
    assert.deepEqual(await readVoiceSettings(temp.path), VOICE_SETTINGS_DEFAULTS);
  } finally {
    await temp.cleanup();
  }
});
