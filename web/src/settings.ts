import { api } from "./api.ts";
import { h } from "./dom.ts";
import { PathText } from "./links.ts";
import { render } from "./render.ts";
import { state } from "./state.ts";

function globalAgentInfo(file) {
  const match = file?.label?.match(/^agents\/([^/]+)\/(.+)$/);
  if (!match) return null;
  return { agentId: match[1], relativePath: match[2] };
}

function globalAgentView(file) {
  const info = globalAgentInfo(file);
  if (!info) return "general";
  if (info.relativePath === "agent.json") return "config";
  if (info.relativePath.endsWith("MEMORY.md")) return "memory";
  return "persona";
}

function globalSettingsSections(files = state.globalFiles) {
  const generalFiles = files.filter((file) => !globalAgentInfo(file));
  const agentIds = [...new Set(files.map((file) => globalAgentInfo(file)?.agentId).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  return [
    { id: "general", label: "General", count: generalFiles.length },
    { id: "agents", label: "Agents", count: agentIds.length },
  ];
}

function globalAgentGroups(files = state.globalFiles) {
  const groups = new Map();
  for (const file of files) {
    const info = globalAgentInfo(file);
    if (!info) continue;
    if (!groups.has(info.agentId)) groups.set(info.agentId, { id: info.agentId, config: [], persona: [], memory: [], files: [] });
    const group = groups.get(info.agentId);
    group.files.push(file);
    group[globalAgentView(file)].push(file);
  }
  return [...groups.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function globalAgentFileLabel(file) {
  const info = globalAgentInfo(file);
  if (!info) return file.label;
  if (info.relativePath === "agent.json") return "agent.json";
  if (info.relativePath.endsWith("SOUL.md")) return "SOUL.md";
  if (info.relativePath.endsWith("MEMORY.md")) return "MEMORY.md";
  const rolePath = info.relativePath.match(/(?:^|\/)roles\/(.+)$/);
  if (rolePath) return `roles/${rolePath[1]}`;
  return info.relativePath;
}

function selectedGlobalAgentGroup() {
  const groups = globalAgentGroups();
  return groups.find((group) => group.id === state.selectedGlobalAgentId) ?? groups[0] ?? null;
}

function firstAgentViewWithFiles(group, preferred = state.selectedGlobalAgentView) {
  if (!group) return null;
  const order = [preferred, "config", "persona", "memory"].filter((value, index, values) => values.indexOf(value) === index);
  return order.find((view) => group[view]?.length > 0) ?? null;
}

function currentGlobalFiles() {
  if (state.selectedGlobalSection === "general") return state.globalFiles.filter((file) => !globalAgentInfo(file));
  const group = selectedGlobalAgentGroup();
  if (!group) return [];
  const files = group[state.selectedGlobalAgentView] ?? [];
  return files.length > 0 ? files : group.files;
}

export function syncGlobalSettingsSelection() {
  const selected = state.globalFiles.find((file) => file.id === state.selectedGlobalFileId);
  if (selected) {
    const info = globalAgentInfo(selected);
    if (!info) {
      state.selectedGlobalSection = "general";
      return;
    }
    state.selectedGlobalSection = "agents";
    state.selectedGlobalAgentId = info.agentId;
    state.selectedGlobalAgentView = globalAgentView(selected);
    return;
  }

  const generalFiles = state.globalFiles.filter((file) => !globalAgentInfo(file));
  const group = selectedGlobalAgentGroup();

  if (state.selectedGlobalSection === "general" && generalFiles.length > 0) {
    state.selectedGlobalFileId = generalFiles[0].id;
    return;
  }

  if (group) {
    state.selectedGlobalSection = "agents";
    state.selectedGlobalAgentId = group.id;
    state.selectedGlobalAgentView = firstAgentViewWithFiles(group) ?? "config";
    const files = currentGlobalFiles();
    state.selectedGlobalFileId = files[0]?.id ?? group.files[0]?.id ?? null;
    return;
  }

  state.selectedGlobalSection = "general";
  state.selectedGlobalFileId = generalFiles[0]?.id ?? null;
}

async function selectGlobalSection(sectionId) {
  state.selectedGlobalSection = sectionId;
  if (sectionId === "general") {
    const files = currentGlobalFiles();
    if (!files.some((file) => file.id === state.selectedGlobalFileId)) state.selectedGlobalFileId = files[0]?.id ?? null;
  } else {
    const group = selectedGlobalAgentGroup();
    if (group) {
      state.selectedGlobalAgentId = group.id;
      state.selectedGlobalAgentView = firstAgentViewWithFiles(group) ?? "config";
      const files = currentGlobalFiles();
      if (!files.some((file) => file.id === state.selectedGlobalFileId)) state.selectedGlobalFileId = files[0]?.id ?? null;
    } else state.selectedGlobalFileId = null;
  }
  await loadSelectedGlobalFile();
  render();
}

async function selectGlobalAgent(agentId) {
  state.selectedGlobalSection = "agents";
  state.selectedGlobalAgentId = agentId;
  const group = selectedGlobalAgentGroup();
  state.selectedGlobalAgentView = firstAgentViewWithFiles(group) ?? "config";
  const files = currentGlobalFiles();
  state.selectedGlobalFileId = files[0]?.id ?? null;
  await loadSelectedGlobalFile();
  render();
}

// Entry point for clickable agent rows: opens the global settings modal with
// that agent's files selected.
export async function openAgentSettings(agentId) {
  state.settingsOpen = true;
  await selectGlobalAgent(agentId);
}

async function selectGlobalAgentView(view) {
  state.selectedGlobalSection = "agents";
  state.selectedGlobalAgentView = view;
  const files = currentGlobalFiles();
  state.selectedGlobalFileId = files[0]?.id ?? null;
  await loadSelectedGlobalFile();
  render();
}

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

async function saveFile(file, content) {
  if (!file) return;
  const params = file.scope === "workspace" && state.snapshot ? `?${new URLSearchParams({ workspaceId: state.snapshot.workspace.id })}` : "";
  const body = await api(`/api/files/${encodeURIComponent(file.id)}${params}`, {
    method: "PUT",
    body: JSON.stringify({ content }),
  });
  if (file.scope === "workspace") state.workspaceFile = body.file;
  else state.globalFile = body.file;
  render();
}

export function WorkspacePanel() {
  return h(
    "section",
    { class: "panel workspace-panel" },
    h("div", { class: "panel-head" }, h("h2", { text: "Workspace" }), h("small", {}, state.snapshot?.workspace.rootDir ? PathText(state.snapshot.workspace.rootDir) : "none")),
    FileSelector(state.workspaceFiles, state.selectedWorkspaceFileId, async (id) => {
      state.selectedWorkspaceFileId = id;
      await loadSelectedWorkspaceFile();
      render();
    }),
    FileSettingsEditor({
      file: state.workspaceFile,
      raw: state.workspaceRaw,
      setRaw: (value) => {
        state.workspaceRaw = value;
        render();
      },
    }),
  );
}

export function SettingsModal() {
  const sections = globalSettingsSections();
  const agents = globalAgentGroups();
  const selectedAgent = selectedGlobalAgentGroup();
  const agentViews = [
    { id: "config", label: "Config", files: selectedAgent?.config ?? [] },
    { id: "persona", label: "Persona", files: selectedAgent?.persona ?? [] },
    { id: "memory", label: "Memory", files: selectedAgent?.memory ?? [] },
  ];

  return h(
    "div",
    { class: "modal-backdrop" },
    h(
      "section",
      { class: "modal" },
      h("div", { class: "panel-head" }, h("h2", { text: "Global Settings" }), h("button", { onclick: () => ((state.settingsOpen = false), render()), text: "x" })),
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
      state.selectedGlobalSection === "general"
        ? [
            FileSelector(state.globalFiles.filter((file) => !globalAgentInfo(file)), state.selectedGlobalFileId, async (id) => {
              state.selectedGlobalFileId = id;
              syncGlobalSettingsSelection();
              await loadSelectedGlobalFile();
              render();
            }),
            FileSettingsEditor({
              file: state.globalFile,
              raw: state.globalRaw,
              setRaw: (value) => {
                state.globalRaw = value;
                render();
              },
            }),
          ]
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
                            class: `${view.id === state.selectedGlobalAgentView ? "active" : ""} ${view.files.length === 0 ? "muted" : ""}`.trim(),
                            onclick: () => void selectGlobalAgentView(view.id),
                            disabled: view.files.length === 0,
                          },
                          h("span", { text: view.label }),
                          h("small", { text: String(view.files.length) }),
                        ),
                      ),
                    ),
                    FileSelector(currentGlobalFiles(), state.selectedGlobalFileId, async (id) => {
                      state.selectedGlobalFileId = id;
                      syncGlobalSettingsSelection();
                      await loadSelectedGlobalFile();
                      render();
                    }, { labeler: globalAgentFileLabel }),
                    FileSettingsEditor({
                      file: state.globalFile,
                      raw: state.globalRaw,
                      setRaw: (value) => {
                        state.globalRaw = value;
                        render();
                      },
                    }),
                  ]
                : h("div", { class: "empty", text: "no agent selected" }),
            ),
          ),
    ),
  );
}

