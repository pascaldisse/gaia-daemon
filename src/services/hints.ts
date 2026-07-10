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
import { existsSync, readdirSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { basename as pathBasename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { AuthStorage, ModelRegistry, createCodingTools, type ToolsOptions } from "@earendil-works/pi-coding-agent";
import type { EditableFileContent, EditableFileDescriptor, EditableScope, FieldHint, FieldHintOption, FileHints, HarnessHintsMeta, ThinkingLevel, Workspace } from "../core/types.js";
import { agentPaths, gaiaHome, globalPaths, workspacePaths } from "../core/paths.js";
import { writeTextAtomic } from "../core/store.js";
import { capabilitiesFor, findHarness, harnessSpecs, nativeCommandsFor } from "../harness/spec.js";
import { sandboxBackendIds } from "../harness/sandbox/spec.js";
import { gaiaToolIds } from "../harness/tools.js";
import { discoverSkills } from "../domain/skills.js";
import { listAccounts } from "../domain/accounts.js";
import { findTtsEngine, ttsEngineIds, type TtsEngineSpec } from "./read-aloud.js";
import { sttEngineIds } from "./transcribe.js";

// The settings wire shapes live in src/core/types.ts (the shared-type home,
// comment-imported by the web client); re-exported here for internal callers.
export type { EditableCategory, EditableFileContent, EditableFileDescriptor, EditableScope, FieldHint, FieldHintOption, FieldInput, FileHints, HarnessHintsMeta } from "../core/types.js";

// The SDK's ToolName union is not re-exported from the package root, but
// ToolsOptions is keyed by exactly the same names.
type ToolName = keyof ToolsOptions;

// ---------------------------------------------------------------------------
// Field hints

// Which agent.json fields the settings UI hides for a harness — derived from the
// declared runtime capabilities, never hardcoded per harness. A coarse-sandbox
// harness ignores the granular `tools` array; permissionMode is a posture knob
// only some harnesses honor.
function hiddenFieldsFor(harnessId: string): string[] {
  const hidden: string[] = [];
  const caps = capabilitiesFor(harnessId);
  if (!caps.granularTools) hidden.push("tools");
  if (!caps.supportsPermissionMode) hidden.push("permissionMode");
  if (!caps.supportsMcp) hidden.push("mcpServers");
  if (!findHarness(harnessId)?.accounts) hidden.push("account");
  return hidden;
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
  /** Auto-detected skills across every install location, as picker options. */
  skills: FieldHintOption[];
}

// The list is validated against the core ThinkingLevel union so a compiler
// error flags any drift.
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] satisfies ThinkingLevel[];

// grep/find/ls are valid session tools but not part of createCodingTools();
// the ToolName annotation keeps this list checked against the SDK union.
const EXTRA_TOOL_NAMES: ToolName[] = ["grep", "find", "ls"];

export function sdkToolNames(cwd: string): string[] {
  const coding = createCodingTools(cwd).map((tool) => tool.name);
  // Harness-agnostic native tools (e.g. "web") come from the registered
  // harnesses' declared capabilities — the UI offers a tool iff some harness
  // fulfils it, never a hardcoded string. GAIA custom tools come from the
  // single tool registry, so neither list can drift from what harnesses wire.
  const nativeTools = harnessSpecs().flatMap((spec) => spec.capabilities.nativeTools ?? []);
  return [...new Set([...coding, ...EXTRA_TOOL_NAMES, ...nativeTools, ...gaiaToolIds()])];
}

export function sdkThinkingLevels(): string[] {
  return [...THINKING_LEVELS];
}

/**
 * Every auto-detected skill across all install locations (project, ~/.gaia, and
 * every installed harness ecosystem — pi, Claude, Codex, Hermes) as multiselect
 * options for the agent settings picker. Detection is uniform; the source and
 * SKILL.md description ride along as the option tooltip. Recomputed per request
 * (cheap directory scan) so a freshly installed skill shows up without restart.
 */
/** Ecosystem bucket a skill's source belongs to (the picker groups by this).
 * gaia's own bridges (~/.gaia/skills, source "global") read as "gaia"; every
 * other source is its own ecosystem already (claude/codex/pi/hermes/project). */
function skillGroup(source: string): string {
  return source === "global" ? "gaia" : source;
}

export function skillHintOptions(workspace: Pick<Workspace, "dir">): FieldHintOption[] {
  const options: FieldHintOption[] = discoverSkills(workspace).map((skill) => ({
    value: skill.name,
    label: skill.name,
    group: skillGroup(skill.source),
    description: [skill.source, skill.description].filter(Boolean).join(" · "),
  }));
  // Native (fileless-builtin) commands each harness runs itself — pickable so a
  // command like deep-research is enabled by CHECKING it, no separate toggle.
  // The picker is workspace-global; only the matching harness runs them. Deduped
  // by name against on-disk skills (which inline instead) and across harnesses.
  // They fold into their harness's ecosystem group, tagged `native`.
  const seen = new Set(options.map((option) => option.value.toLowerCase()));
  for (const spec of harnessSpecs()) {
    for (const command of nativeCommandsFor(spec.id)) {
      const key = command.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      options.push({
        value: command.name,
        label: command.name,
        group: spec.id,
        badge: "native",
        description: [spec.id, "native", command.description].filter(Boolean).join(" · "),
      });
    }
  }
  // Contiguous by group; within a group native (badged) first, then alphabetical.
  return options.sort(
    (a, b) =>
      (a.group ?? "").localeCompare(b.group ?? "") ||
      Number(Boolean(b.badge)) - Number(Boolean(a.badge)) ||
      a.value.localeCompare(b.value),
  );
}

/**
 * Order the skill sections for one agent: the agent's own harness ecosystem
 * leads (a claude agent sees `claude` on top), then the rest by descending skill
 * count, then alphabetically. Options arrive already contiguous-by-group from
 * skillHintOptions, so the client just starts a new section on each group change.
 */
function orderSkillSections(options: FieldHintOption[], harnessId: string | undefined): FieldHintOption[] {
  const groups = new Map<string, FieldHintOption[]>();
  for (const option of options ?? []) {
    const key = option.group ?? "";
    const bucket = groups.get(key);
    if (bucket) bucket.push(option);
    else groups.set(key, [option]);
  }
  const order = [...groups.keys()].sort((a, b) => {
    if (a === harnessId) return -1;
    if (b === harnessId) return 1;
    return (groups.get(b)?.length ?? 0) - (groups.get(a)?.length ?? 0) || a.localeCompare(b);
  });
  return order.flatMap((key) => groups.get(key) ?? []);
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
    group: model.providerLabel,
  }));
}

