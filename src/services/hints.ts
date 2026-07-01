// Settings hints + the editable-file catalog (v1's settings-hints.ts and
// editable-files.ts, one module — both exist only to make the settings UI
// smart without changing the settings files themselves).
//
// Field hints are derived from live sources (workspace agents, rooms, the Pi
// model registry, SDK tool names, the harness registry) and shipped alongside
// file content. The frontend renders hints generically: it has no per-field
// knowledge. Hints are keyed by normalized JSON path: array indices collapse
// to "[]" (e.g. "tools" for the array itself, "model.provider" for a nested
// leaf). The JSON shape is the v1 wire shape exactly — the web client
// consumes it unchanged.

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AuthStorage, ModelRegistry, createCodingTools, type ToolsOptions } from "@mariozechner/pi-coding-agent";
import { CLAUDE_PERMISSION_MODES, type ThinkingLevel, type Workspace } from "../core/types.js";
import { gaiaHome, workspacePaths } from "../core/paths.js";
import { ensureDir } from "../core/store.js";
import { capabilitiesFor, findHarness, harnessSpecs } from "../harness/spec.js";
import { gaiaToolIds } from "../harness/tools.js";

// The SDK's ToolName union is not re-exported from the package root, but
// ToolsOptions is keyed by exactly the same names.
type ToolName = keyof ToolsOptions;

// ---------------------------------------------------------------------------
// Field hints

export type FieldInput = "select" | "multiselect" | "number" | "boolean" | "text";

export interface FieldHintOption {
  value: string;
  label?: string;
  description?: string;
  /** Group key used by dependent selects (see FieldHint.groupBy). */
  group?: string;
}

export interface FieldHint {
  input: FieldInput;
  /** Optional fields render an explicit "(not set)" choice; empty omits the key on save. */
  optional?: boolean;
  options?: FieldHintOption[];
  /** JSON path of another field whose current value filters options by their `group`. */
  groupBy?: string;
  /** Hint is applicable but currently hidden by another field's value (e.g. tools hidden for codex harness). */
  hidden?: boolean;
}

// Which agent.json fields the settings UI hides for a harness — derived from the
// declared runtime capabilities, never hardcoded per harness. A coarse-sandbox
// harness ignores the granular `tools` array; permissionMode is a posture knob
// only some harnesses honor.
function hiddenFieldsFor(harnessId: string): string[] {
  const hidden: string[] = [];
  const caps = capabilitiesFor(harnessId);
  if (!caps.granularTools) hidden.push("tools");
  if (!caps.supportsPermissionMode) hidden.push("permissionMode");
  return hidden;
}

/** Metadata the server attaches to hints so the frontend can react to harness changes without reloading. */
export interface HarnessHintsMeta {
  configs: Record<string, { lockedProvider?: string; modelProviderIds?: string[]; modelNameOptions?: string[]; hiddenFields: string[] }>;
}

export interface FileHints {
  [key: string]: FieldHint | HarnessHintsMeta | undefined;
  _harness?: HarnessHintsMeta;
}

export interface ModelChoice {
  provider: string;
  providerLabel: string;
  id: string;
  label: string;
  configured: boolean;
  subscription: boolean;
}

export interface HintSources {
  agentIds: string[];
  roomIds: string[];
  toolNames: string[];
  thinkingLevels: string[];
  models: ModelChoice[];
}

// The list is validated against the core ThinkingLevel union so a compiler
// error flags any drift.
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] satisfies ThinkingLevel[];

// grep/find/ls are valid session tools but not part of createCodingTools();
// the ToolName annotation keeps this list checked against the SDK union.
const EXTRA_TOOL_NAMES: ToolName[] = ["grep", "find", "ls"];

export function sdkToolNames(cwd: string): string[] {
  const coding = createCodingTools(cwd).map((tool) => tool.name);
  // GAIA-provided custom tools come from the single tool registry (so this list
  // can never drift from what the harnesses actually wire).
  return [...new Set([...coding, ...EXTRA_TOOL_NAMES, ...gaiaToolIds()])];
}

export function sdkThinkingLevels(): string[] {
  return [...THINKING_LEVELS];
}

export interface ModelCatalog {
  models: ModelChoice[];
}

