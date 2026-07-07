// Settings: the workspace panel (right pane) and the global settings modal,
// both driven by server-listed editable files with hint-driven editors
// (dropdowns / multiselect / boolean / number / text + raw view toggle).
// Files carry server-computed metadata (agentId, category) so grouping never
// has to parse label paths. Everything here renders inside the "settings"
// region, so streaming SSE traffic never wipes an in-progress edit.
import { api } from "./api.js";
import { $, h } from "./dom.js";
import { PathText } from "./links.js";
import { markDirty, registerRegion, setError } from "./render.js";
import { state } from "./state.js";

/** @typedef {import("./types.js").FileDescriptor} FileDescriptor */
/** @typedef {import("./types.js").EditableFile} EditableFile */
/** @typedef {import("./types.js").FieldHint} FieldHint */
/** @typedef {import("./types.js").FieldHintOption} FieldHintOption */
/** @typedef {import("./types.js").FileHints} FileHints */
/** @typedef {import("./types.js").HarnessHintsMeta} HarnessHintsMeta */
/** @typedef {(string|number)[]} JsonPath */
/** @typedef {{ id: string, config: FileDescriptor[], persona: FileDescriptor[], memory: FileDescriptor[], files: FileDescriptor[] }} AgentGroup */

// ---------------------------------------------------------------------------
// Region: workspace panel + modal.

function renderSettings() {
  renderWorkspacePanel();
  renderModal();
}

registerRegion("settings", renderSettings);

function renderWorkspacePanel() {
  const panel = $("#workspace-panel");
  if (!panel) return;
  panel.replaceChildren(
    h("div", { class: "panel-head" }, h("h2", { text: "Workspace" }), h("small", {}, state.snapshot?.workspace.rootDir ? PathText(state.snapshot.workspace.rootDir) : "none")),
    FileSelector(state.workspaceFiles, state.selectedWorkspaceFileId, async (id) => {
      state.selectedWorkspaceFileId = id;
      await loadSelectedWorkspaceFile();
      markDirty("settings");
    }),
    FileSettingsEditor({
      file: state.workspaceFile,
      raw: state.workspaceRaw,
      setRaw: (value) => {
        state.workspaceRaw = value;
        markDirty("settings");
      },
    }),
  );
}

function renderModal() {
  const slot = $("#overlay-settings");
  if (!slot) return;
  if (!state.settingsOpen) slot.replaceChildren();
  else slot.replaceChildren(SettingsModal());
}

// ---------------------------------------------------------------------------
// Selection state helpers.

/** @param {string} category @param {FileDescriptor[]} [files] */
function filesInCategory(category, files = state.globalFiles) {
  return files.filter((file) => file.category === category);
}

/** @param {FileDescriptor[]} [files] */
function globalSettingsSections(files = state.globalFiles) {
  const agentIds = new Set(files.map((file) => file.agentId).filter(Boolean));
  return [
    { id: "general", label: "General", count: filesInCategory("general", files).length },
    { id: "voice", label: "Voice", count: filesInCategory("voice", files).length },
    { id: "agents", label: "Agents", count: agentIds.size },
  ];
}