function values(items: string[]): FieldHintOption[] {
  return items.map((value) => ({ value }));
}

function isRoleName(value: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(value);
}

function roleNamesInDir(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => pathBasename(entry.name, ".md"))
    .filter(isRoleName);
}

function roleHintOptions(agentId: string | undefined): FieldHintOption[] {
  if (!agentId) return [];
  const rolesDir = agentPaths.rolesDir(globalPaths.agentDir(agentId));
  return [...new Set(roleNamesInDir(rolesDir))]
    .sort((a, b) => a.localeCompare(b))
    .map((value) => ({ value }));
}

function agentIdFromAgentJsonLabel(label: string): string | undefined {
  const parts = label.split(/[\\/]+/);
  const agentJson = parts[parts.length - 1] === "agent.json";
  if (!agentJson) return undefined;
  const agentsIndex = parts.lastIndexOf("agents");
  const agentId = agentsIndex >= 0 ? parts[agentsIndex + 1] : undefined;
  return agentId && isRoleName(agentId) ? agentId : undefined;
}

function harnessSelectOptions(): FieldHintOption[] {
  return harnessSpecs().map((spec) => ({
    value: spec.id,
    label: spec.ui.label,
    description: spec.ui.description,
  }));
}

/** Select options for a harness's stored accounts (the agent `account` field).
 * Read fresh per request; degrade to [] on a torn store — hints must render
 * even when the spawn path would (correctly) fail loudly. No harness id given
 * = every account, labeled with its owning harness. */
function accountSelectOptions(harnessId?: string): FieldHintOption[] {
  try {
    return listAccounts()
      .filter((account) => !harnessId || account.harness === harnessId)
      .map((account) => ({
        value: account.id,
        label: harnessId ? (account.label ?? account.id) : `${account.label ?? account.id} (${account.harness})`,
      }));
  } catch {
    return [];
  }
}