/**
 * Read the model catalog from the Pi SDK. Includes API-key, subscription
 * (OAuth), and local/custom models (~/.pi/agent/models.json providers).
 */
export function readModelCatalog(): ModelCatalog {
  const authStorage = AuthStorage.create();
  const registry = ModelRegistry.create(authStorage);
  const models = registry.getAll().map((model) => ({
    provider: model.provider,
    providerLabel: registry.getProviderDisplayName(model.provider),
    id: model.id,
    label: model.name ?? model.id,
    configured: registry.hasConfiguredAuth(model),
    subscription: registry.isUsingOAuth(model),
  }));
  return { models };
}

function select(options: FieldHintOption[], extra: Partial<FieldHint> = {}): FieldHint {
  return { input: "select", options, ...extra };
}

function authNote(choice: Pick<ModelChoice, "configured" | "subscription">): string {
  if (!choice.configured) return "no auth configured";
  return choice.subscription ? "subscription (oauth)" : "api key";
}

function providerOptions(models: ModelChoice[]): FieldHintOption[] {
  const byProvider = new Map<string, ModelChoice[]>();
  for (const model of models) {
    byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model]);
  }
  return [...byProvider.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([provider, providerModels]) => {
      const configured = providerModels.some((model) => model.configured);
      const subscription = providerModels.some((model) => model.subscription);
      return {
        value: provider,
        label: providerModels[0]?.providerLabel ?? provider,
        description: `${providerModels.length} models · ${authNote({ configured, subscription })}`,
      };
    });
}

function modelOptions(models: ModelChoice[]): FieldHintOption[] {
  return models.map((model) => ({
    value: model.id,
    label: model.id,
    description: `${model.providerLabel} · ${model.label} · ${authNote(model)}`,
    group: model.provider,
  }));
}

function values(items: string[]): FieldHintOption[] {
  return items.map((value) => ({ value }));
}

function harnessSelectOptions(): FieldHintOption[] {
  return harnessSpecs().map((spec) => ({
    value: spec.id,
    label: spec.ui.label,
    description: spec.ui.description,
  }));
}

function harnessHintsMeta(): HarnessHintsMeta {
  const configs: HarnessHintsMeta["configs"] = {};
  for (const spec of harnessSpecs()) {
    configs[spec.id] = {
      lockedProvider: spec.ui.lockedProvider,
      modelProviderIds: spec.ui.modelProviderIds,
      modelNameOptions: spec.ui.modelNameOptions,
      hiddenFields: hiddenFieldsFor(spec.id),
    };
  }
  return { configs };
}

function fileHarnessMeta(): FileHints {
  return { _harness: harnessHintsMeta() };
}

// Memory v3 knobs (MEMORY-DESIGN.md). Shared verbatim between config.json
// (workspace defaults) and agent.json (per-agent overrides — all optional).
function memoryHints(optional: boolean): FileHints {
  return {
    "memory.autoRecall": { input: "boolean", optional },
    "memory.autoRecallBudget": { input: "number", optional },
    "memory.embeddings": select(
      [
        { value: "auto", description: "first provider with a usable key (openai, gemini); lexical-only when none" },
        { value: "off", description: "lexical search only" },
      ],
      { optional },
    ),
    "memory.consolidate.enabled": { input: "boolean", optional },
    "memory.consolidate.idleMinutes": { input: "number", optional },
    "memory.consolidate.maxPerDay": { input: "number", optional },
    "memory.decayHalfLifeDays": { input: "number", optional },
  };
}

function configJsonHints(sources: HintSources): FileHints {
  return {
    defaultAgent: select(values(sources.agentIds)),
    room: select(values(sources.roomIds)),
    transcriptWindow: { input: "number" },
    harness: select(harnessSelectOptions(), { optional: true }),
    ...memoryHints(false),
    ...fileHarnessMeta(),
  };
}

