import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import YAML from "yaml";
import type { GaiaConfig } from "./types.js";

export const GAIA_DIR = join(homedir(), ".gaia");
export const DEFAULT_CONFIG_PATH = join(GAIA_DIR, "config.yaml");

const expandHome = (value: string): string =>
  value === "~" ? homedir() : value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;

export function defaultConfig(): GaiaConfig {
  return {
    personas: {
      gaia: { thinking: "medium" },
      sidia: { thinking: "medium" },
      monad: { thinking: "medium" },
    },
    memory: {
      dir: "~/.gaia/memories",
      userLimit: 12_000,
      personaLimit: 12_000,
    },
    safety: {
      confirmRiskyTools: true,
      blockOnNoTty: true,
    },
    ui: {
      showToolEvents: true,
    },
    monad: {
      order: ["gaia", "sidia"],
    },
  };
}

function mergeConfig(raw: unknown): GaiaConfig {
  const base = defaultConfig();
  const input = (raw && typeof raw === "object" ? raw : {}) as Partial<GaiaConfig>;
  return {
    personas: {
      gaia: { ...base.personas.gaia, ...(input.personas?.gaia ?? {}) },
      sidia: { ...base.personas.sidia, ...(input.personas?.sidia ?? {}) },
      monad: { ...base.personas.monad, ...(input.personas?.monad ?? {}) },
    },
    memory: { ...base.memory, ...(input.memory ?? {}) },
    safety: { ...base.safety, ...(input.safety ?? {}) },
    ui: { ...base.ui, ...(input.ui ?? {}) },
    monad: { ...base.monad, ...(input.monad ?? {}) },
  };
}

export async function ensureDefaultConfig(configPath = DEFAULT_CONFIG_PATH): Promise<void> {
  if (existsSync(configPath)) return;
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(defaultConfig()), "utf8");
}

export async function loadConfig(configPath = DEFAULT_CONFIG_PATH): Promise<GaiaConfig> {
  await ensureDefaultConfig(configPath);
  const text = await readFile(configPath, "utf8");
  const parsed = YAML.parse(text) as unknown;
  const merged = mergeConfig(parsed);
  merged.memory.dir = resolve(expandHome(merged.memory.dir));
  await mkdir(merged.memory.dir, { recursive: true });
  return merged;
}

export async function writeDefaultConfig(configPath = DEFAULT_CONFIG_PATH): Promise<void> {
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, YAML.stringify(defaultConfig()), "utf8");
}
