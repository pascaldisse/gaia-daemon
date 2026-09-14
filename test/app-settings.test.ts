import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeAppSettings, readAppSettings, writeAutoTtsSetting } from "../src/services/app-settings.js";

test("autoTts schema defaults false for missing, legacy, and invalid settings", () => {
  for (const value of [undefined, null, [], {}, { keepAwake: true }, { general: null }, { general: { autoTts: "true" } }]) {
    expect(normalizeAppSettings(value).general.autoTts).toBe(false);
  }
  expect(normalizeAppSettings({ general: { autoTts: true } }).general.autoTts).toBe(true);
});

test("autoTts migration and true/false roundtrip preserve existing settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gaia-auto-tts-settings-"));
  const path = join(dir, "app.json");
  try {
    expect((await readAppSettings(path)).general.autoTts).toBe(false);
    const legacy = { keepAwake: true, theme: "dracula", general: { aliases: ["x"], readBeforeWrite: true } };
    await writeFile(path, JSON.stringify(legacy));
    for (const enabled of [true, false]) {
      await writeAutoTtsSetting(enabled, path);
      expect((await readAppSettings(path)).general.autoTts).toBe(enabled);
      expect(JSON.parse(await readFile(path, "utf8"))).toEqual({ ...legacy, general: { ...legacy.general, autoTts: enabled } });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