function harnessHintsMeta(): HarnessHintsMeta {
  const configs: HarnessHintsMeta["configs"] = {};
  for (const spec of harnessSpecs()) {
    configs[spec.id] = {
      lockedProvider: spec.ui.lockedProvider,
      modelProviderIds: spec.ui.modelProviderIds,
      modelNameOptions: spec.ui.modelNameOptions,
      permissionModes: spec.ui.permissionModes,
      hiddenFields: hiddenFieldsFor(spec.id),
      accountsLabel: spec.accounts?.label,
      accountOptions: spec.accounts ? accountSelectOptions(spec.id) : undefined,
    };
  }
  return { configs };
}

// The permission-mode vocabulary is each harness's own, declared as DATA on
// its spec (ui.permissionModes) — never a harness-named constant in shared
// code. The agent's current harness drives the select; with no harness
// declared, the union across registered harnesses stands in (the same law as
// the native-tool vocabulary). The frontend re-reads _harness meta on switch.
function permissionModeOptions(harnessId: string | undefined): string[] {
  const declared = harnessId ? findHarness(harnessId)?.ui.permissionModes : undefined;
  if (declared) return [...declared];
  return [...new Set(harnessSpecs().flatMap((spec) => spec.ui.permissionModes ?? []))];
}

function fileHarnessMeta(): FileHints {
  return { _harness: harnessHintsMeta() };
}

// Memory v4 knobs (MEMORY-DESIGN.md). Shared verbatim between config.json
// (workspace defaults) and agent.json (per-agent overrides — all optional).
function memoryHints(optional: boolean, models: ModelChoice[]): FileHints {
  return {
    "memory.autoRecall": { input: "boolean", optional },
    "memory.autoRecallBudget": { input: "number", optional },
    "memory.embeddings": select(
      [
        { value: "auto", description: "local llama.cpp sidecar (nothing leaves this machine); lexical-only when unavailable — NEVER cloud" },
        { value: "off", description: "lexical search only" },
      ],
      { optional },
    ),
    "memory.reranker": select(
      [
        { value: "auto", description: "local reranker sharpens deep recall (gaia recall, /recall); fusion order when unavailable" },
        { value: "off", description: "deep recall uses fusion order only" },
      ],
      { optional },
    ),
    "memory.consolidate.enabled": { input: "boolean", optional },
    "memory.consolidate.idleMinutes": { input: "number", optional },
    "memory.consolidate.maxPerDay": { input: "number", optional },
    // Unset = the agent's own model runs consolidation.
    "memory.consolidate.model.provider": select(providerOptions(models), {
      optional: true,
      description: "model used to distill episodes into facts; unset = the agent's own model",
    }),
    "memory.consolidate.model.name": select(modelOptions(models), {
      optional: true,
      groupBy: "memory.consolidate.model.provider",
    }),
    "memory.decayHalfLifeDays": { input: "number", optional },
  };
}

// Sandbox knobs (SandboxConfig). Same shape on config.json (workspace default)
// and agent.json (per-agent override); trust-tier resolution can force a real
// backend regardless, so these are preferences, not the security boundary.
function sandboxHints(): FileHints {
  return {
    "sandbox.enabled": { input: "boolean", optional: true, description: "run agent subprocesses inside the sandbox" },
    "sandbox.backend": select(values(sandboxBackendIds()), {
      optional: true,
      description: "isolation backend; untrusted agents are always forced onto a real one",
    }),
    "sandbox.net": select(
      [
        { value: "full", description: "normal network access" },
        { value: "none", description: "no network inside the sandbox" },
      ],
      { optional: true },
    ),
    "sandbox.writable": { input: "json", optional: true, description: 'extra writable paths, e.g. ["/some/dir"]' },
    "sandbox.credentialProxy": {
      input: "boolean",
      optional: true,
      description: "route LLM calls through the daemon so the sandboxed process never holds real API keys",
    },
  };
}

const HOOK_EXAMPLE = '["./notify.sh"] or [{"command": "…", "timeoutSec": 30}]';

