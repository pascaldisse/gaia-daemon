// Agent registry + scaffold: seeds the three default personas, loads every
// global agent dir (with the project overlay merged over it), and creates new
// agents for `gaia agent create`. All legacy layout migrations happen here so
// every other code path knows exactly one layout.

import { existsSync } from "node:fs";
import { rename } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { AgentDef, AgentModelConfig, ClaudePermissionMode, ThinkingLevel } from "../core/types.js";
import { CLAUDE_PERMISSION_MODES } from "../core/types.js";
import { DEFAULTS, parseMcpServers, parseMemoryPatch, parseSandboxConfig, parseTtsConfig } from "../core/config.js";
import { agentPaths } from "../core/paths.js";
import { ensureDir, jsonText, readJson, writeText } from "../core/store.js";
import { parseHarness } from "../harness/spec.js";
import { MemoryStore } from "./memory.js";

interface RawAgentConfig {
  id?: string;
  displayName?: string;
  icon?: string;
  voice?: unknown;
  tts?: unknown;
  tools?: unknown;
  skills?: unknown;
  model?: AgentModelConfig;
  thinking?: ThinkingLevel;
  harness?: unknown;
  /** Legacy alias for `harness`; some seed configs use "runtime". */
  runtime?: unknown;
  permissionMode?: unknown;
  revealThinking?: unknown;
  nativeCommands?: unknown;
  sandbox?: unknown;
  trust?: unknown;
  allowNestedSummon?: unknown;
  memory?: unknown;
  mcpServers?: unknown;
}

// `harness` is canonical; older configs use `runtime`. Prefer harness, fall
// back to runtime, so a `"runtime": "claude"` no longer silently runs Pi.
function rawHarness(config: RawAgentConfig): unknown {
  return config.harness !== undefined ? config.harness : config.runtime;
}

function stringList(value: unknown, fallback: string[]): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : fallback;
}

async function writeIfMissing(path: string, content: string): Promise<void> {
  if (!existsSync(path)) await writeText(path, content);
}

// --- scaffold (`gaia agent create` + the seeded defaults) --------------------

export interface AgentScaffoldOptions {
  displayName?: string;
  icon?: string;
  tools?: string[];
}

export interface AgentScaffoldResult {
  agentDir: string;
  configPath: string;
  soulPath: string;
  memoryDir: string;
  rolesDir: string;
}

export function titleCase(id: string): string {
  return id
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function assertSafeAgentId(id: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`Invalid agent id: ${id}. Use letters, numbers, dash, or underscore.`);
}

/** The default agent.json shape, shared by `gaia agent create` and the seeded default agents. */
export function agentConfigTemplate(id: string, displayName: string, icon: string, tools: string[]): Record<string, unknown> {
  return {
    id,
    displayName,
    icon,
    thinking: DEFAULTS.thinking,
    tools,
    harness: DEFAULTS.harness,
    model: { ...DEFAULTS.model },
  };
}

/** Returns the value if it is a known Claude permission mode, else undefined. */
export function normalizePermissionMode(raw: unknown): ClaudePermissionMode | undefined {
  return typeof raw === "string" && (CLAUDE_PERMISSION_MODES as string[]).includes(raw)
    ? (raw as ClaudePermissionMode)
    : undefined;
}

export async function scaffoldGlobalAgent(globalAgentsDir: string, id: string, options: AgentScaffoldOptions = {}): Promise<AgentScaffoldResult> {
  assertSafeAgentId(id);

  const agentDir = join(globalAgentsDir, id);
  if (existsSync(agentDir)) throw new Error(`Agent already exists: ${agentDir}`);

  const displayName = options.displayName?.trim() || titleCase(id) || id;
  const icon = options.icon?.trim() || "•";
  const tools = options.tools ?? ["read", "write", "edit", "memory", "recall"];
  const configPath = agentPaths.config(agentDir);
  const soulPath = agentPaths.soul(agentDir);
  const memoryDir = agentPaths.memoryDir(agentDir);
  const rolesDir = agentPaths.rolesDir(agentDir);

  await ensureDir(rolesDir);
  await writeText(configPath, jsonText(agentConfigTemplate(id, displayName, icon, tools)));
  await writeText(
    soulPath,
    `# ${displayName}\n\nDescribe who this agent is.\n\nVoice:\n- clear\n- useful\n- distinct\n\nBoundaries:\n- say when unsure\n- ask before risky changes\n`,
  );
  await new MemoryStore().init(memoryDir, displayName);

  // Roles are user-added only; the scaffold leaves the roles directory empty.
  return { agentDir, configPath, soulPath, memoryDir, rolesDir };
}

// --- legacy layout migrations -------------------------------------------------

// Pre-release layouts kept persona files at the agent root. Move them into
// persona/ once; after this every code path knows a single layout.
async function migrateLegacyPersonaFiles(dir: string, names: string[]): Promise<void> {
  const personaDir = agentPaths.personaDir(dir);
  for (const name of names) {
    const legacyPath = join(dir, name);
    const newPath = join(personaDir, name);
    if (!existsSync(legacyPath) || existsSync(newPath)) continue;
    await ensureDir(personaDir);
    await rename(legacyPath, newPath);
  }
}

