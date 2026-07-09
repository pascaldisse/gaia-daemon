// The Settings modal: a workspace-scoped file browser + raw text editor over
// the server's editable-file catalog (general/voice/agents), plus the
// keep-awake toggle. Files stay RAW for now (plain textarea, read on save) —
// a later task adds a hint-driven smart form on top, consuming
// state.settingsFileHints, which every file load already populates.
import { loadSettingsFile, saveSettingsFile, setKeepAwake } from "./actions.js";
import { $, h } from "./dom.js";
import { PathText } from "./links.js";
import { markDirty, registerRegion } from "./render.js";
import { state } from "./state.js";

/** @typedef {import("./types.js").FileDescriptor} FileDescriptor */
/** @typedef {{ id: string, config: FileDescriptor[], persona: FileDescriptor[], memory: FileDescriptor[], files: FileDescriptor[] }} AgentGroup */

// ---------------------------------------------------------------------------
// Open/close + tab & selection state.

export function openSettings() {
  state.settingsOpen = true;
  markDirty("settings");
  void selectTab(state.settingsTab);
}

export function closeSettings() {
  state.settingsOpen = false;
  markDirty("settings");
}

/** @param {"general"|"workspace"|"agents"} tab */
async function selectTab(tab) {
  state.settingsTab = tab;
  markDirty("settings");
  if (tab === "workspace") {
    const files = state.settingsWorkspaceFiles;
    const stillPresent = files.some((file) => file.id === state.settingsSelectedWorkspaceFileId);
    const id = stillPresent ? state.settingsSelectedWorkspaceFileId : (files[0]?.id ?? null);
    if (id) await selectWorkspaceFile(id);
    else clearFile();
  } else if (tab === "agents") {
    const group = selectedAgentGroup();
    if (group) await selectAgent(group.id);
    else clearFile();
  }
}

function clearFile() {
  state.settingsFile = null;
  state.settingsFileHints = undefined;
  markDirty("settings");
}

/** @param {string} id */
async function selectWorkspaceFile(id) {
  state.settingsSelectedWorkspaceFileId = id;
  markDirty("settings");
  await loadSettingsFile(id, { workspaceId: state.snapshot?.workspace.id });
}