/** @param {FileDescriptor[]} [files] @returns {AgentGroup[]} */
function globalAgentGroups(files = state.globalFiles) {
  /** @type {Map<string, AgentGroup>} */
  const groups = new Map();
  for (const file of files) {
    if (!file.agentId) continue;
    let group = groups.get(file.agentId);
    if (!group) {
      group = { id: file.agentId, config: [], persona: [], memory: [], files: [] };
      groups.set(file.agentId, group);
    }
    group.files.push(file);
    if (file.category === "config" || file.category === "persona" || file.category === "memory") group[file.category].push(file);
  }
  return [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** @param {FileDescriptor} file */
function globalAgentFileLabel(file) {
  return file.label.replace(/^agents\/[^/]+\//, "").replace(/^persona\//, "");
}

function selectedGlobalFile() {
  return state.globalFiles.find((file) => file.id === state.selectedGlobalFileId) ?? null;
}

function selectedGlobalAgentGroup() {
  const groups = globalAgentGroups();
  const agentId = selectedGlobalFile()?.agentId;
  return groups.find((group) => group.id === agentId) ?? groups[0] ?? null;
}

/** @returns {"config"|"persona"|"memory"} */
function selectedGlobalAgentView() {
  const file = selectedGlobalFile();
  const category = file?.agentId ? file.category : "config";
  return category === "config" || category === "persona" || category === "memory" ? category : "config";
}

function currentGlobalFiles() {
  if (state.selectedGlobalSection !== "agents") return filesInCategory(state.selectedGlobalSection);
  const group = selectedGlobalAgentGroup();
  if (!group) return [];
  const files = group[selectedGlobalAgentView()];
  return files.length > 0 ? files : group.files;
}

export function syncGlobalSettingsSelection() {
  const selected = selectedGlobalFile();
  if (selected) {
    state.selectedGlobalSection = selected.agentId ? "agents" : (selected.category ?? "general");
    return;
  }
  const generalFiles = filesInCategory("general");
  state.selectedGlobalSection = generalFiles.length > 0 ? "general" : "agents";
  state.selectedGlobalFileId = generalFiles[0]?.id ?? globalAgentGroups()[0]?.files[0]?.id ?? null;
}

/** @param {string} sectionId */
async function selectGlobalSection(sectionId) {
  state.selectedGlobalSection = sectionId;
  const files = currentGlobalFiles();
  if (!files.some((file) => file.id === state.selectedGlobalFileId)) state.selectedGlobalFileId = files[0]?.id ?? null;
  await loadSelectedGlobalFile();
  markDirty("settings");
}

/** @param {string} agentId */
async function selectGlobalAgent(agentId) {
  state.selectedGlobalSection = "agents";
  const group = globalAgentGroups().find((candidate) => candidate.id === agentId);
  state.selectedGlobalFileId = group?.config[0]?.id ?? group?.files[0]?.id ?? null;
  await loadSelectedGlobalFile();
  markDirty("settings");
}

/**
 * Entry point for clickable agent rows: opens the global settings modal with
 * that agent's files selected.
 * @param {string} agentId
 */
export async function openAgentSettings(agentId) {
  state.settingsOpen = true;
  await selectGlobalAgent(agentId);
}

/** @param {"config"|"persona"|"memory"} view */
async function selectGlobalAgentView(view) {
  const group = selectedGlobalAgentGroup();
  state.selectedGlobalFileId = group?.[view]?.[0]?.id ?? state.selectedGlobalFileId;
  await loadSelectedGlobalFile();
  markDirty("settings");
}

// ---------------------------------------------------------------------------
// File loading + saving.

export async function loadInitialFiles() {
  state.selectedWorkspaceFileId = state.selectedWorkspaceFileId ?? state.workspaceFiles[0]?.id ?? null;
  syncGlobalSettingsSelection();
  await Promise.all([loadSelectedWorkspaceFile(), loadSelectedGlobalFile()]);
}

export async function loadSelectedWorkspaceFile() {
  if (!state.selectedWorkspaceFileId || !state.snapshot) return;
  const params = new URLSearchParams({ workspaceId: state.snapshot.workspace.id });
  state.workspaceFile = (await api(`/api/files/${encodeURIComponent(state.selectedWorkspaceFileId)}?${params}`)).file;
}

export async function loadSelectedGlobalFile() {
  if (!state.selectedGlobalFileId) {
    state.globalFile = null;
    return;
  }
  state.globalFile = (await api(`/api/files/${encodeURIComponent(state.selectedGlobalFileId)}`)).file;
}

/** @param {EditableFile} file @param {string} content */
async function saveFile(file, content) {
  if (!file) return;
  const params = file.scope === "workspace" && state.snapshot ? `?${new URLSearchParams({ workspaceId: state.snapshot.workspace.id })}` : "";
  const body = await api(`/api/files/${encodeURIComponent(file.id)}${params}`, {
    method: "PUT",
    body: JSON.stringify({ content }),
  });
  if (file.scope === "workspace") state.workspaceFile = body.file;
  else state.globalFile = body.file;
  markDirty("settings");
}

// ---------------------------------------------------------------------------
// Modal.

async function handleAddAgent() {
  const id = state.addAgentId.trim();
  if (!id) {
    state.addAgentError = "Agent id is required";
    markDirty("settings");
    return;
  }
  try {
    await api("/api/agents", {
      method: "POST",
      body: JSON.stringify({ id, displayName: state.addAgentName.trim() || undefined }),
    });
    // Refresh global files and select the new agent.
    const app = await api("/api/app");
    state.globalFiles = app.globalFiles ?? state.globalFiles;
    state.addAgentOpen = false;
    state.addAgentId = "";
    state.addAgentName = "";
    state.addAgentError = "";
    syncGlobalSettingsSelection();
    await selectGlobalAgent(id);
    await loadSelectedGlobalFile();
    markDirty("settings");
  } catch (error) {
    state.addAgentError = error instanceof Error ? error.message : String(error);
    markDirty("settings");
  }
}

function AddAgentForm() {
  return h(
    "div",
    { class: "add-agent-form" },
    state.addAgentError ? h("div", { class: "error", text: state.addAgentError }) : null,
    h(
      "label",
      { class: "setting-row" },
      h("span", { text: "id" }),
      h("input", {
        type: "text",
        placeholder: "agent-id",
        value: state.addAgentId,
        oninput: (event) => {
          state.addAgentId = /** @type {HTMLInputElement} */ (event.target).value;
          state.addAgentError = "";
        },
        onkeydown: (event) => {
          if (event.key === "Enter") void handleAddAgent();
        },
      }),
    ),
    h(
      "label",
      { class: "setting-row" },
      h("span", { text: "name" }),
      h("input", {
        type: "text",
        placeholder: "Display Name",
        value: state.addAgentName,
        oninput: (event) => {
          state.addAgentName = /** @type {HTMLInputElement} */ (event.target).value;
          state.addAgentError = "";
        },
        onkeydown: (event) => {
          if (event.key === "Enter") void handleAddAgent();
        },
      }),
    ),
    h(
      "div",
      { class: "add-agent-actions" },
      h("button", { onclick: () => void handleAddAgent(), text: "create" }),
      h("button", {
        onclick: () => {
          state.addAgentOpen = false;
          state.addAgentId = "";
          state.addAgentName = "";
          state.addAgentError = "";
          markDirty("settings");
        },
        text: "cancel",
      }),
    ),
  );
}

/** @param {{ labeler?: (file: FileDescriptor) => string }} [options] */
function GlobalFileEditor(options = {}) {
  return [
    FileSelector(
      currentGlobalFiles(),
      state.selectedGlobalFileId,
      async (id) => {
        state.selectedGlobalFileId = id;
        syncGlobalSettingsSelection();
        await loadSelectedGlobalFile();
        markDirty("settings");
      },
      options,
    ),
    FileSettingsEditor({
      file: state.globalFile,
      raw: state.globalRaw,
      setRaw: (value) => {
        state.globalRaw = value;
        markDirty("settings");
      },
    }),
  ];
}

function SettingsModal() {
  const sections = globalSettingsSections();
  const agents = globalAgentGroups();
  const selectedAgent = selectedGlobalAgentGroup();
  const selectedView = selectedGlobalAgentView();
  const agentViews = /** @type {const} */ ([
    { id: "config", label: "Config", files: selectedAgent?.config ?? [] },
    { id: "persona", label: "Persona", files: selectedAgent?.persona ?? [] },
    { id: "memory", label: "Memory", files: selectedAgent?.memory ?? [] },
  ]);

  return h(
    "div",
    { class: "modal-backdrop" },
    h(
      "section",
      { class: "modal" },
      h(
        "div",
        { class: "panel-head" },
        h("h2", { text: "Global Settings" }),
        h("button", {
          onclick: () => {
            state.settingsOpen = false;
            markDirty("settings");
          },
          text: "x",
        }),
      ),
      h(
        "div",
        { class: "segmented-tabs" },
        sections.map((section) =>
          h(
            "button",
            {
              class: `${section.id === state.selectedGlobalSection ? "active" : ""} ${section.count === 0 ? "muted" : ""}`.trim(),
              onclick: () => void selectGlobalSection(section.id),
              disabled: section.count === 0,
            },
            h("span", { text: section.label }),
            h("small", { text: String(section.count) }),
          ),
        ),
      ),
      state.selectedGlobalSection !== "agents"
        ? GlobalFileEditor()
        : h(
            "div",
            { class: "settings-split" },
            h(
              "div",
              { class: "settings-sidebar-panel" },
              h("div", { class: "nav-title", text: "agents" }),
              h(
                "div",
                { class: "file-tabs" },
                agents.length === 0
                  ? h("span", { class: "empty", text: "no agents" })
                  : agents.map((agent) =>
                      h(
                        "button",
                        { class: agent.id === selectedAgent?.id ? "active" : "", onclick: () => void selectGlobalAgent(agent.id) },
                        h("span", { text: agent.id }),
                        h("small", { text: `${agent.files.length} files` }),
                      ),
                    ),
              ),
              state.addAgentOpen
                ? AddAgentForm()
                : h("button", {
                    class: "nav-action",
                    onclick: () => {
                      state.addAgentOpen = true;
                      markDirty("settings");
                    },
                    text: "+ add agent",
                  }),
            ),
            h(
              "div",
              { class: "settings-main-panel" },
              selectedAgent
                ? [
                    h(
                      "div",
                      { class: "segmented-tabs nested" },
                      agentViews.map((view) =>
                        h(
                          "button",
                          {
                            class: `${view.id === selectedView ? "active" : ""} ${view.files.length === 0 ? "muted" : ""}`.trim(),
                            onclick: () => void selectGlobalAgentView(view.id),
                            disabled: view.files.length === 0,
                          },
                          h("span", { text: view.label }),
                          h("small", { text: String(view.files.length) }),
                        ),
                      ),
                    ),
                    ...GlobalFileEditor({ labeler: globalAgentFileLabel }),
                  ]
                : h("div", { class: "empty", text: "no agent selected" }),
            ),
          ),
    ),
  );
}

/**
 * @param {FileDescriptor[]} files
 * @param {string|null} selectedId
 * @param {(id: string) => void|Promise<void>} onSelect
 * @param {{ labeler?: (file: FileDescriptor) => string, emptyText?: string }} [options]
 */
function FileSelector(files, selectedId, onSelect, options = {}) {
  const labeler = options.labeler ?? ((/** @type {FileDescriptor} */ file) => file.label);
  const emptyText = options.emptyText ?? "no editable files";
  return h(
    "div",
    { class: "file-tabs" },
    files.length === 0
      ? h("span", { class: "empty", text: emptyText })
      : files.map((file) =>
          h(
            "button",
            { class: file.id === selectedId ? "active" : "", onclick: () => void onSelect(file.id) },
            h("span", { text: labeler(file) }),
            h("small", {}, PathText(file.path)),
          ),
        ),
  );
}

/** @param {{ file: EditableFile|null, raw: boolean, setRaw: (value: boolean) => void }} options */
function FileSettingsEditor({ file, raw, setRaw }) {
  if (!file) return h("div", { class: "empty", text: "select a file" });
  const editor = h("div", { class: "settings-editor" });
  const rawText = /** @type {HTMLTextAreaElement} */ (h("textarea", { class: "raw-editor", value: file.content }));
  const view = file.kind === "json" ? JsonSettingsView(file.content, file.hints) : MarkdownSettingsView(file.content);
  editor.append(
    h(
      "div",
      { class: "file-toolbar" },
      h("code", {}, PathText(file.path)),
      h("button", { onclick: () => setRaw(!raw), text: raw ? "view" : "raw" }),
      h("button", { onclick: () => void saveFile(file, raw ? rawText.value : serializeSettings(view, file.kind)), text: "save" }),
    ),
    raw ? rawText : view,
  );
  return editor;
}

// --- Hint-aware JSON settings view -----------------------------------------
//
// Hints come from the server keyed by normalized JSON path ("defaultAgent",
// "model.provider", "tools"). The renderer is generic: it knows input shapes
// (select/multiselect/number/text), never specific fields. Files stay plain
// JSON; this only changes the editing controls.

/** Hint attached to a rendered select, for dependent-option rebuilds. @type {WeakMap<HTMLSelectElement, FieldHint>} */
const hintOf = new WeakMap();

/** @param {JsonPath} path */
function pathKey(path) {
  return path.map((segment) => (typeof segment === "number" ? "[]" : segment)).join(".");
}

/** @param {any} root @param {JsonPath} path @returns {any} */
function getJsonPathValue(root, path) {
  let current = root;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = current[segment];
  }
  return current;
}

/** @param {FieldHintOption} option */
function optionText(option) {
  const label = option.label ?? option.value;
  return option.description ? `${label} — ${option.description}` : label;
}

/**
 * @param {HTMLSelectElement} select
 * @param {FieldHint} hint
 * @param {string} currentValue
 * @param {unknown} groupValue
 */
function buildSelectOptions(select, hint, currentValue, groupValue) {
  select.replaceChildren();
  if (hint.optional) select.append(h("option", { value: "", text: "(not set)" }));
  const options = hint.options ?? [];
  const visible = options.filter((option) => !hint.groupBy || !groupValue || !option.group || option.group === groupValue);
  let currentListed = currentValue === "" || currentValue === undefined;
  for (const option of visible) {
    if (option.value === currentValue) currentListed = true;
    select.append(h("option", { value: option.value, text: optionText(option) }));
  }
  if (!currentListed) select.append(h("option", { value: currentValue, text: `${currentValue} (current)` }));
  select.value = currentValue ?? "";
}

/**
 * @param {JsonPath} entryPath
 * @param {string} key
 * @param {FieldHint} hint
 * @param {unknown} currentValue
 * @param {any} parsedRoot
 */
function HintedSelect(entryPath, key, hint, currentValue, parsedRoot) {
  const select = /** @type {HTMLSelectElement} */ (
    h("select", {
      "data-json-path": JSON.stringify(entryPath),
      "data-path-key": pathKey(entryPath),
      ...(hint.optional ? { "data-json-optional": "1" } : {}),
      ...(hint.groupBy ? { "data-group-by": hint.groupBy } : {}),
    })
  );
  const groupValue = hint.groupBy ? getJsonPathValue(parsedRoot, hint.groupBy.split(".")) : undefined;
  buildSelectOptions(select, hint, currentValue === undefined || currentValue === null ? "" : String(currentValue), groupValue);
  hintOf.set(select, hint);
  return h("label", { class: "setting-row", ...rowTitle(hint) }, fieldLabel(key, hint), select);
}

/** Field description → tooltip + a `data-desc` attr the CSS renders as a visible
 * full-width help line under the row. @param {FieldHint} hint */
function rowTitle(hint) {
  return hint.description ? { title: hint.description, "data-desc": hint.description } : {};
}

/**
 * The name cell of a setting row: the friendly `hint.label` when set, else the
 * raw JSON key — so a setting like "Voice mode" is findable by name rather than
 * hidden behind "ttsEngine". The description renders below via rowTitle's CSS.
 * @param {string} key @param {FieldHint} hint
 */
function fieldLabel(key, hint) {
  return h("span", { class: "field-name", text: hint.label ?? key });
}

/**
 * @param {JsonPath} entryPath
 * @param {string} key
 * @param {FieldHint} hint
 * @param {unknown} currentValues
 */
function HintedMultiselect(entryPath, key, hint, currentValues) {
  const values = Array.isArray(currentValues) ? currentValues.map(String) : [];
  const known = (hint.options ?? []).map((option) => option.value);
  const extras = values.filter((value) => !known.includes(value));
  const container = h(
    "div",
    { class: "multi-options", "data-json-path": JSON.stringify(entryPath), "data-json-multi": "1", "data-path-key": pathKey(entryPath) },
    [...(hint.options ?? []), ...extras.map((value) => ({ value }))].map((option) =>
      h(
        "label",
        { class: "multi-option", title: /** @type {FieldHintOption} */ (option).description ?? "" },
        h("input", { type: "checkbox", "data-value": option.value, ...(values.includes(option.value) ? { checked: true } : {}) }),
        h("span", { text: /** @type {FieldHintOption} */ (option).label ?? option.value }),
      ),
    ),
  );
  return h("div", { class: "setting-row stacked", ...rowTitle(hint) }, fieldLabel(key, hint), container);
}

/** @param {JsonPath} entryPath @param {string} key @param {FieldHint} hint @param {unknown} currentValue */
function HintedNumber(entryPath, key, hint, currentValue) {
  return h(
    "label",
    { class: "setting-row", ...rowTitle(hint) },
    fieldLabel(key, hint),
    h("input", {
      type: "number",
      "data-json-path": JSON.stringify(entryPath),
      "data-json-number": "1",
      value: currentValue === undefined || currentValue === null ? "" : String(currentValue),
    }),
  );
}

/** @param {JsonPath} entryPath @param {string} key @param {FieldHint} hint @param {unknown} currentValue */
function HintedBoolean(entryPath, key, hint, currentValue) {
  const select = /** @type {HTMLSelectElement} */ (
    h("select", {
      "data-json-path": JSON.stringify(entryPath),
      "data-path-key": pathKey(entryPath),
      "data-json-boolean": "1",
    })
  );
  if (hint.optional || (currentValue !== true && currentValue !== false)) select.append(h("option", { value: "", text: "(not set)" }));
  select.append(h("option", { value: "true", text: "true" }));
  select.append(h("option", { value: "false", text: "false" }));
  select.value = currentValue === true ? "true" : currentValue === false ? "false" : "";
  return h("label", { class: "setting-row", ...rowTitle(hint) }, fieldLabel(key, hint), select);
}

/** Plain string field. Hinted so absent-but-known settings still render a row. */
/** @param {JsonPath} entryPath @param {string} key @param {FieldHint} hint @param {unknown} currentValue */
function HintedText(entryPath, key, hint, currentValue) {
  return h(
    "label",
    { class: "setting-row", ...rowTitle(hint) },
    fieldLabel(key, hint),
    h("input", {
      "data-json-path": JSON.stringify(entryPath),
      "data-json-text": "1",
      "data-path-key": pathKey(entryPath),
      ...(hint.optional ? { "data-json-optional": "1" } : {}),
      value: currentValue === undefined || currentValue === null ? "" : String(currentValue),
      ...(hint.description ? { placeholder: hint.description } : {}),
    }),
  );
}

/**
 * Structured subtree (mcpServers, hooks.*, sandbox.writable) edited as raw
 * JSON in place. Empty clears the key; invalid JSON keeps the saved value.
 * @param {JsonPath} entryPath @param {string} key @param {FieldHint} hint @param {unknown} currentValue
 */
function HintedJson(entryPath, key, hint, currentValue) {
  return h(
    "div",
    { class: "setting-row stacked", ...rowTitle(hint) },
    fieldLabel(key, hint),
    h("textarea", {
      class: "json-field",
      "data-json-path": JSON.stringify(entryPath),
      "data-json-json": "1",
      "data-path-key": pathKey(entryPath),
      value: currentValue === undefined ? "" : JSON.stringify(currentValue, null, 2),
      ...(hint.description ? { placeholder: hint.description } : {}),
    }),
  );
}

/**
 * @param {JsonPath} entryPath
 * @param {string} key
 * @param {FieldHint} hint
 * @param {unknown} currentValue
 * @param {any} parsedRoot
 * @returns {HTMLElement|null}
 */
function hintedField(entryPath, key, hint, currentValue, parsedRoot) {
  if (hint.input === "select") return HintedSelect(entryPath, key, hint, currentValue, parsedRoot);
  if (hint.input === "multiselect") return HintedMultiselect(entryPath, key, hint, currentValue);
  if (hint.input === "number") return HintedNumber(entryPath, key, hint, currentValue);
  if (hint.input === "boolean") return HintedBoolean(entryPath, key, hint, currentValue);
  if (hint.input === "text") return HintedText(entryPath, key, hint, currentValue);
  if (hint.input === "json") return HintedJson(entryPath, key, hint, currentValue);
  return null;
}

/** @param {unknown} value */
function jsonFieldText(value) {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (value === undefined) return "";
  return JSON.stringify(value);
}

/** @param {string} value @returns {unknown} */
function parseJsonFieldValue(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** @param {unknown} value @returns {value is object} */
function isStructuredJsonValue(value) {
  return value !== null && typeof value === "object";
}

/** @typedef {{ hints: Record<string, FieldHint>, parsedRoot: any, renderedKeys: Set<string> }} JsonRenderCtx */

/**
 * @param {HTMLElement} container
 * @param {any} value
 * @param {JsonPath} path
 * @param {JsonRenderCtx} ctx
 */
function renderJsonFields(container, value, path, ctx) {
  /** @type {[string, any][]} */
  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item]) : Object.entries(value ?? {});
  if (entries.length === 0) {
    container.append(h("div", { class: "empty", text: Array.isArray(value) ? "empty list" : "empty object" }));
    return;
  }

  for (const [key, entryValue] of entries) {
    const entryPath = [...path, Array.isArray(value) ? Number(key) : key];
    const entryKey = pathKey(entryPath);
    const hint = ctx.hints[entryKey];

    if (hint) {
      const field = hintedField(entryPath, Array.isArray(value) ? `[${key}]` : key, hint, entryValue, ctx.parsedRoot);
      if (field) {
        ctx.renderedKeys.add(entryKey);
        container.append(field);
        continue;
      }
    }

    if (isStructuredJsonValue(entryValue)) {
      const nested = h("div", { class: "json-nested" });
      renderJsonFields(nested, entryValue, entryPath, ctx);
      container.append(h("div", { class: "setting-row stacked" }, h("span", { text: Array.isArray(value) ? `[${key}]` : key }), nested));
      continue;
    }

    container.append(
      h(
        "label",
        { class: "setting-row" },
        h("span", { text: Array.isArray(value) ? `[${key}]` : key }),
        h("input", { "data-json-path": JSON.stringify(entryPath), value: jsonFieldText(entryValue) }),
      ),
    );
  }
}

/**
 * Hinted fields that are absent from the file still show up as editable rows
 * (e.g. "model.provider" on an agent.json without a model block). Saving with
 * a value creates the key; "(not set)" keeps it out of the file.
 * @param {HTMLElement} container
 * @param {any} parsed
 * @param {JsonRenderCtx} ctx
 */
function appendMissingHintedFields(container, parsed, ctx) {
  const missing = Object.entries(ctx.hints).filter(([key]) => !ctx.renderedKeys.has(key) && !key.includes("[]"));
  if (missing.length === 0) return;

  for (const [key, hint] of missing) {
    const entryPath = key.split(".");
    const currentValue = getJsonPathValue(parsed, entryPath);
    const field = hintedField(entryPath, key, hint, currentValue, ctx.parsedRoot);
    if (field) container.append(field);
  }
}

/** @param {HTMLElement} root */
function wireDependentSelects(root) {
  for (const element of root.querySelectorAll("select[data-group-by]")) {
    const dependent = /** @type {HTMLSelectElement} */ (element);
    const source = /** @type {HTMLSelectElement|null} */ (root.querySelector(`[data-path-key="${dependent.dataset.groupBy}"]`));
    if (!source) continue;
    source.addEventListener("change", () => {
      const hint = hintOf.get(dependent);
      if (hint) buildSelectOptions(dependent, hint, dependent.value, source.value);
    });
  }
}

/**
 * @param {string} content
 * @param {FileHints|undefined} hints
 * @returns {HTMLElement}
 */
function JsonSettingsView(content, hints) {
  /** @type {any} */
  let parsed = {};
  try {
    parsed = JSON.parse(content || "{}");
  } catch {
    return h("textarea", { class: "raw-editor", value: content });
  }

  // Only FieldHint entries drive rendering; non-FieldHint entries (e.g.
  // _harness) are consumed separately by wireHarnessFieldVisibility.
  /** @type {Record<string, FieldHint>} */
  const hintDict = {};
  for (const [key, hint] of Object.entries(hints ?? {})) {
    if (typeof hint === "object" && hint !== null && "input" in hint) hintDict[key] = hint;
  }

  const root = h("div", { class: "settings-view", "data-kind": "json", "data-json-source": JSON.stringify(parsed) });
  /** @type {JsonRenderCtx} */
  const ctx = { hints: hintDict, parsedRoot: parsed, renderedKeys: new Set() };
  renderJsonFields(root, parsed, [], ctx);
  appendMissingHintedFields(root, parsed, ctx);
  wireDependentSelects(root);

  // Wire harness-driven field visibility using the _harness meta the server
  // attaches to hints. Harness configs declare which fields to hide/show;
  // model-provider locking and model-name filtering also live here.
  const harnessMeta = (hints ?? {})._harness;
  if (harnessMeta) wireHarnessFieldVisibility(root, harnessMeta, hintDict, parsed);

  return root;
}

/**
 * Harness-driven field visibility. Reads harness configs from `_harness` meta
 * attached by the server. When the harness select changes:
 * - fields in the config's `hiddenFields` are hidden / re-shown
 * - if the config has `lockedProvider`, model.provider is hidden and model.name
 *   options are rebuilt from only the locked provider's models
 * - if the config has `modelProviderIds`, model.name options are filtered
 *
 * No harness-specific branches are hardcoded; the meta dict drives everything.
 * @param {HTMLElement} root
 * @param {HarnessHintsMeta} harnessMeta
 * @param {Record<string, FieldHint>} hints
 * @param {any} parsed
 */
function wireHarnessFieldVisibility(root, harnessMeta, hints, parsed) {
  const harnessSelect = /** @type {HTMLSelectElement|null} */ (root.querySelector('[data-path-key="harness"]'));
  if (!harnessSelect) return;

  const allModelHint = hints["model.name"];
  const allModelOptions = (allModelHint?.options ?? []).slice();

  /** @param {string[]|null} providerIds */
  function buildModelNameOptions(providerIds) {
    if (!allModelHint) return;
    const modelSelect = /** @type {HTMLSelectElement|null} */ (root.querySelector('[data-path-key="model.name"]'));
    if (!modelSelect) return;
    const filtered = providerIds ? allModelOptions.filter((opt) => providerIds.includes(opt.group ?? "")) : allModelOptions;
    // Preserve current value through rebuild.
    const currentValue = modelSelect.value;
    modelSelect.replaceChildren();
    if (allModelHint.optional) modelSelect.append(h("option", { value: "", text: "(not set)" }));
    let currentListed = currentValue === "" || currentValue === undefined;
    for (const option of filtered) {
      if (option.value === currentValue) currentListed = true;
      modelSelect.append(h("option", { value: option.value, text: optionText(option) }));
    }
    if (!currentListed) modelSelect.append(h("option", { value: currentValue, text: `${currentValue} (current)` }));
    modelSelect.value = currentValue ?? "";
  }

  // Some harnesses (e.g. Claude Code) take their own model aliases rather than
  // a Pi catalog id. Offer exactly those names and drop any stale value that
  // isn't valid for the harness.
  /** @param {string[]} names */
  function buildModelNameFromNames(names) {
    const modelSelect = /** @type {HTMLSelectElement|null} */ (root.querySelector('[data-path-key="model.name"]'));
    if (!modelSelect) return;
    const currentValue = modelSelect.value;
    modelSelect.replaceChildren();
    if (allModelHint?.optional !== false) modelSelect.append(h("option", { value: "", text: "(not set)" }));
    for (const name of names) modelSelect.append(h("option", { value: name, text: name }));
    modelSelect.value = names.includes(currentValue) ? currentValue : "";
  }

  /** @param {string} fieldKey @returns {HTMLElement|null} */
  function findFieldRow(fieldKey) {
    const el = /** @type {HTMLElement|null} */ (root.querySelector(`[data-path-key="${fieldKey}"]`));
    if (!el) return null;
    return /** @type {HTMLElement|null} */ (el.closest(".setting-row")) ?? el;
  }

  /** @param {string} harnessValue */
  function applyHarnessVisibility(harnessValue) {
    const config = (harnessMeta?.configs ?? {})[harnessValue] ?? null;

    // Collect all field keys that any harness might hide.
    /** @type {Set<string>} */
    const allHiddenFields = new Set();
    for (const cfg of Object.values(harnessMeta?.configs ?? {})) {
      for (const field of cfg.hiddenFields ?? []) allHiddenFields.add(field);
    }

    for (const fieldKey of allHiddenFields) {
      const shouldHide = config ? (config.hiddenFields ?? []).includes(fieldKey) : false;
      const row = findFieldRow(fieldKey);

      if (shouldHide) {
        if (row) {
          row.setAttribute("data-skip-serialize", "1");
          row.style.display = "none";
        }
      } else {
        if (row) {
          row.removeAttribute("data-skip-serialize");
          row.style.display = "";
        } else {
          const hint = hints[fieldKey];
          if (!hint) continue;
          const entryPath = fieldKey.split(".");
          const field = hintedField(entryPath, entryPath[entryPath.length - 1], hint, getJsonPathValue(parsed, entryPath), parsed);
          if (field) root.append(field);
        }
      }
    }

    // Harness supplies its own model-name aliases (e.g. Claude): hide provider,
    // offer exactly those names, and discard any stale value.
    const providerRow = findFieldRow("model.provider");
    if (config?.modelNameOptions) {
      if (providerRow) {
        providerRow.setAttribute("data-skip-serialize", "1");
        providerRow.style.display = "none";
      }
      buildModelNameFromNames(config.modelNameOptions);
      return;
    }

    // Handle locked provider: hide model.provider row, rebuild model.name options.
    const providerLocked = config?.lockedProvider;
    if (providerLocked) {
      if (providerRow) {
        providerRow.setAttribute("data-skip-serialize", "1");
        providerRow.style.display = "none";
      }
      buildModelNameOptions(config?.modelProviderIds ?? [providerLocked]);
    } else {
      if (providerRow) {
        providerRow.removeAttribute("data-skip-serialize");
        providerRow.style.display = "";
      }
      buildModelNameOptions(config?.modelProviderIds ?? null);
    }
  }

  harnessSelect.addEventListener("change", () => applyHarnessVisibility(harnessSelect.value));
  applyHarnessVisibility(harnessSelect.value);
}

/** @param {any} root @param {JsonPath} path @param {unknown} value */
function setJsonPathValue(root, path, value) {
  if (path.length === 0) return value;
  let current = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (current[key] === null || typeof current[key] !== "object") {
      current[key] = typeof path[index + 1] === "number" ? [] : {};
    }
    current = current[key];
  }
  current[path[path.length - 1]] = value;
  return root;
}

