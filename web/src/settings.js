// The Settings modal: a workspace-scoped file browser + editor over the
// server's editable-file catalog (general/voice/agents), plus the keep-awake
// toggle. The editor renders a hints-driven FORM for JSON files that carry
// field hints (state.settingsFileHints) — a raw textarea remains the escape
// hatch (view toggle) and the only option for files with no hints or
// unparseable JSON (persona/memory markdown included).
import { loadSettingsFile, saveSettingsFile, setKeepAwake, setUserName } from "./actions.js";
import { api } from "./api.js";
import { $, h } from "./dom.js";
import { PathText } from "./links.js";
import { markDirty, registerRegion } from "./render.js";
import { state } from "./state.js";

/** @typedef {import("./types.js").FileDescriptor} FileDescriptor */
/** @typedef {import("./types.js").FieldHint} FieldHint */
/** @typedef {import("./types.js").FieldHintOption} FieldHintOption */
/** @typedef {import("./types.js").FileHints} FileHints */
/** @typedef {import("./types.js").HarnessHintsMeta} HarnessHintsMeta */
/** @typedef {{ id: string, config: FileDescriptor[], persona: FileDescriptor[], memory: FileDescriptor[], files: FileDescriptor[] }} AgentGroup */
/** @typedef {(string|number)[]} JsonPath */
/** @typedef {{ key: string, hint: FieldHint, path: JsonPath }} FieldEntry */
/** @typedef {{ id: string, harness: string, label?: string }} Account */
/** @typedef {{ id: string, label?: string, login: boolean }} AccountHarness */
/** @typedef {{ accounts: Account[], harnesses: AccountHarness[] }} AccountsCatalog */
/** @typedef {{
 *   sessionId: string,
 *   harness: string,
 *   status: "starting"|"awaiting-signin"|"awaiting-code"|"done"|"error"|"cancelled",
 *   url?: string,
 *   code?: string,
 *   account?: Account,
 *   error?: string,
 * }} LoginSession */
/**
 * @typedef {{
 *   draft: any,
 *   hints: Record<string, FieldHint>,
 *   harnessMeta: HarnessHintsMeta|undefined,
 *   rerender: () => void,
 *   markDirtyBadge: () => void,
 * }} FormCtx
 */

// ---------------------------------------------------------------------------
// Open/close + tab & selection state.

export function openSettings() {
  state.settingsOpen = true;
  markDirty("settings");
  void selectTab(state.settingsTab);
}

/**
 * Entry point for clickable agent rows (e.g. the room panel): opens the
 * settings modal directly on that agent's files, as if its row in the
 * Agents tab had been clicked.
 * @param {string} agentId
 */
export async function openAgentSettings(agentId) {
  state.settingsOpen = true;
  state.settingsTab = "agents";
  await selectAgent(agentId);
  markDirty("settings");
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
  state.settingsDraft = null;
  markDirty("settings");
}

/**
 * Load a file's content+hints (actions.js) then derive the form draft from
 * it and reset the view to the default (form, whenever a form is possible) —
 * every entry point that opens a *different* file goes through this, so the
 * form/raw toggle never carries a stale draft or view choice from the file
 * that was open before.
 * @param {string} id @param {{ workspaceId?: string }} [opts]
 */
async function loadFileForEditing(id, opts) {
  await loadSettingsFile(id, opts);
  syncDraftFromFile();
  state.settingsView = "form";
}

/** @param {string} id */
async function selectWorkspaceFile(id) {
  state.settingsSelectedWorkspaceFileId = id;
  markDirty("settings");
  await loadFileForEditing(id, { workspaceId: state.snapshot?.workspace.id });
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
  if (fileId) await loadFileForEditing(fileId);
  else clearFile();
}

/** @param {"config"|"persona"|"memory"} view */
async function selectAgentView(view) {
  state.settingsAgentView = view;
  const group = selectedAgentGroup();
  const fileId = agentViewFiles(group, view)[0]?.id ?? state.settingsSelectedAgentFileId;
  state.settingsSelectedAgentFileId = fileId;
  markDirty("settings");
  if (fileId) await loadFileForEditing(fileId);
  else clearFile();
}

/** @param {string} id */
async function selectAgentFile(id) {
  state.settingsSelectedAgentFileId = id;
  markDirty("settings");
  await loadFileForEditing(id);
}

// ---------------------------------------------------------------------------
// Region: the modal renders into its own overlay slot.

/** Tracks the open/closed *edge* (not the level) so accounts reload once per
 * settings-modal open — regardless of which entry point opened it (openSettings
 * vs. openAgentSettings) — rather than on every re-render while it stays open.
 * @type {boolean} */
let settingsWasOpen = false;