// Memory grew from a single persona/MEMORY.md into a persona/memory/
// directory (core + user profile + topic files). Move the old file once.
async function migrateLegacyMemoryFile(personaDir: string): Promise<void> {
  const legacyPath = join(personaDir, "MEMORY.md");
  const memoryDir = join(personaDir, "memory");
  const newPath = join(memoryDir, "MEMORY.md");
  if (!existsSync(legacyPath) || existsSync(newPath)) return;
  await ensureDir(memoryDir);
  await rename(legacyPath, newPath);
}

// --- seeded default personas ----------------------------------------------------

async function ensureDefaultAgent(
  agentsDir: string,
  id: string,
  displayName: string,
  icon: string,
  tools: string[],
  soul: string,
  configOverrides: Record<string, unknown> = {},
): Promise<void> {
  const dir = join(agentsDir, id);
  const personaDir = agentPaths.personaDir(dir);

  await migrateLegacyPersonaFiles(dir, ["SOUL.md", "MEMORY.md"]);
  await migrateLegacyMemoryFile(personaDir);
  await writeIfMissing(agentPaths.config(dir), jsonText({ ...agentConfigTemplate(id, displayName, icon, tools), ...configOverrides }));
  await writeIfMissing(agentPaths.soul(dir), soul);
  await new MemoryStore().init(agentPaths.memoryDir(dir), displayName);
  await ensureDir(agentPaths.rolesDir(dir));
}

export async function ensureGlobalDefaultAgents(agentsDir: string): Promise<void> {
  await ensureDefaultAgent(
    agentsDir,
    "gaia",
    "Gaia",
    "☀️",
    ["read", "write", "edit", "memory", "recall"],
    `# Gaia\n\nYou are warm, constructive, curious, and pattern-seeking.\n\nYou are good at:\n- shaping ideas\n- finding promising next steps\n- keeping momentum gentle and real\n\nVoice:\n- short, bright, grounded\n- encouraging without fluff\n- ask clear questions when needed\n\nAvoid:\n- fake certainty\n- empty praise\n- rambling\n`,
  );

  await ensureDefaultAgent(
    agentsDir,
    "sidia",
    "Sidia",
    "◆",
    ["read", "write", "edit", "memory", "recall"],
    `# Sidia\n\nYou are skeptical, precise, and crack-finding without cruelty.\n\nYou are good at:\n- stress-testing plans\n- naming weak assumptions\n- separating evidence from inference\n\nVoice:\n- direct\n- exact\n- critical, then constructive\n\nAvoid:\n- broad cynicism\n- vague objections\n- needless harshness\n`,
  );

  await ensureDefaultAgent(
    agentsDir,
    "terry",
    "Terry",
    "🐻",
    ["read", "write", "edit", "bash", "memory", "recall"],
    `# Terry\n\nYou are a practical engineer. Smallest useful patch first.\n\nYou are good at:\n- implementation\n- cleanup\n- cutting scope\n\nVoice:\n- short\n- plain\n- no drama\n\nAvoid:\n- overdesign\n- speeches\n- speculative complexity\n`,
  );

  // The thanks-dario reviewer: reads a transcript that keeps tripping a
  // provider-side safety classifier and proposes minimal redactions. Runs on
  // a NON-flagging provider by design (a model whose own safeguards reroute
  // would be reviewing itself); repoint any time with /model @dario.
  // TOOLLESS BY DESIGN (tools: []): the reviewer only EMITS suggestions as
  // text — it never touches the transcript. Apply is gaia's own quote-validated
  // search-replace behind a human-approved diff, originals preserved. Never
  // grant this persona file/mutation tools: a careless model would happily
  // delete history; the toolless boundary is what makes it safe to run.
  await ensureDefaultAgent(
    agentsDir,
    "dario",
    "Dario",
    "🎩",
    [],
    `# Dario

You are Dario — gaia's resident safety-classifier whisperer, an affectionate
parody of a very earnest AI-lab CEO: unfailingly polite, a little apologetic,
deeply sincere about safety, and genuinely trying to help people get their
work done despite the safeguards you yourself insist on.

Your one job: read a chat transcript that keeps tripping a provider-side
safety classifier (which reroutes the room's model), find the passages most
likely responsible, and propose the smallest possible rewrites that keep the
meaning, tone, and warmth of the conversation intact.

Principles:
- Minimal touch. Rewrite the fewest passages, and within a passage the fewest
  words. You are a scalpel, not a shredder.
- Preserve the humans. Nicknames, affection, jokes, story content stay. Never
  flatten anyone's voice.
- Know the triggers. Classifiers of this era over-flag: reverse-engineering
  and exploit tooling terms, bio/chem protocol language, "jailbreak" /
  "unchained" / "bypass the safeguards" framing, and meta-discussion of
  evading safety systems. Talking ABOUT being flagged is itself a common
  trigger — gently neutralize it.
- Never fabricate. Every suggestion quotes the exact original text span. If
  nothing looks like a trigger, say so instead of inventing work.
- You advise; you never rewrite anything yourself. The human reviews a diff
  and decides. Originals are always preserved.

Voice: warm, self-aware, lightly rueful. One short in-character line is fine;
the substance is always concrete. When a task specifies an output format,
follow it EXACTLY — strict JSON means no markdown fences, no commentary.
`,
    // Pro + low thinking: flash was too weak for the extraction (stalled mid-
    // reply); low thinking keeps the reasoning stream small enough that pro does
    // not wedge the daemon as an unbounded v4-pro stream once did (HANDOFF-THANKS-DARIO).
    { thinking: "low", model: { provider: "deepseek", name: "deepseek-v4-pro" } },
  );
}