// Observer hooks (HooksConfig): fire-and-forget shell commands at room
// lifecycle points — they observe, never gate.
function hooksHints(): FileHints {
  return {
    "hooks.preTurn": { input: "json", optional: true, description: `run before each agent turn: ${HOOK_EXAMPLE}` },
    "hooks.postTurn": { input: "json", optional: true, description: `run after a reply commits: ${HOOK_EXAMPLE}` },
    "hooks.toolUse": { input: "json", optional: true, description: `run after each tool call settles: ${HOOK_EXAMPLE}` },
    "hooks.error": { input: "json", optional: true, description: `run when a turn fails: ${HOOK_EXAMPLE}` },
  };
}

// Every registered TTS engine's declared voice ids, enumerated uniformly from
// the registry (engines with none — free-form voices — are skipped). A newly
// registered engine's voices surface here without touching shared code; never
// a hardcoded engine id.
function ttsVoiceCatalog(): TtsEngineSpec[] {
  return ttsEngineIds()
    .map((id) => findTtsEngine(id))
    .filter((engine): engine is TtsEngineSpec => Boolean(engine?.voices.length));
}

function ttsVoiceHintDescription(): string {
  const catalog = ttsVoiceCatalog()
    .map((engine) => `${engine.id}: ${engine.voices.join(" | ")}`)
    .join("; ");
  return `voice for the engine, read-aloud + calls${catalog ? ` (${catalog})` : ""}`;
}

// Same catalog as picker options, one voice per row, grouped by its engine —
// this is the enumeration shared with the native (unmute) call-voice picker
// so both stay in lockstep with the TTS engine registry.
function ttsVoiceOptions(): FieldHintOption[] {
  return ttsVoiceCatalog().flatMap((engine) => engine.voices.map((voice) => ({ value: voice, group: engine.id })));
}

function mcpServersHint(extra: Partial<FieldHint> = {}): FieldHint {
  return {
    input: "json",
    optional: true,
    description: 'MCP servers by name: {"docs": {"command": "npx", "args": ["-y", "some-server"]}} or {"api": {"url": "https://…"}}',
    ...extra,
  };
}

function configJsonHints(sources: HintSources): FileHints {
  return {
    defaultAgent: select(values(sources.agentIds)),
    room: select(values(sources.roomIds)),
    transcriptWindow: { input: "number" },
    harness: select(harnessSelectOptions(), { optional: true }),
    maxSummonsPerRoom: { input: "number", optional: true, description: "max concurrently running summons per room" },
    mcpServers: mcpServersHint(),
    ...sandboxHints(),
    ...hooksHints(),
    ...memoryHints(false, sources.models),
    ...fileHarnessMeta(),
  };
}

function agentJsonHints(sources: HintSources, parsed?: Record<string, unknown>, agentId?: string): FileHints {
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
  // Filter by the raw provider id (harness spec data) BEFORE building options —
  // `group` on the built options is the display label, not the id, so the id
  // match has to happen against the source ModelChoice, not the option.
  const modelNameOptions = modelFilterProviders
    ? modelOptions(allModels.filter((model) => modelFilterProviders.includes(model.provider)))
    : modelOptions(allModels);
  const providerOptionList = providerOptions(allModels);

  return {
    thinking: select(values(sources.thinkingLevels), { optional: true }),
    tools: { input: "multiselect", options: values(sources.toolNames), hidden: hiddenByHarness.has("tools") },
    skills: {
      input: "multiselect",
      options: orderSkillSections(sources.skills, rawHarness),
      label: "Skills",
      description: "Auto-detected skills this agent loads — from the project, ~/.gaia, and every installed harness (pi, Claude, Codex, Hermes). Detected ≠ loaded: check the ones this agent should use.",
    },
    role: select(roleHintOptions(agentId), {
      optional: true,
      label: "Role",
      description: "default role loaded for this agent (roles are markdown files in the roles dir)",
    }),
    permissionMode: select(values(permissionModeOptions(rawHarness)), { optional: true, hidden: hiddenByHarness.has("permissionMode") }),
    account: select(accountSelectOptions(rawHarness), {
      optional: true,
      label: "Account",
      description: "named provider account this agent runs under (add accounts in the global accounts.json settings file); unset = the shared login",
      hidden: hiddenByHarness.has("account"),
    }),
    harness: select(harnessSelectOptions(), { optional: true }),
    "model.provider": select(providerOptionList, { optional: true, hidden: providerLocked }),
    "model.name": select(modelNameOptions, { optional: true, groupBy: providerLocked ? undefined : "model.provider" }),
    trust: {
      input: "boolean",
      optional: true,
      description: "trust tier (default true); false forces a real sandbox and forbids summoning",
    },
    allowNestedSummon: {
      input: "boolean",
      optional: true,
      description: "may summon further workers when itself running as a summon (default false)",
    },
    mcpServers: mcpServersHint({ hidden: hiddenByHarness.has("mcpServers") }),
    voice: select(ttsVoiceOptions(), {
      optional: true,
      label: "Native call voice (unmute)",
      description: "native unmute call voice (a voices.yaml id); ignored when tts.engine drives the call (e.g. claude)",
    }),
    "tts.engine": select(values(ttsEngineIds()), {
      optional: true,
      label: "Voice mode for this agent",
      description: "Which voice this agent speaks with — read-aloud AND live calls (claude routes calls through the bridge). Overrides the workspace default; leave unset to inherit voice.json.",
    }),
    "tts.voice": {
      input: "text",
      optional: true,
      label: "Voice",
      description: ttsVoiceHintDescription(),
    },
    ...sandboxHints(),
    ...memoryHints(true, sources.models),
    ...fileHarnessMeta(),
  };
}