/** @returns {AgentGroup[]} */
function agentGroups() {
  /** @type {Map<string, AgentGroup>} */
  const groups = new Map();
  for (const file of state.settingsGlobalFiles) {
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

function selectedAgentGroup() {
  const groups = agentGroups();
  return groups.find((group) => group.id === state.settingsAgentId) ?? groups[0] ?? null;
}

/** @param {AgentGroup|null} group @param {"config"|"persona"|"memory"} view */
function agentViewFiles(group, view) {
  if (!group) return [];
  const files = group[view];
  return files.length > 0 ? files : group.files;
}

/** @param {string} agentId */
async function selectAgent(agentId) {
  state.settingsAgentId = agentId;
  const group = agentGroups().find((candidate) => candidate.id === agentId) ?? null;
  const fileId = agentViewFiles(group, state.settingsAgentView)[0]?.id ?? group?.files[0]?.id ?? null;
  state.settingsSelectedAgentFileId = fileId;
  markDirty("settings");
  if (fileId) await loadSettingsFile(fileId);
  else clearFile();
}

/** @param {"config"|"persona"|"memory"} view */
async function selectAgentView(view) {
  state.settingsAgentView = view;
  const group = selectedAgentGroup();
  const fileId = agentViewFiles(group, view)[0]?.id ?? state.settingsSelectedAgentFileId;
  state.settingsSelectedAgentFileId = fileId;
  markDirty("settings");
  if (fileId) await loadSettingsFile(fileId);
  else clearFile();
}

/** @param {string} id */
async function selectAgentFile(id) {
  state.settingsSelectedAgentFileId = id;
  markDirty("settings");
  await loadSettingsFile(id);
}

// ---------------------------------------------------------------------------
// Region: the modal renders into its own overlay slot.

function renderSettingsModal() {
  const slot = $("#overlay-settings");
  if (!slot) return;
  if (!state.settingsOpen) {
    slot.replaceChildren();
    return;
  }
  slot.replaceChildren(SettingsModal());
}

registerRegion("settings", renderSettingsModal);

function SettingsModal() {
  const tabs = /** @type {const} */ ([
    { id: "general", label: "General" },
    { id: "workspace", label: "Workspace" },
    { id: "agents", label: "Agents" },
  ]);
  return h(
    "div",
    {
      class: "modal-backdrop",
      onclick: (/** @type {MouseEvent} */ event) => {
        if (event.target === event.currentTarget) closeSettings();
      },
    },
    h(
      "section",
      { class: "modal settings2-modal" },
      h(
        "div",
        { class: "panel-head" },
        h("h2", { text: "Settings" }),
        h("button", { onclick: closeSettings, text: "x" }),
      ),
      h(
        "div",
        { class: "segmented-tabs" },
        tabs.map((tab) =>
          h(
            "button",
            { class: tab.id === state.settingsTab ? "active" : "", onclick: () => void selectTab(tab.id) },
            h("span", { text: tab.label }),
          ),
        ),
      ),
      h(
        "div",
        { class: "settings2-body" },
        state.settingsTab === "general" ? GeneralTab() : state.settingsTab === "workspace" ? WorkspaceTab() : AgentsTab(),
      ),
    ),
  );
}

// ---------------------------------------------------------------------------
// General tab: just the keep-awake toggle (only where the daemon supports it).

function GeneralTab() {
  if (!state.keepAwake.supported) return h("div", { class: "empty", text: "no general settings on this host" });
  return h(
    "label",
    { class: "settings2-row" },
    h("span", { text: "Keep laptop awake while GAIA runs" }),
    h("input", {
      type: "checkbox",
      checked: state.keepAwake.enabled,
      onchange: (event) => void setKeepAwake(/** @type {HTMLInputElement} */ (event.target).checked),
    }),
  );
}

// ---------------------------------------------------------------------------
// Workspace tab: this workspace's editable files (left) + raw editor (right).

function WorkspaceTab() {
  return h(
    "div",
    { class: "settings2-split" },
    h(
      "div",
      { class: "settings2-sidebar" },
      FileList(state.settingsWorkspaceFiles, state.settingsSelectedWorkspaceFileId, selectWorkspaceFile, "no editable workspace files"),
    ),
    h("div", { class: "settings2-main" }, RawFileEditor()),
  );
}

// ---------------------------------------------------------------------------
// Agents tab: agent list (left) + that agent's config/persona/memory files.

function AgentsTab() {
  const groups = agentGroups();
  const selected = selectedAgentGroup();
  const views = /** @type {const} */ ([
    { id: "config", label: "Config" },
    { id: "persona", label: "Persona" },
    { id: "memory", label: "Memory" },
  ]);
  return h(
    "div",
    { class: "settings2-split" },
    h(
      "div",
      { class: "settings2-sidebar" },
      h("div", { class: "nav-title", text: "agents" }),
      h(
        "div",
        { class: "file-tabs" },
        groups.length === 0
          ? h("span", { class: "empty", text: "no agents" })
          : groups.map((group) =>
              h(
                "button",
                { class: group.id === selected?.id ? "active" : "", onclick: () => void selectAgent(group.id) },
                h("span", { text: group.id }),
                h("small", { text: `${group.files.length} files` }),
              ),
            ),
      ),
    ),
    h(
      "div",
      { class: "settings2-main" },
      selected
        ? [
            h(
              "div",
              { class: "segmented-tabs" },
              views.map((view) =>
                h(
                  "button",
                  {
                    class: `${view.id === state.settingsAgentView ? "active" : ""} ${selected[view.id].length === 0 ? "muted" : ""}`.trim(),
                    onclick: () => void selectAgentView(view.id),
                    disabled: selected[view.id].length === 0,
                  },
                  h("span", { text: view.label }),
                  h("small", { text: String(selected[view.id].length) }),
                ),
              ),
            ),
            FileList(agentViewFiles(selected, state.settingsAgentView), state.settingsSelectedAgentFileId, selectAgentFile, "no files in this category", agentFileLabel),
            RawFileEditor(),
          ]
        : h("div", { class: "empty", text: "no agent selected" }),
    ),
  );
}

/** @param {FileDescriptor} file */
function agentFileLabel(file) {
  return file.label.replace(/^agents\/[^/]+\//, "").replace(/^persona\//, "");
}

// ---------------------------------------------------------------------------
// Shared file list + raw editor.

/**
 * @param {FileDescriptor[]} files
 * @param {string|null} selectedId
 * @param {(id: string) => void|Promise<void>} onSelect
 * @param {string} [emptyText]
 * @param {(file: FileDescriptor) => string} [labeler]
 */
function FileList(files, selectedId, onSelect, emptyText = "no editable files", labeler = (file) => file.label) {
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

/**
 * Raw text editor for state.settingsFile. The textarea is UNCONTROLLED — its
 * value is read only on save — so a full "settings" region re-render (e.g. from
 * another tick) never fights the caret while typing. The dirty badge is a
 * direct DOM toggle for the same reason, not a state field.
 */
function RawFileEditor() {
  const file = state.settingsFile;
  if (!file) return h("div", { class: "empty", text: "select a file" });
  const dirtyBadge = h("small", { class: "settings2-dirty", hidden: true, text: "unsaved" });
  const textarea = /** @type {HTMLTextAreaElement} */ (
    h("textarea", {
      class: "settings2-raw",
      value: file.content,
      oninput: () => {
        dirtyBadge.hidden = textarea.value === file.content;
      },
    })
  );
  const saveButton = h("button", {
    text: "save",
    onclick: () => {
      saveButton.setAttribute("disabled", "");
      saveButton.textContent = "saving…";
      void saveSettingsFile(textarea.value);
    },
  });
  return h(
    "div",
    { class: "settings2-editor" },
    h("div", { class: "file-toolbar" }, h("code", {}, PathText(file.path)), dirtyBadge, saveButton),
    textarea,
    state.settingsError ? h("div", { class: "settings2-error-line", text: state.settingsError }) : null,
  );
}