function renderSettingsModal() {
  const slot = $("#overlay-settings");
  if (!slot) return;
  if (!state.settingsOpen) {
    settingsWasOpen = false;
    slot.replaceChildren();
    return;
  }
  if (!settingsWasOpen) {
    settingsWasOpen = true;
    void loadAccounts();
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
      AccountsSection(),
    ),
  );
}

// ---------------------------------------------------------------------------
// General tab: "your name" (always) + the keep-awake toggle (only where the
// daemon supports it).

function GeneralTab() {
  const rows = [
    h(
      "label",
      { class: "settings2-row" },
      h("span", { text: "Your name" }),
      h("input", {
        type: "text",
        placeholder: "user",
        value: state.userName,
        // Fires on blur/Enter, not per keystroke — matches the checkbox
        // row's onchange below, and avoids a request per typed character.
        onchange: (event) => void setUserName(/** @type {HTMLInputElement} */ (event.target).value),
      }),
    ),
  ];
  if (state.keepAwake.supported) {
    rows.push(
      h(
        "label",
        { class: "settings2-row" },
        h("span", { text: "Keep laptop awake while GAIA runs" }),
        h("input", {
          type: "checkbox",
          checked: state.keepAwake.enabled,
          onchange: (event) => void setKeepAwake(/** @type {HTMLInputElement} */ (event.target).checked),
        }),
      ),
    );
  }
  return h("div", {}, rows);
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
    h("div", { class: "settings2-main" }, FileEditor()),
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
            FileEditor(),
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
// Accounts section: harness-grouped credentials + at most one in-flight
// in-app login session, both held as MODULE state (not on the shared `state`
// object from state.js — nothing else in the app needs them) and rerendered
// through the same markDirty("settings") trigger every other view in this
// file uses. Section is always mounted below the General/Workspace/Agents
// tabs (see AccountsSection() call in SettingsModal) rather than gated behind
// its own tab, so it never touches state.settingsTab's typed union.

/** @type {AccountsCatalog|null} */
let accountsCatalog = null;
/** @type {string} */
let accountsError = "";
/** @type {string} */
let accountsNotice = "";
/** @type {LoginSession|null} */
let loginSession = null;
/** @type {ReturnType<typeof setInterval>|undefined} */
let loginPollTimer;
/** @type {Record<string, string>} */
let loginLabelDrafts = {};
/** @type {string} */
let loginCodeDraft = "";

/** @param {LoginSession["status"]} status @returns {boolean} */
function isActiveLoginStatus(status) {
  return status === "starting" || status === "awaiting-signin" || status === "awaiting-code";
}

function stopLoginPolling() {
  if (loginPollTimer === undefined) return;
  clearInterval(loginPollTimer);
  loginPollTimer = undefined;
}

/** Guards against duplicate intervals: any existing poll is cleared before a
 * new one starts. @param {string} sessionId */
function startLoginPolling(sessionId) {
  stopLoginPolling();
  loginPollTimer = setInterval(() => void pollLoginSession(sessionId), 1000);
}

/** @param {string} sessionId */
async function pollLoginSession(sessionId) {
  try {
    const body = await api(`/api/accounts/login/${encodeURIComponent(sessionId)}`);
    applyLoginSession(body.session);
  } catch (error) {
    stopLoginPolling();
    loginSession = null;
    accountsError = error instanceof Error ? error.message : String(error);
    markDirty("settings");
  }
}

/** Apply a fresh LoginSession from any of the login endpoints, handling the
 * per-status side effects the spec calls for (stop polling + clear/reload on
 * terminal statuses). @param {LoginSession} session */
function applyLoginSession(session) {
  loginSession = session;
  if (session.status === "done") {
    stopLoginPolling();
    loginSession = null;
    accountsNotice = `account ${session.account?.id ?? session.harness} added`;
    markDirty("settings"); // reflect the cleared session/notice now — loadAccounts's own markDirty lands later, once the refetch resolves
    void loadAccounts();
    return;
  }
  if (session.status === "cancelled") {
    stopLoginPolling();
    loginSession = null;
  } else if (session.status === "error") {
    stopLoginPolling(); // kept in state (with .error) until the user hits Dismiss
  }
  markDirty("settings");
}

/** @param {string} harnessId */
async function startLogin(harnessId) {
  if (loginSession) return; // only one active login session at a time
  accountsError = "";
  accountsNotice = "";
  const label = (loginLabelDrafts[harnessId] ?? "").trim();
  try {
    const body = await api("/api/accounts/login", {
      method: "POST",
      body: JSON.stringify({ harness: harnessId, ...(label ? { label } : {}) }),
    });
    applyLoginSession(body.session);
    if (isActiveLoginStatus(body.session.status)) startLoginPolling(body.session.sessionId);
  } catch (error) {
    accountsError = error instanceof Error ? error.message : String(error);
    markDirty("settings");
  }
}

/** @param {string} text */
async function submitLoginInput(text) {
  if (!loginSession) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  try {
    const body = await api(`/api/accounts/login/${encodeURIComponent(loginSession.sessionId)}/input`, {
      method: "POST",
      body: JSON.stringify({ text: trimmed }),
    });
    loginCodeDraft = "";
    applyLoginSession(body.session);
  } catch (error) {
    accountsError = error instanceof Error ? error.message : String(error);
    markDirty("settings");
  }
}

async function cancelLogin() {
  if (!loginSession) return;
  const sessionId = loginSession.sessionId;
  try {
    const body = await api(`/api/accounts/login/${encodeURIComponent(sessionId)}`, { method: "DELETE", body: "{}" });
    applyLoginSession(body.session);
  } catch (error) {
    // Never get stuck on a dead session just because the cancel call itself failed.
    stopLoginPolling();
    loginSession = null;
    accountsError = error instanceof Error ? error.message : String(error);
    markDirty("settings");
  }
}

function dismissLoginError() {
  stopLoginPolling();
  loginSession = null;
  markDirty("settings");
}

/** @param {string} id */
async function removeAccount(id) {
  if (!confirm(`Remove account "${id}"?`)) return;
  accountsError = "";
  accountsNotice = "";
  try {
    await api(`/api/accounts/${encodeURIComponent(id)}`, { method: "DELETE", body: "{}" });
    await loadAccounts();
  } catch (error) {
    accountsError = error instanceof Error ? error.message : String(error);
    markDirty("settings");
  }
}

async function loadAccounts() {
  try {
    /** @type {{ accounts?: Account[], harnesses?: AccountHarness[] }} */
    const body = await api("/api/accounts");
    accountsCatalog = { accounts: body.accounts ?? [], harnesses: body.harnesses ?? [] };
  } catch (error) {
    accountsCatalog = accountsCatalog ?? { accounts: [], harnesses: [] };
    accountsError = error instanceof Error ? error.message : String(error);
  }
  markDirty("settings");
}

/** @param {Account} account @returns {HTMLElement} */
function AccountRow(account) {
  return h(
    "div",
    { class: "settings2-row" },
    h("div", {}, h("span", { text: account.label ?? account.id }), h("small", { class: "muted", text: ` ${account.id}` })),
    h("button", { class: "settings2-row-remove", title: "remove this account", onclick: () => void removeAccount(account.id), text: "Remove" }),
  );
}

/** @param {AccountHarness} harness @returns {HTMLElement} */
function LoginControls(harness) {
  const disabled = loginSession !== null;
  const input = h("input", {
    type: "text",
    placeholder: "label (optional)",
    value: loginLabelDrafts[harness.id] ?? "",
    disabled,
    oninput: (/** @type {Event} */ event) => {
      loginLabelDrafts[harness.id] = /** @type {HTMLInputElement} */ (event.target).value;
    },
  });
  return h(
    "div",
    { class: "settings2-field-control" },
    input,
    h("button", { disabled, onclick: () => void startLogin(harness.id), text: "Log in" }),
  );
}

/** @param {LoginSession} session @returns {HTMLElement} */
function LoginSessionPanel(session) {
  const cancelButton = h("button", { onclick: () => void cancelLogin(), text: "Cancel" });
  if (session.status === "error") {
    return h(
      "div",
      { class: "settings2-row" },
      h("span", { class: "settings2-error-line", text: session.error ?? "login failed" }),
      h("button", { onclick: dismissLoginError, text: "Dismiss" }),
    );
  }
  if (session.status === "starting") {
    return h("div", { class: "settings2-row" }, h("span", { class: "muted", text: "starting login…" }), cancelButton);
  }
  if (session.status === "awaiting-signin") {
    return h(
      "div",
      {},
      h(
        "div",
        { class: "settings2-row" },
        session.url ? h("a", { href: session.url, target: "_blank", rel: "noreferrer", text: "Open sign-in page" }) : h("span", { class: "muted", text: "waiting for a sign-in link…" }),
        cancelButton,
      ),
      session.code ? h("div", { class: "settings2-row" }, h("span", { text: "Enter this code on the page: " }), h("code", { text: session.code })) : null,
      h("small", { class: "muted", text: "a browser may also have opened on the machine running gaia — sign in there, then come back" }),
    );
  }
  // "awaiting-code"
  const codeInput = /** @type {HTMLInputElement} */ (
    h("input", {
      type: "text",
      placeholder: "paste code",
      value: loginCodeDraft,
      oninput: (/** @type {Event} */ event) => {
        loginCodeDraft = /** @type {HTMLInputElement} */ (event.target).value;
      },
    })
  );
  return h(
    "div",
    {},
    session.url ? h("div", { class: "settings2-row" }, h("a", { href: session.url, target: "_blank", rel: "noreferrer", text: "Open sign-in page" })) : null,
    h(
      "div",
      { class: "settings2-field-control" },
      codeInput,
      h("button", { onclick: () => void submitLoginInput(codeInput.value), text: "Submit" }),
      cancelButton,
    ),
  );
}

/** @param {AccountHarness} harness @returns {HTMLElement} */
function HarnessAccountsGroup(harness) {
  const accounts = (accountsCatalog?.accounts ?? []).filter((account) => account.harness === harness.id);
  const isThisSession = loginSession?.harness === harness.id;
  return h(
    "div",
    { class: "settings2-form" },
    h("div", { class: "nav-title", text: harness.label ?? harness.id }),
    accounts.length === 0 ? h("div", { class: "empty", text: "no accounts" }) : accounts.map((account) => AccountRow(account)),
    isThisSession ? null : harness.login ? LoginControls(harness) : h("div", { class: "muted", text: "add credentials via accounts.json" }),
    isThisSession && loginSession ? LoginSessionPanel(loginSession) : null,
  );
}

function AccountsSection() {
  return h(
    "div",
    { class: "settings2-body" },
    h("h3", { text: "Accounts" }),
    accountsError ? h("div", { class: "settings2-error-line", text: accountsError }) : null,
    accountsNotice ? h("div", { class: "settings2-notice", text: accountsNotice }) : null,
    accountsCatalog === null
      ? h("div", { class: "empty", text: "loading…" })
      : accountsCatalog.harnesses.length === 0
        ? h("div", { class: "empty", text: "no harnesses support accounts" })
        : accountsCatalog.harnesses.map((harness) => HarnessAccountsGroup(harness)),
  );
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

// ---------------------------------------------------------------------------
// Hints-driven form model: the draft + dotted-path helpers (copied semantics
// from the pre-purge settings.js — git show 72551cd~1:web/src/settings.js).

/** Only FieldHint entries drive rendering; `_harness` (HarnessHintsMeta) is
 * consumed separately by harnessHiddenKeys.
 * @param {FileHints|undefined} hints @returns {Record<string, FieldHint>} */
function hintFieldDict(hints) {
  /** @type {Record<string, FieldHint>} */
  const dict = {};
  for (const [key, hint] of Object.entries(hints ?? {})) {
    if (hint && typeof hint === "object" && "input" in hint) dict[key] = /** @type {FieldHint} */ (hint);
  }
  return dict;
}

/** @param {FileHints|undefined} hints @returns {HarnessHintsMeta|undefined} */
function harnessMetaOf(hints) {
  const meta = hints?._harness;
  return meta && typeof meta === "object" && "configs" in meta ? /** @type {HarnessHintsMeta} */ (meta) : undefined;
}

/** @param {string} key @returns {JsonPath} */
function keyPath(key) {
  return key.split(".");
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

/** @param {any} root @param {JsonPath} path @param {unknown} value */
function setJsonPathValue(root, path, value) {
  let current = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (current[key] === null || typeof current[key] !== "object") current[key] = {};
    current = current[key];
  }
  current[path[path.length - 1]] = value;
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

/** @param {any} draft */
function serializeDraft(draft) {
  return `${JSON.stringify(draft, null, 2)}\n`;
}

/**
 * Re-derive state.settingsDraft from the just-loaded/just-saved
 * state.settingsFile: parses only when the file carries at least one field
 * hint AND its content is valid JSON. Never touches state.settingsView — a
 * raw save that keeps the content valid should NOT yank the user back to the
 * form they deliberately left; see FileEditor's `canForm` gate, which falls
 * back to raw regardless of settingsView when the draft comes back null.
 */
function syncDraftFromFile() {
  const file = state.settingsFile;
  const hasHints = Object.keys(hintFieldDict(state.settingsFileHints)).length > 0;
  if (!file || !hasHints) {
    state.settingsDraft = null;
    return;
  }
  try {
    state.settingsDraft = JSON.parse(file.content || "{}");
  } catch {
    state.settingsDraft = null;
  }
}

/**
 * Harness-driven hidden-field set for the CURRENT draft, mirroring the
 * pre-purge reference's applyHarnessVisibility: server-computed hint.hidden
 * flags reflect the harness that was saved when hints were built, so once the
 * "harness" field changes in the live draft they'd be stale — this recomputes
 * from `_harness` meta + the draft's live value instead.
 * @param {HarnessHintsMeta|undefined} harnessMeta @param {any} draft @returns {Set<string>}
 */
function harnessHiddenKeys(harnessMeta, draft) {
  if (!harnessMeta) return new Set();
  const harnessValue = getJsonPathValue(draft, ["harness"]);
  if (harnessValue === undefined || harnessValue === null || harnessValue === "") return new Set();
  const config = harnessMeta.configs?.[String(harnessValue)];
  return new Set(config?.hiddenFields ?? []);
}

/** Account select options for the draft's CURRENT harness (falls back to the
 * server-computed hint options when the meta has none).
 * @param {HarnessHintsMeta|undefined} harnessMeta @param {any} draft @param {FieldHintOption[]|undefined} fallback @returns {FieldHintOption[]}
 */
function accountOptionsFor(harnessMeta, draft, fallback) {
  if (!harnessMeta) return fallback ?? [];
  const harnessValue = getJsonPathValue(draft, ["harness"]);
  if (harnessValue === undefined || harnessValue === null || harnessValue === "") return fallback ?? [];
  const config = harnessMeta.configs?.[String(harnessValue)];
  return /** @type {any} */ (config)?.accountOptions ?? fallback ?? [];
}

/** Parent keys of every "[]" (array-item) hint, in first-appearance order —
 * e.g. "jobs.[].id" / "jobs.[].schedule" both yield "jobs". @param {Record<string, FieldHint>} hints @returns {string[]} */
function arrayParentKeysOf(hints) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const order = [];
  for (const key of Object.keys(hints)) {
    const segments = key.split(".");
    const index = segments.indexOf("[]");
    if (index === -1) continue;
    const parent = segments.slice(0, index).join(".");
    if (!seen.has(parent)) {
      seen.add(parent);
      order.push(parent);
    }
  }
  return order;
}

/**
 * The rows a form renders, in order: required hints first, then set optional
 * hints (each group in hints-dict declaration order), then honest json-widget
 * rows for any "[]" hint's parent key that itself holds an array in the draft
 * (rule 6 — no array-item sub-forms, just the raw shape).
 * @param {Record<string, FieldHint>} hints @param {Set<string>} harnessHidden @param {any} draft
 * @returns {{ requiredRows: FieldEntry[], optionalRows: FieldEntry[], arrayRows: FieldEntry[] }}
 */
function computeRows(hints, harnessHidden, draft) {
  /** @type {FieldEntry[]} */
  const requiredRows = [];
  /** @type {FieldEntry[]} */
  const optionalRows = [];
  for (const [key, hint] of Object.entries(hints)) {
    if (key.includes("[]")) continue;
    if (hint.hidden) continue;
    if (harnessHidden.has(key)) continue;
    const path = keyPath(key);
    const entry = { key, hint, path };
    if (!hint.optional) requiredRows.push(entry);
    else if (getJsonPathValue(draft, path) !== undefined) optionalRows.push(entry);
  }
  /** @type {FieldEntry[]} */
  const arrayRows = [];
  for (const parentKey of arrayParentKeysOf(hints)) {
    if (parentKey in hints) continue; // has its own real hint — handled by the loop above already
    if (harnessHidden.has(parentKey)) continue;
    const path = keyPath(parentKey);
    const value = getJsonPathValue(draft, path);
    if (Array.isArray(value)) arrayRows.push({ key: parentKey, hint: { input: "json", label: parentKey }, path });
  }
  return { requiredRows, optionalRows, arrayRows };
}

/** Hinted keys not currently rendered as a row: unset optional keys, minus the
 * same skips rows themselves apply. @param {Record<string, FieldHint>} hints @param {Set<string>} harnessHidden @param {any} draft
 * @returns {{ key: string, hint: FieldHint }[]} */
function addableKeys(hints, harnessHidden, draft) {
  /** @type {{ key: string, hint: FieldHint }[]} */
  const result = [];
  for (const [key, hint] of Object.entries(hints)) {
    if (key.includes("[]")) continue;
    if (hint.hidden) continue;
    if (harnessHidden.has(key)) continue;
    if (!hint.optional) continue; // required rows always render already
    if (getJsonPathValue(draft, keyPath(key)) !== undefined) continue; // already rendered
    result.push({ key, hint });
  }
  return result;
}

/** @param {FieldHint["input"]} input @returns {unknown} */
function emptyValueFor(input) {
  if (input === "boolean") return false;
  if (input === "multiselect") return [];
  if (input === "json") return {};
  return "";
}

// ---------------------------------------------------------------------------
// Widgets, one per FieldHint.input.

/** @param {FieldHintOption} option @returns {HTMLOptionElement} */
function optionElement(option) {
  return /** @type {HTMLOptionElement} */ (h("option", { value: option.value, text: option.label ?? option.value, ...(option.description ? { title: option.description } : {}) }));
}

/** @param {HTMLSelectElement} select @param {FieldHintOption[]} options */
function appendGroupedOptions(select, options) {
  /** @type {Map<string, FieldHintOption[]>} */
  const groups = new Map();
  for (const option of options) {
    if (!option.group) continue;
    const bucket = groups.get(option.group);
    if (bucket) bucket.push(option);
    else groups.set(option.group, [option]);
  }
  for (const option of options) {
    if (!option.group) select.append(optionElement(option));
  }
  for (const [name, opts] of groups) {
    const optgroup = h("optgroup", { label: name });
    for (const option of opts) optgroup.append(optionElement(option));
    select.append(optgroup);
  }
}

/** A stale draft value not among the visible options is never silently
 * dropped — it gets one extra "(current)" option instead. @param {HTMLSelectElement} select @param {FieldHintOption[]} options @param {string} currentValue */
function addCurrentIfMissing(select, options, currentValue) {
  if (currentValue === "" || options.some((option) => option.value === currentValue)) return;
  select.append(h("option", { value: currentValue, text: `${currentValue} (current)` }));
}

/**
 * The model-picker fix: when hint.groupBy points at another field (e.g.
 * "model.name" groupBy "model.provider"), read that field's RAW draft value,
 * resolve it to a LABEL via the groupBy field's own hint options (option.group
 * on the dependent field's options holds the label, not the id — commit
 * 022bf32), and show only options in that group, flat (a single group needs no
 * optgroup). Unset/unresolved groupBy falls back to every option, grouped by
 * <optgroup> — same as a plain grouped select with no groupBy at all.
 * @param {FieldHint} hint @param {Record<string, FieldHint>} hints @param {any} draft
 * @returns {{ options: FieldHintOption[], useGroups: boolean }}
 */
function resolveSelectOptions(hint, hints, draft) {
  const all = hint.options ?? [];
  if (hint.groupBy) {
    const rawValue = getJsonPathValue(draft, keyPath(hint.groupBy));
    if (rawValue !== undefined && rawValue !== null && rawValue !== "") {
      const sourceOption = hints[hint.groupBy]?.options?.find((option) => option.value === String(rawValue));
      const label = sourceOption?.label ?? sourceOption?.value ?? String(rawValue);
      return { options: all.filter((option) => option.group === label), useGroups: false };
    }
    return { options: all, useGroups: true };
  }
  return { options: all, useGroups: all.some((option) => option.group) };
}

/** @param {FieldEntry} entry @param {FormCtx} ctx @returns {HTMLSelectElement} */
function SelectWidget(entry, ctx) {
  const currentRaw = getJsonPathValue(ctx.draft, entry.path);
  const currentValue = currentRaw === undefined || currentRaw === null ? "" : String(currentRaw);
  const { options, useGroups } = resolveSelectOptions(entry.hint, ctx.hints, ctx.draft);
  const select = /** @type {HTMLSelectElement} */ (
    h("select", {
      onchange: () => {
        if (select.value === "" && entry.hint.optional) deleteJsonPathValue(ctx.draft, entry.path);
        else setJsonPathValue(ctx.draft, entry.path, select.value);
        ctx.rerender();
      },
    })
  );
  if (entry.hint.optional) select.append(h("option", { value: "", text: "—" }));
  if (useGroups) appendGroupedOptions(select, options);
  else for (const option of options) select.append(optionElement(option));
  addCurrentIfMissing(select, options, currentValue);
  select.value = currentValue;
  return select;
}

/** @param {FieldEntry} entry @param {FormCtx} ctx @returns {HTMLDivElement} */
function MultiselectWidget(entry, ctx) {
  const rawValue = getJsonPathValue(ctx.draft, entry.path);
  const values = Array.isArray(rawValue) ? rawValue.map(String) : [];
  const container = /** @type {HTMLDivElement} */ (h("div", { class: "settings2-multiselect" }));
  for (const option of entry.hint.options ?? []) {
    const box = /** @type {HTMLInputElement} */ (
      h("input", {
        type: "checkbox",
        checked: values.includes(option.value),
        onchange: () => {
          const current = Array.isArray(getJsonPathValue(ctx.draft, entry.path)) ? [...getJsonPathValue(ctx.draft, entry.path)] : [];
          const at = current.indexOf(option.value);
          if (box.checked && at === -1) current.push(option.value);
          else if (!box.checked && at !== -1) current.splice(at, 1);
          setJsonPathValue(ctx.draft, entry.path, current);
          ctx.rerender();
        },
      })
    );
    const name = option.label ?? option.value;
    const title = option.description ? `${name} — ${option.description}` : name;
    container.append(h("label", { class: "settings2-multi-option", title }, box, h("span", { text: name })));
  }
  return container;
}

/** @param {FieldEntry} entry @param {FormCtx} ctx @returns {HTMLInputElement} */
function NumberWidget(entry, ctx) {
  const value = getJsonPathValue(ctx.draft, entry.path);
  const input = /** @type {HTMLInputElement} */ (
    h("input", {
      type: "number",
      value: value === undefined || value === null ? "" : String(value),
      oninput: () => {
        const text = input.value.trim();
        if (text !== "" && !Number.isNaN(Number(text))) setJsonPathValue(ctx.draft, entry.path, Number(text));
        ctx.markDirtyBadge();
      },
      onblur: () => {
        // Empty + optional: unset the key (rule 4) — a discrete boundary
        // event, so re-rendering (which may drop this very row) is fine here,
        // unlike oninput above which must never fight the caret mid-type.
        if (input.value.trim() === "" && entry.hint.optional) {
          deleteJsonPathValue(ctx.draft, entry.path);
          ctx.rerender();
        }
      },
    })
  );
  return input;
}

/** @param {FieldEntry} entry @param {FormCtx} ctx @returns {HTMLInputElement} */
function TextWidget(entry, ctx) {
  const value = getJsonPathValue(ctx.draft, entry.path);
  const input = /** @type {HTMLInputElement} */ (
    h("input", {
      type: "text",
      value: value === undefined || value === null ? "" : String(value),
      oninput: () => {
        setJsonPathValue(ctx.draft, entry.path, input.value);
        ctx.markDirtyBadge();
      },
    })
  );
  return input;
}

/** @param {FieldEntry} entry @param {FormCtx} ctx @returns {HTMLTextAreaElement} */
function JsonWidget(entry, ctx) {
  const value = getJsonPathValue(ctx.draft, entry.path);
  const textarea = /** @type {HTMLTextAreaElement} */ (
    h("textarea", {
      class: "settings2-json-field",
      rows: "4",
      value: value === undefined ? "" : JSON.stringify(value, null, 2),
      oninput: () => {
        try {
          setJsonPathValue(ctx.draft, entry.path, JSON.parse(textarea.value));
          textarea.classList.remove("settings2-invalid");
        } catch {
          // Invalid JSON keeps whatever the draft already holds — never crash,
          // never corrupt; the red border is the only feedback needed.
          textarea.classList.add("settings2-invalid");
        }
        ctx.markDirtyBadge();
      },
    })
  );
  return textarea;
}

/** @param {FieldEntry} entry @param {FormCtx} ctx @returns {HTMLLabelElement} */
function BooleanWidget(entry, ctx) {
  const checked = getJsonPathValue(ctx.draft, entry.path) === true;
  const input = /** @type {HTMLInputElement} */ (
    h("input", {
      type: "checkbox",
      checked,
      onchange: () => {
        setJsonPathValue(ctx.draft, entry.path, input.checked);
        ctx.rerender();
      },
    })
  );
  return /** @type {HTMLLabelElement} */ (h("label", { class: "settings2-bool" }, input, h("span", { text: input.checked ? "on" : "off" })));
}

/** @param {FieldEntry} entry @param {FormCtx} ctx @returns {HTMLElement} */
function renderWidget(entry, ctx) {
  if (entry.hint.input === "boolean") return BooleanWidget(entry, ctx);
  if (entry.hint.input === "select") return SelectWidget(entry, ctx);
  if (entry.hint.input === "multiselect") return MultiselectWidget(entry, ctx);
  if (entry.hint.input === "number") return NumberWidget(entry, ctx);
  if (entry.hint.input === "json") return JsonWidget(entry, ctx);
  return TextWidget(entry, ctx);
}

// ---------------------------------------------------------------------------
// Form assembly: one row per entry + the add-setting picker.

/** @param {FieldEntry} entry @param {FormCtx} ctx @returns {HTMLElement} */
function FieldRow(entry, ctx) {
  const widget = renderWidget(entry, ctx);
  const removeButton = entry.hint.optional
    ? h("button", {
        class: "settings2-row-remove",
        title: "remove this setting",
        onclick: () => {
          deleteJsonPathValue(ctx.draft, entry.path);
          ctx.rerender();
        },
        text: "✕",
      })
    : null;
  return h(
    "div",
    { class: "settings2-field-row" },
    h("div", { class: "settings2-field-label" }, h("span", { text: entry.hint.label ?? entry.key })),
    h(
      "div",
      { class: "settings2-field-widget" },
      h("div", { class: "settings2-field-control" }, widget, removeButton),
      entry.hint.description ? h("small", { class: "settings2-field-desc", text: entry.hint.description }) : null,
    ),
  );
}

/** @param {Record<string, FieldHint>} hints @param {Set<string>} harnessHidden @param {any} draft @param {FormCtx} ctx @returns {HTMLElement|null} */
function AddSettingPicker(hints, harnessHidden, draft, ctx) {
  const candidates = addableKeys(hints, harnessHidden, draft);
  if (candidates.length === 0) return null;
  const select = /** @type {HTMLSelectElement} */ (
    h("select", {
      class: "settings2-add-picker",
      onchange: () => {
        const chosen = candidates.find((candidate) => candidate.key === select.value);
        if (chosen) setJsonPathValue(draft, keyPath(chosen.key), emptyValueFor(chosen.hint.input));
        select.value = "";
        if (chosen) ctx.rerender();
      },
    })
  );
  select.append(h("option", { value: "", text: "+ add setting" }));
  for (const { key, hint } of candidates) {
    const label = hint.label ?? key;
    const desc = hint.description ? ` — ${hint.description.slice(0, 60)}` : "";
    select.append(h("option", { value: key, text: `${label}${desc}` }));
  }
  return h("div", { class: "settings2-field-row settings2-add-row" }, select);
}

/** @param {FormCtx} ctx @returns {HTMLElement} */
function FormBody(ctx) {
  const harnessHidden = harnessHiddenKeys(ctx.harnessMeta, ctx.draft);
  const { requiredRows, optionalRows, arrayRows } = computeRows(ctx.hints, harnessHidden, ctx.draft);
  const rows = [...requiredRows, ...optionalRows, ...arrayRows].map((entry) =>
    entry.key === "account"
      ? { ...entry, hint: { ...entry.hint, options: accountOptionsFor(ctx.harnessMeta, ctx.draft, entry.hint.options) } }
      : entry,
  );
  return h(
    "div",
    { class: "settings2-form" },
    rows.length === 0 ? h("div", { class: "empty", text: "no settings to show" }) : rows.map((entry) => FieldRow(entry, ctx)),
    AddSettingPicker(ctx.hints, harnessHidden, ctx.draft, ctx),
  );
}

// ---------------------------------------------------------------------------
// The editor: hints-driven form (default, when possible) with a raw textarea
// as the always-available escape hatch.

/**
 * File editor for state.settingsFile. Structural form edits — select/boolean/
 * multiselect changes, ✕ remove, + add setting, the form/raw toggle itself —
 * call the real markDirty("settings"): a full region re-render is fine there
 * because they're discrete clicks, never mid-keystroke. Free-typed widgets
 * (text/number/json) and the raw textarea instead mutate state directly and
 * flip their own "unsaved" badge via a direct DOM toggle, exactly like the
 * pre-form raw editor did — re-rendering on every keystroke would fight the
 * caret. See MEMORY: this mirrors the reference's uncontrolled-textarea
 * rationale, just extended to the form's text-ish widgets.
 */
function FileEditor() {
  const file = state.settingsFile;
  if (!file) return h("div", { class: "empty", text: "select a file" });

  const hints = hintFieldDict(state.settingsFileHints);
  const hasHints = Object.keys(hints).length > 0;
  const draft = state.settingsDraft;
  const canForm = hasHints && draft !== null;
  const view = canForm && state.settingsView === "form" ? "form" : "raw";

  const dirtyBadge = h("small", { class: "settings2-dirty", hidden: true, text: "unsaved" });
  const rawSeed = canForm ? serializeDraft(draft) : file.content;
  const textarea = /** @type {HTMLTextAreaElement} */ (
    h("textarea", {
      class: "settings2-raw",
      value: rawSeed,
      oninput: () => {
        dirtyBadge.hidden = textarea.value === rawSeed;
      },
    })
  );

  const saveButton = h("button", {
    text: "save",
    onclick: () => {
      saveButton.setAttribute("disabled", "");
      saveButton.textContent = "saving…";
      const content = view === "form" ? serializeDraft(draft) : textarea.value;
      void saveSettingsFile(content).then(() => syncDraftFromFile());
    },
  });

  const toggle = canForm
    ? h(
        "div",
        { class: "segmented-tabs settings2-view-toggle" },
        h(
          "button",
          {
            class: view === "form" ? "active" : "",
            onclick: () => {
              state.settingsView = "form";
              markDirty("settings");
            },
          },
          h("span", { text: "form" }),
        ),
        h(
          "button",
          {
            class: view === "raw" ? "active" : "",
            onclick: () => {
              state.settingsView = "raw";
              markDirty("settings");
            },
          },
          h("span", { text: "raw" }),
        ),
      )
    : null;

  /** @type {FormCtx} */
  const ctx = {
    draft,
    hints,
    harnessMeta: harnessMetaOf(state.settingsFileHints),
    rerender: () => markDirty("settings"),
    markDirtyBadge: () => {
      dirtyBadge.hidden = canForm && serializeDraft(draft) === file.content;
    },
  };

  const body = view === "form" && canForm ? FormBody(ctx) : textarea;

  return h(
    "div",
    { class: "settings2-editor" },
    h("div", { class: "file-toolbar" }, h("code", {}, PathText(file.path)), h("div", { class: "settings2-toolbar-actions" }, toggle, dirtyBadge, saveButton)),
    hasHints && !canForm ? h("div", { class: "settings2-notice", text: "not valid JSON — raw only" }) : null,
    body,
    state.settingsError ? h("div", { class: "settings2-error-line", text: state.settingsError }) : null,
  );
}