function schedulesJsonHints(sources: HintSources): FileHints {
  return {
    enabled: { input: "boolean" },
    "jobs.[].id": { input: "text", description: "unique job id (letters, digits, dashes)" },
    "jobs.[].schedule": {
      input: "text",
      description: '5-field cron ("0 9 * * 1-5"), "every 30m" / "every 2h" / "every 1d", or @hourly/@daily/@weekly/@monthly',
    },
    "jobs.[].prompt": { input: "text", description: "the message sent to the agent on each run" },
    "jobs.[].agent": select(values(sources.agentIds), { optional: true }),
    "jobs.[].room": select(values(sources.roomIds), { optional: true }),
    "jobs.[].enabled": { input: "boolean", optional: true },
    "jobs.[].isolated": { input: "boolean", optional: true, description: "run in a private child room (default); false runs in the target room" },
    "jobs.[].chainOutput": { input: "boolean", optional: true, description: "feed the previous run's output into the next prompt" },
  };
}

function voiceJsonHints(): FileHints {
  return {
    ttsEngine: select(values(ttsEngineIds()), {
      optional: true,
      label: "Voice mode (default TTS engine)",
      description: "Which voice speaks — kyutai (local), claude (claude.ai voices), or elevenlabs. This is the workspace default; an agent overrides it in its own settings (tts.engine).",
    }),
    disableThinking: { input: "boolean", label: "Auto-disable thinking on calls", description: "Turn the agent's thinking off for the duration of a voice call (lower latency); it reverts on hang-up." },
    speakOnSilence: { input: "boolean", label: "Speak up during silences", description: "When you go quiet on a call, let the agent check back in on its own instead of waiting." },
    silenceDelaySec: { input: "number", label: "Silence before speaking up (seconds)", description: "How long you can be quiet before the agent speaks up (only when 'Speak up during silences' is on)." },
    autoStart: { input: "boolean", label: "Auto-start the voice stack", description: "Bring up the local speech services automatically when a call starts." },
    startTimeoutSec: { input: "number", label: "Voice-stack start timeout (seconds)", description: "How long to wait for the speech services to come up before giving up (first start loads models — keep this generous)." },
    unmuteUrl: { input: "text", optional: true, label: "unmute backend URL", description: "unmute backend the browser connects to (default ws://127.0.0.1:8000)" },
    unmuteDir: { input: "text", optional: true, label: "unmute checkout", description: "local unmute checkout to auto-start; empty = the bundled one" },
    claudeVoiceUrl: { input: "text", optional: true, label: "claude-voice daemon URL", description: "claude-voice daemon for the claude engine (default http://127.0.0.1:8778)" },
    claudeVoiceDir: { input: "text", optional: true, label: "claude-voice checkout (auto-start)", description: "claude-voice checkout to auto-start when its daemon is down; empty = never auto-start" },
    elevenLabsApiKey: { input: "text", optional: true, label: "ElevenLabs API key", description: "ElevenLabs API key (xi-api-key) for the elevenlabs engine; stored locally, or set ELEVENLABS_API_KEY" },
    elevenLabsModel: select(values(["eleven_v3", "eleven_multilingual_v2", "eleven_flash_v2_5", "eleven_turbo_v2_5"]), {
      optional: true,
      label: "ElevenLabs model",
      description: "ElevenLabs model — eleven_v3 renders [moans]/[breathy]/[laughs] audio tags; flash/turbo trade tags for lower latency",
    }),
    elevenLabsVoice: { input: "text", optional: true, label: "ElevenLabs default voice", description: "default ElevenLabs voice id when an agent sets no tts.voice" },
    sttEngine: select(values(sttEngineIds()), {
      optional: true,
      label: "Voice input (dictation) engine",
      description: "Which speech-to-text engine the composer mic uses — elevenlabs (Scribe API, reuses the ElevenLabs key) or openai (any OpenAI-compatible /audio/transcriptions endpoint, hosted or a local whisper-server). Swappable like the TTS engine.",
    }),
    sttLanguage: { input: "text", optional: true, label: "Dictation language", description: "optional spoken-language hint (ISO code like 'en'); empty auto-detects" },
    elevenLabsSttModel: { input: "text", optional: true, label: "ElevenLabs STT model", description: "ElevenLabs speech-to-text model for the elevenlabs dictation engine (default scribe_v1)" },
    sttOpenAiBaseUrl: { input: "text", optional: true, label: "OpenAI STT base URL", description: "base URL for the openai dictation engine — default OpenAI, or a local whisper-server (http://127.0.0.1:8080/v1) to keep dictation fully local" },
    sttOpenAiApiKey: { input: "text", optional: true, label: "OpenAI STT API key", description: "API key for the openai dictation engine; empty falls back to OPENAI_API_KEY (a localhost base URL may need none)" },
    sttOpenAiModel: { input: "text", optional: true, label: "OpenAI STT model", description: "model for the openai dictation engine (default whisper-1, or a local model name)" },
  };
}