function agentJsonHints(sources: HintSources, parsed?: Record<string, unknown>): FileHints {
  const rawHarness = typeof parsed?.harness === "string" ? parsed.harness : undefined;
  const currentHarnessUi = rawHarness ? findHarness(rawHarness)?.ui : undefined;

  // Fields hidden for the current harness, derived from its capabilities. The
  // `hidden` flag carries the saved state; the frontend reads _harness meta to
  // toggle when harness changes.
  const hiddenByHarness = new Set(rawHarness ? hiddenFieldsFor(rawHarness) : []);

  // Locked provider: if the harness locks a provider, hide model.provider
  // and filter model names to only that provider's models.
  const providerLocked = Boolean(currentHarnessUi?.lockedProvider);
  const modelFilterProviders = currentHarnessUi?.modelProviderIds;

  const allModels = sources.models;
  const modelNameOptions = modelFilterProviders
    ? modelOptions(allModels).filter((opt) => modelFilterProviders.includes(opt.group ?? ""))
    : modelOptions(allModels);
  const providerOptionList = providerOptions(allModels);

  return {
    thinking: select(values(sources.thinkingLevels), { optional: true }),
    tools: { input: "multiselect", options: values(sources.toolNames), hidden: hiddenByHarness.has("tools") },
    permissionMode: select(values([...CLAUDE_PERMISSION_MODES]), { optional: true, hidden: hiddenByHarness.has("permissionMode") }),
    harness: select(harnessSelectOptions(), { optional: true }),
    "model.provider": select(providerOptionList, { optional: true, hidden: providerLocked }),
    "model.name": select(modelNameOptions, { optional: true, groupBy: providerLocked ? undefined : "model.provider" }),
    ...memoryHints(true),
    ...fileHarnessMeta(),
  };
}

function schedulesJsonHints(sources: HintSources): FileHints {
  return {
    enabled: { input: "boolean" },
    "jobs.[].agent": select(values(sources.agentIds), { optional: true }),
    "jobs.[].room": select(values(sources.roomIds), { optional: true }),
    "jobs.[].enabled": { input: "boolean", optional: true },
    "jobs.[].isolated": { input: "boolean", optional: true },
    "jobs.[].chainOutput": { input: "boolean", optional: true },
  };
}

function voiceJsonHints(): FileHints {
  return {
    autoStart: { input: "boolean" },
    speakOnSilence: { input: "boolean" },
    disableThinking: { input: "boolean" },
    startTimeoutSec: { input: "number" },
    silenceDelaySec: { input: "number" },
  };
}

export function buildFileHints(file: { label: string; kind: string; content?: string }, sources: HintSources): FileHints | undefined {
  if (file.kind !== "json") return undefined;
  const basename = file.label.split("/").pop() ?? file.label;
  let parsed: Record<string, unknown> | undefined;
  if (file.content) {
    try {
      parsed = JSON.parse(file.content);
    } catch {
      // Hints degrade gracefully on parse failure.
    }
  }
  if (basename === "config.json") return configJsonHints(sources);
  if (basename === "agent.json") return agentJsonHints(sources, parsed);
  if (basename === "voice.json") return voiceJsonHints();
  if (basename === "schedules.json") return schedulesJsonHints(sources);
  return undefined;
}

// ---------------------------------------------------------------------------
// Editable-file catalog. Scopes/ids exactly as v1: id = `${scope}_${sha256 of
// the resolved path, 18 hex chars}` so saved links stay stable across
// versions.

export type EditableScope = "global" | "workspace";

// What a file *is*, computed where the directory layout is known (here), so
// the frontend can group files without parsing label paths.
export type EditableCategory = "general" | "voice" | "config" | "persona" | "memory";

export interface EditableFileDescriptor {
  id: string;
  scope: EditableScope;
  label: string;
  path: string;
  kind: "markdown" | "json" | "text";
  /** Owning agent for files under the global agents directory. */
  agentId?: string;
  category?: EditableCategory;
}

export interface EditableFileContent extends EditableFileDescriptor {
  content: string;
}

