import { globalPaths } from "../core/paths.js";
import { readJson, writeJsonAtomic } from "../core/store.js";

export interface AppSettings extends Record<string, unknown> {
  general: Record<string, unknown> & { autoTts: boolean };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// Legacy flat app.json → additive general defaults; unrelated keys untouched.
export function normalizeAppSettings(value: unknown): AppSettings {
  const app = record(value);
  const general = record(app.general);
  return { ...app, general: { ...general, autoTts: general.autoTts === true } };
}

export async function readAppSettings(path = globalPaths.appSettings()): Promise<AppSettings> {
  return normalizeAppSettings(await readJson(path));
}

export async function writeAutoTtsSetting(enabled: boolean, path = globalPaths.appSettings()): Promise<void> {
  const settings = await readAppSettings(path);
  settings.general.autoTts = enabled;
  await writeJsonAtomic(path, settings);
}