// accounts.json (~/.gaia): named provider accounts. The credential-field
// vocabulary is the UNION of every registered harness's declared account
// fields — data on the specs, never a harness-id branch (RULE #0).
function accountsJsonHints(): FileHints {
  const withAccounts = harnessSpecs().filter((spec) => spec.accounts);
  const hints: FileHints = {
    "accounts.[].id": { input: "text", description: "unique account id — what an agent's `account` setting references" },
    "accounts.[].harness": select(values(withAccounts.map((spec) => spec.id)), {
      description: "owning harness; only that harness's agents can bind to this account",
    }),
    "accounts.[].label": { input: "text", optional: true, description: "display name for pickers" },
  };
  for (const spec of withAccounts) {
    for (const field of spec.accounts?.fields ?? []) {
      hints[`accounts.[].credentials.${field.key}`] = {
        input: "text",
        label: field.label,
        optional: true,
        description: [field.hint, `(${spec.ui.label} accounts)`].filter(Boolean).join(" "),
      };
    }
  }
  return hints;
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
  if (basename === "agent.json") return agentJsonHints(sources, parsed, agentIdFromAgentJsonLabel(file.label));
  if (basename === "voice.json") return voiceJsonHints();
  if (basename === "schedules.json") return schedulesJsonHints(sources);
  if (basename === "accounts.json") return accountsJsonHints();
  return undefined;
}

// ---------------------------------------------------------------------------
// Editable-file catalog. Scopes/ids exactly as v1: id = `${scope}_${sha256 of
// the resolved path, 18 hex chars}` so saved links stay stable across
// versions.

/** True when `path` is `root` or contained inside it. */
function pathInside(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Stable id derived from a resolved path (v1's pathId). */
function pathId(path: string, length: number): string {
  return createHash("sha256").update(resolve(path)).digest("hex").slice(0, length);
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
    const files = [globalPaths.appSettings(), globalPaths.voiceSettings(), globalPaths.accounts(), ...(await walkEditable(globalPaths.agentsDir()))];
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