/** @param {any} root @param {JsonPath} path */
function deleteJsonPathValue(root, path) {
  let current = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    current = current?.[path[index]];
    if (current === null || typeof current !== "object") return;
  }
  if (current && typeof current === "object") delete current[path[path.length - 1]];
}

/** @param {string} content */
function MarkdownSettingsView(content) {
  const root = h("div", { class: "settings-view", "data-kind": "markdown" });
  const lines = content.split("\n");
  /** @type {string[]} */
  let block = [];
  const flushBlock = () => {
    while (block.length > 0 && block[0].trim() === "") block.shift();
    while (block.length > 0 && block[block.length - 1].trim() === "") block.pop();
    const value = block.join("\n");
    if (value.trim()) {
      root.append(h("textarea", { class: "text-setting", rows: String(Math.max(3, Math.min(12, value.split("\n").length + 1))), "data-md": "text", value }));
    }
    block = [];
  };

  for (const line of lines) {
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushBlock();
      root.append(h("div", { class: "setting-heading", "data-md": "heading", "data-level": heading[1].length, text: heading[2] }));
      continue;
    }
    block.push(line);
  }

  flushBlock();
  return root;
}

/** @param {HTMLElement} view @param {string} kind */
function serializeSettings(view, kind) {
  if (kind === "json") {
    /** @type {any} */
    let next = {};
    try {
      next = JSON.parse(view.dataset.jsonSource || "{}");
    } catch {
      next = {};
    }
    for (const raw of view.querySelectorAll("[data-json-path]")) {
      const element = /** @type {HTMLElement} */ (raw);
      if (element.closest("[data-skip-serialize]")) continue;
      const path = /** @type {JsonPath} */ (JSON.parse(element.dataset.jsonPath || "[]"));
      if (element.dataset.jsonMulti !== undefined) {
        const checked = [...element.querySelectorAll("input[type=checkbox]")]
          .map((box) => /** @type {HTMLInputElement} */ (box))
          .filter((box) => box.checked)
          .map((box) => box.dataset.value ?? "");
        setJsonPathValue(next, path, checked);
        continue;
      }
      if (element.dataset.jsonBoolean !== undefined) {
        const value = /** @type {HTMLSelectElement} */ (element).value;
        if (value === "") deleteJsonPathValue(next, path);
        else setJsonPathValue(next, path, value === "true");
        continue;
      }
      if (element.tagName === "SELECT") {
        const select = /** @type {HTMLSelectElement} */ (element);
        if (select.value === "" && select.dataset.jsonOptional !== undefined) deleteJsonPathValue(next, path);
        else setJsonPathValue(next, path, select.value);
        continue;
      }
      if (element.dataset.jsonNumber !== undefined) {
        const input = /** @type {HTMLInputElement} */ (element);
        if (input.value.trim() === "") deleteJsonPathValue(next, path);
        else setJsonPathValue(next, path, Number(input.value));
        continue;
      }
      if (element.dataset.jsonText !== undefined) {
        const input = /** @type {HTMLInputElement} */ (element);
        if (input.value === "" && element.dataset.jsonOptional !== undefined) deleteJsonPathValue(next, path);
        else setJsonPathValue(next, path, input.value);
        continue;
      }
      if (element.dataset.jsonJson !== undefined) {
        const text = /** @type {HTMLTextAreaElement} */ (element).value.trim();
        if (text === "") {
          deleteJsonPathValue(next, path);
          continue;
        }
        // Invalid JSON keeps whatever the file already holds rather than
        // corrupting it; the raw editor is the escape hatch for fixing it.
        try {
          setJsonPathValue(next, path, JSON.parse(text));
        } catch {
          /* keep saved value */
        }
        continue;
      }
      setJsonPathValue(next, path, parseJsonFieldValue(/** @type {HTMLInputElement} */ (element).value));
    }
    return `${JSON.stringify(next, null, 2)}\n`;
  }

  /** @type {string[]} */
  const lines = [];
  for (const child of view.children) {
    const node = /** @type {HTMLElement} */ (child);
    if (node.dataset.md === "heading") lines.push(`${"#".repeat(Number(node.dataset.level ?? 1))} ${node.textContent}`);
    else if (node.dataset.md === "text") lines.push(/** @type {HTMLTextAreaElement} */ (node).value);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
