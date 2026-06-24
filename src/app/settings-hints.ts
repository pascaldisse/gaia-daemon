import { AuthStorage, ModelRegistry, createCodingTools, type ToolsOptions } from "@mariozechner/pi-coding-agent";
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import { CLAUDE_PERMISSION_MODES } from "../agents/types.js";
import { capabilitiesFor, findHarness, harnessSpecs } from "../runtime/index.js";

// The SDK's ToolName union is not re-exported from the package root, but
// ToolsOptions is keyed by exactly the same names.
type ToolName = keyof ToolsOptions;

/**
 * Field hints make the formatted settings view smart without changing the
 * settings files themselves. The server derives hints from live sources
 * (workspace agents, rooms, Pi model registry, SDK tool names) and ships them
 * alongside file content. The frontend renders hints generically: it has no
 * per-field knowledge.
 *
 * Hints are keyed by normalized JSON path: array indices collapse to "[]"
 * (e.g. "tools" for the array itself, "model.provider" for a nested leaf).
 */

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
// harness (Codex) ignores the granular `tools` array; permissionMode is a
// Claude-only posture knob.
function hiddenFieldsFor(harnessId: string): string[] {
  const hidden: string[] = [];
  if (!capabilitiesFor(harnessId).granularTools) hidden.push("tools");
  if (harnessId !== "claude") hidden.push("permissionMode");
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

// ThinkingLevel is a type-only export; this list is validated against the SDK
// union so a compiler error flags any drift.
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] satisfies ThinkingLevel[];

// grep/find/ls are valid session tools but not part of createCodingTools();
// the ToolName annotation keeps this list checked against the SDK union.
const EXTRA_TOOL_NAMES: ToolName[] = ["grep", "find", "ls"];

// GAIA-provided custom tools (see runtime/pi-runtime.ts customTools).
const GAIA_TOOL_NAMES = ["memory", "recall"];

export function sdkToolNames(cwd: string): string[] {
  const coding = createCodingTools(cwd).map((tool) => tool.name);
  return [...new Set([...coding, ...EXTRA_TOOL_NAMES, ...GAIA_TOOL_NAMES])];
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

function configJsonHints(sources: HintSources, parsed?: Record<string, unknown>): FileHints {
  return {
    defaultAgent: select(values(sources.agentIds)),
    room: select(values(sources.roomIds)),
    transcriptWindow: { input: "number" },
    harness: select(harnessSelectOptions(), { optional: true }),
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
    ...fileHarnessMeta(),
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
  if (basename === "config.json") return configJsonHints(sources, parsed);
  if (basename === "agent.json") return agentJsonHints(sources, parsed);
  if (basename === "voice.json") return voiceJsonHints();
  return undefined;
}