function FileSelector(files, selectedId, onSelect, options = {}) {
  const labeler = options.labeler ?? ((file) => file.label);
  const emptyText = options.emptyText ?? "no editable files";
  return h(
    "div",
    { class: "file-tabs" },
    files.length === 0
      ? h("span", { class: "empty", text: emptyText })
      : files.map((file) =>
          h("button", { class: file.id === selectedId ? "active" : "", onclick: () => onSelect(file.id) }, h("span", { text: labeler(file) }), h("small", {}, PathText(file.path))),
        ),
  );
}

function FileSettingsEditor({ file, raw, setRaw }) {
  if (!file) return h("div", { class: "empty", text: "select a file" });
  const editor = h("div", { class: "settings-editor" });
  const rawText = h("textarea", { class: "raw-editor", value: file.content });
  const view = file.kind === "json" ? JsonSettingsView(file.content, file.hints) : MarkdownSettingsView(file.content);
  editor.append(
    h(
      "div",
      { class: "file-toolbar" },
      h("code", {}, PathText(file.path)),
      h("button", { onclick: () => setRaw(!raw), text: raw ? "view" : "raw" }),
      h("button", { onclick: () => saveFile(file, raw ? rawText.value : serializeSettings(view, file.kind)), text: "save" }),
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

function pathKey(path) {
  return path.map((segment) => (typeof segment === "number" ? "[]" : segment)).join(".");
}

function getJsonPathValue(root, path) {
  let current = root;
  for (const segment of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = current[segment];
  }
  return current;
}

function optionText(option) {
  const label = option.label ?? option.value;
  return option.description ? `${label} — ${option.description}` : label;
}

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

function HintedSelect(entryPath, key, hint, currentValue, parsedRoot) {
  const select = h("select", {
    "data-json-path": JSON.stringify(entryPath),
    "data-path-key": pathKey(entryPath),
    ...(hint.optional ? { "data-json-optional": "1" } : {}),
    ...(hint.groupBy ? { "data-group-by": hint.groupBy } : {}),
  });
  const groupValue = hint.groupBy ? getJsonPathValue(parsedRoot, hint.groupBy.split(".")) : undefined;
  buildSelectOptions(select, hint, currentValue === undefined || currentValue === null ? "" : String(currentValue), groupValue);
  select.__hint = hint;
  return h("label", { class: "setting-row" }, h("span", { text: key }), select);
}

function HintedMultiselect(entryPath, key, hint, currentValues) {
  const values = Array.isArray(currentValues) ? currentValues.map(String) : [];
  const known = (hint.options ?? []).map((option) => option.value);
  const extras = values.filter((value) => !known.includes(value));
  const container = h(
    "div",
    { class: "multi-options", "data-json-path": JSON.stringify(entryPath), "data-json-multi": "1" },
    [...(hint.options ?? []), ...extras.map((value) => ({ value }))].map((option) =>
      h(
        "label",
        { class: "multi-option", title: option.description ?? "" },
        h("input", { type: "checkbox", "data-value": option.value, ...(values.includes(option.value) ? { checked: true } : {}) }),
        h("span", { text: option.label ?? option.value }),
      ),
    ),
  );
  return h("div", { class: "setting-row stacked" }, h("span", { text: key }), container);
}

function HintedNumber(entryPath, key, currentValue) {
  return h(
    "label",
    { class: "setting-row" },
    h("span", { text: key }),
    h("input", {
      type: "number",
      "data-json-path": JSON.stringify(entryPath),
      "data-json-number": "1",
      value: currentValue === undefined || currentValue === null ? "" : String(currentValue),
    }),
  );
}

function hintedField(entryPath, key, hint, currentValue, parsedRoot) {
  if (hint.input === "select") return HintedSelect(entryPath, key, hint, currentValue, parsedRoot);
  if (hint.input === "multiselect") return HintedMultiselect(entryPath, key, hint, currentValue);
  if (hint.input === "number") return HintedNumber(entryPath, key, currentValue);
  return null;
}

function jsonFieldText(value) {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (value === undefined) return "";
  return JSON.stringify(value);
}

function parseJsonFieldValue(value) {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function isStructuredJsonValue(value) {
  return value !== null && typeof value === "object";
}

function renderJsonFields(container, value, path, ctx) {
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

// Hinted fields that are absent from the file still show up as editable rows
// (e.g. "model.provider" on an agent.json without a model block). Saving with
// a value creates the key; "(not set)" keeps it out of the file.
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

function wireDependentSelects(root) {
  for (const dependent of root.querySelectorAll("select[data-group-by]")) {
    const source = root.querySelector(`[data-path-key="${dependent.dataset.groupBy}"]`);
    if (!source) continue;
    source.addEventListener("change", () => {
      buildSelectOptions(dependent, dependent.__hint, dependent.value, source.value);
    });
  }
}

function JsonSettingsView(content, hints) {
  let parsed = {};
  try {
    parsed = JSON.parse(content || "{}");
  } catch {
    return h("textarea", { class: "raw-editor", value: content });
  }

  const root = h("div", { class: "settings-view", "data-kind": "json", "data-json-source": JSON.stringify(parsed) });
  const ctx = { hints: hints ?? {}, parsedRoot: parsed, renderedKeys: new Set() };
  renderJsonFields(root, parsed, [], ctx);
  appendMissingHintedFields(root, parsed, ctx);
  wireDependentSelects(root);
  return root;
}

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

function deleteJsonPathValue(root, path) {
  let current = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    current = current?.[path[index]];
    if (current === null || typeof current !== "object") return;
  }
  if (current && typeof current === "object") delete current[path[path.length - 1]];
}

function MarkdownSettingsView(content) {
  const root = h("div", { class: "settings-view", "data-kind": "markdown" });
  const lines = content.split("\n");
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

function serializeSettings(view, kind) {
  if (kind === "json") {
    let next = {};
    try {
      next = JSON.parse(view.dataset.jsonSource || "{}");
    } catch {
      next = {};
    }
    for (const element of view.querySelectorAll("[data-json-path]")) {
      const path = JSON.parse(element.dataset.jsonPath || "[]");
      if (element.dataset.jsonMulti !== undefined) {
        const checked = [...element.querySelectorAll("input[type=checkbox]")].filter((box) => box.checked).map((box) => box.dataset.value);
        setJsonPathValue(next, path, checked);
        continue;
      }
      if (element.tagName === "SELECT") {
        if (element.value === "" && element.dataset.jsonOptional !== undefined) deleteJsonPathValue(next, path);
        else setJsonPathValue(next, path, element.value);
        continue;
      }
      if (element.dataset.jsonNumber !== undefined) {
        if (element.value.trim() === "") deleteJsonPathValue(next, path);
        else setJsonPathValue(next, path, Number(element.value));
        continue;
      }
      setJsonPathValue(next, path, parseJsonFieldValue(element.value));
    }
    return `${JSON.stringify(next, null, 2)}\n`;
  }

  const lines = [];
  for (const node of view.children) {
    if (node.dataset.md === "heading") lines.push(`${"#".repeat(Number(node.dataset.level ?? 1))} ${node.textContent}`);
    else if (node.dataset.md === "text") lines.push(node.value);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}