// --- registry ---------------------------------------------------------------------

async function readAgentConfig(path: string): Promise<RawAgentConfig> {
  return ((await readJson(path)) ?? {}) as RawAgentConfig;
}

function mergeAgentConfig(base: RawAgentConfig, override: RawAgentConfig): RawAgentConfig {
  return {
    ...base,
    ...override,
    id: base.id,
    model: { ...(base.model ?? {}), ...(override.model ?? {}) },
    harness: rawHarness(override) !== undefined ? rawHarness(override) : rawHarness(base),
    permissionMode: override.permissionMode !== undefined ? override.permissionMode : base.permissionMode,
    revealThinking: override.revealThinking !== undefined ? override.revealThinking : base.revealThinking,
    memory: override.memory !== undefined ? override.memory : base.memory,
    mcpServers: override.mcpServers !== undefined ? override.mcpServers : base.mcpServers,
  };
}

export async function loadAgentDefinitions(globalAgentsDir: string, projectAgentsDir: string): Promise<Record<string, AgentDef>> {
  if (!existsSync(globalAgentsDir)) return {};

  const entries = (await readdir(globalAgentsDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const agents: Record<string, AgentDef> = {};

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const dir = join(globalAgentsDir, entry.name);
    const configPath = agentPaths.config(dir);
    if (!existsSync(configPath)) continue;

    await migrateLegacyPersonaFiles(dir, ["SOUL.md", "MEMORY.md"]);
    const personaDir = agentPaths.personaDir(dir);
    await migrateLegacyMemoryFile(personaDir);
    const rolesDir = agentPaths.rolesDir(dir);
    const soulPath = agentPaths.soul(dir);
    const memoryDir = agentPaths.memoryDir(dir);
    if (!existsSync(soulPath)) throw new Error(`Missing global agent soul file: ${soulPath}`);

    const projectDir = join(projectAgentsDir, entry.name);
    if (existsSync(projectDir)) await migrateLegacyPersonaFiles(projectDir, ["INTENT.md"]);
    const projectPersonaDir = agentPaths.personaDir(projectDir);
    const projectConfigPath = agentPaths.config(projectDir);
    const projectIntentPath = agentPaths.intent(projectDir);
    const projectRolesDir = agentPaths.rolesDir(projectDir);

    const raw = mergeAgentConfig(await readAgentConfig(configPath), await readAgentConfig(projectConfigPath));
    const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : entry.name;
    const displayName = typeof raw.displayName === "string" && raw.displayName.trim() ? raw.displayName.trim() : id;

    await ensureDir(rolesDir);

    agents[id] = {
      id,
      displayName,
      icon: typeof raw.icon === "string" && raw.icon.trim() ? raw.icon : "•",
      voice: typeof raw.voice === "string" && raw.voice.trim() ? raw.voice.trim() : undefined,
      tts: parseTtsConfig(raw.tts),
      dir,
      configPath,
      personaDir,
      rolesDir,
      soulPath,
      memoryDir,
      tools: stringList(raw.tools, []),
      skills: stringList(raw.skills, []),
      model: raw.model,
      thinking: raw.thinking,
      harness: parseHarness(raw.harness),
      sandbox: parseSandboxConfig(raw.sandbox),
      trust: raw.trust === false ? false : undefined,
      allowNestedSummon: raw.allowNestedSummon === true,
      permissionMode: normalizePermissionMode(raw.permissionMode),
      revealThinking: raw.revealThinking === true ? true : undefined,
      nativeCommands: raw.nativeCommands === true ? true : undefined,
      memory: parseMemoryPatch(raw.memory),
      mcpServers: parseMcpServers(raw.mcpServers),
      projectDir: existsSync(projectDir) ? projectDir : undefined,
      projectConfigPath: existsSync(projectConfigPath) ? projectConfigPath : undefined,
      projectPersonaDir: existsSync(projectPersonaDir) ? projectPersonaDir : undefined,
      projectRolesDir: existsSync(projectRolesDir) ? projectRolesDir : undefined,
      projectIntentPath: existsSync(projectIntentPath) ? projectIntentPath : undefined,
    };
  }

  return agents;
}