/** True when `path` is `root` or contained inside it. */
function pathInside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Stable id derived from a resolved path (v1's pathId). */
function pathId(path: string, length: number): string {
  return createHash("sha256").update(resolve(path)).digest("hex").slice(0, length);
}

// Settings saves are atomic like everything else; core/store only speaks
// atomic JSON, so the raw-text variant lives here.
async function writeTextAtomic(path: string, content: string): Promise<void> {
  await ensureDir(dirname(path));
  const tmp = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
  await writeFile(tmp, content, "utf8");
  await rename(tmp, path);
}

function fileId(scope: EditableScope, path: string): string {
  return `${scope}_${pathId(path, 18)}`;
}

function kindFor(path: string): EditableFileDescriptor["kind"] {
  if (path.endsWith(".md")) return "markdown";
  if (path.endsWith(".json")) return "json";
  return "text";
}

function labelFor(path: string, root: string): string {
  const rel = relative(root, path);
  return rel || path;
}

async function walkEditable(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && (entry.name.endsWith(".md") || entry.name.endsWith(".json")))
    .map((entry) => join(entry.parentPath, entry.name));
}

function globalCategory(path: string, home: string): Pick<EditableFileDescriptor, "agentId" | "category"> {
  const rel = relative(home, path);
  const parts = rel.split(sep);
  if (parts[0] === "agents" && parts.length > 2) {
    const file = parts[parts.length - 1];
    const category = file === "agent.json" ? "config" : parts.includes("memory") ? "memory" : "persona";
    return { agentId: parts[1], category };
  }
  return { category: rel === "voice.json" ? "voice" : "general" };
}

async function descriptor(scope: EditableScope, path: string, labelRoot: string): Promise<EditableFileDescriptor | undefined> {
  if (!existsSync(path)) return undefined;
  const info = await stat(path);
  if (!info.isFile()) return undefined;
  return {
    id: fileId(scope, path),
    scope,
    label: labelFor(path, labelRoot),
    path,
    kind: kindFor(path),
    ...(scope === "global" ? globalCategory(path, labelRoot) : {}),
  };
}

export class EditableFileRegistry {
  constructor(private readonly workspaceById: (id: string) => Promise<Workspace | undefined>) {}

  async listGlobal(): Promise<EditableFileDescriptor[]> {
    const home = gaiaHome();
    const files = [join(home, "app.json"), join(home, "voice.json"), ...(await walkEditable(join(home, "agents")))];
    const descriptors = await Promise.all(files.map((path) => descriptor("global", path, home)));
    return descriptors.filter((item): item is EditableFileDescriptor => Boolean(item)).sort((a, b) => a.label.localeCompare(b.label));
  }

  async listWorkspace(workspaceId: string): Promise<EditableFileDescriptor[]> {
    const workspace = await this.workspaceById(workspaceId);
    if (!workspace) return [];

    const files = [join(workspace.rootDir, "AGENTS.md"), workspace.configPath, workspacePaths.schedules(workspace.rootDir)];
    files.push(...(await walkEditable(workspace.agentsOverrideDir)));
    files.push(...(await walkEditable(join(workspace.dir, "skills"))));

    const descriptors = await Promise.all(files.map((path) => descriptor("workspace", path, workspace.rootDir)));
    return descriptors.filter((item): item is EditableFileDescriptor => Boolean(item)).sort((a, b) => a.label.localeCompare(b.label));
  }

  async read(fileId: string, workspaceId?: string): Promise<EditableFileContent> {
    const found = await this.find(fileId, workspaceId);
    if (!found) throw new Error("Editable file not found");
    return { ...found, content: await readFile(found.path, "utf8") };
  }

  async write(fileId: string, content: string, workspaceId?: string): Promise<EditableFileContent> {
    const found = await this.find(fileId, workspaceId);
    if (!found) throw new Error("Editable file not found");
    await writeTextAtomic(found.path, content);
    return { ...found, content };
  }

  private async find(fileId: string, workspaceId?: string): Promise<EditableFileDescriptor | undefined> {
    const globalFiles = await this.listGlobal();
    const globalMatch = globalFiles.find((file) => file.id === fileId);
    if (globalMatch) {
      if (!pathInside(globalMatch.path, gaiaHome())) throw new Error("Editable file escaped GAIA home");
      return globalMatch;
    }

    if (!workspaceId) return undefined;
    const workspaceFiles = await this.listWorkspace(workspaceId);
    const workspaceMatch = workspaceFiles.find((file) => file.id === fileId);
    if (!workspaceMatch) return undefined;
    const workspace = await this.workspaceById(workspaceId);
    if (!workspace || !pathInside(workspaceMatch.path, workspace.rootDir)) throw new Error("Editable file escaped workspace");
    return workspaceMatch;
  }
}
