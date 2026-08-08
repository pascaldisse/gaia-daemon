// Chat search overlay (Cmd/Ctrl+K). A command-palette-style modal over the
// whole history: type a query, get transcript matches across every room —
// filtered by workspace, or narrowed to the open chat — and jump straight to
// the matched message. Backed by GET /api/search (the workspace FTS index).
//
// The overlay is MOUNTED ONCE per open and then patched in place: the text
// input is never rebuilt, so typing never loses focus or caret. Data changes
// (fetch results, keyboard navigation, filter toggles) mutate the results and
// chrome directly rather than re-rendering the whole region.
import { loadWorkspace, selectRoom } from "./actions.js";
import { api } from "./api.js";
import { $, h } from "./dom.js";
import { markDirty, registerRegion } from "./render.js";
import { state } from "./state.js";
import { jumpToEvent } from "./transcript.js";

/** @typedef {import("./types.js").ChatSearchHit} ChatSearchHit */

// The FTS snippet wraps matched terms in these private-use sentinels (server
// side, workspace-index.ts). We escape the text, then swap them for <mark> —
// so the only HTML that ever reaches innerHTML is our own highlight tags.
const MARK_OPEN = String.fromCharCode(0xe000);
const MARK_CLOSE = String.fromCharCode(0xe001);

/** @type {number} */
let debounce = 0;

/**
 * Open the search overlay. `scope` "room" narrows to the open chat (falls back
 * to chat-wide when no room is open); "chatwide" searches every room.
 * @param {"chatwide"|"room"} [scope]
 */
export function openSearch(scope = "chatwide") {
  state.search.open = true;
  state.search.scope = scope === "room" && state.snapshot ? "room" : "chatwide";
  state.search.active = 0;
  markDirty("search");
  focusInput();
  if (state.search.query.trim()) scheduleSearch(0);
}

export function closeSearch() {
  if (!state.search.open) return;
  state.search.open = false;
  window.clearTimeout(debounce);
  markDirty("search");
}

function focusInput() {
  requestAnimationFrame(() => {
    const el = $(".search-input");
    if (el instanceof HTMLInputElement) {
      el.focus();
      el.select();
    }
  });
}

// --- region renderer: mount once, then patch ---------------------------------

function renderSearch() {
  const slot = $("#overlay-search");
  if (!slot) return;
  if (!state.search.open) {
    slot.replaceChildren();
    return;
  }
  if (!slot.firstChild) {
    slot.replaceChildren(SearchOverlay());
    focusInput();
  }
  refreshChrome();
  patchResults();
}

registerRegion("search", renderSearch);

/** Keep the scope buttons and workspace filter in sync with state without
 * touching the input (which must keep focus). */
function refreshChrome() {
  const slot = $("#overlay-search");
  if (!slot) return;
  for (const button of slot.querySelectorAll(".search-scope button")) {
    button.classList.toggle("active", button.getAttribute("data-scope") === state.search.scope);
  }
  const ws = $(".search-ws", slot);
  if (ws instanceof HTMLSelectElement) {
    ws.hidden = state.search.scope === "room";
    ws.value = state.search.workspace;
  }
}

// --- structure (built once) --------------------------------------------------

function SearchOverlay() {
  return h(
    "div",
    {
      class: "search-backdrop",
      onclick: (event) => {
        if (event.target === event.currentTarget) closeSearch();
      },
    },
    h(
      "div",
      { class: "search-panel" },
      h(
        "div",
        { class: "search-head" },
        h("input", {
          class: "search-input",
          type: "text",
          placeholder: "search your chats…",
          value: state.search.query,
          oninput: onInput,
          onkeydown: onInputKeyDown,
        }),
        h("button", { class: "search-close", type: "button", title: "close (Esc)", onclick: () => closeSearch(), text: "✕" }),
      ),
      h("div", { class: "search-filters" }, ScopeToggle(), WorkspaceSelect()),
      h("div", { class: "search-status", id: "search-status" }),
      h("div", { class: "search-results", id: "search-results" }),
    ),
  );
}

function ScopeToggle() {
  /** @param {"chatwide"|"room"} scope @param {string} label @param {boolean} disabled */
  const button = (scope, label, disabled) =>
    h("button", {
      type: "button",
      "data-scope": scope,
      class: state.search.scope === scope ? "active" : "",
      ...(disabled ? { disabled: true } : {}),
      onclick: () => setScope(scope),
      text: label,
    });
  return h("div", { class: "search-scope" }, button("chatwide", "all chats", false), button("room", "this chat", !state.snapshot));
}

function WorkspaceSelect() {
  const options = [h("option", { value: "all", selected: state.search.workspace === "all" }, "all workspaces")];
  for (const workspace of state.workspaces) {
    if (!workspace.isInitialized) continue;
    options.push(h("option", { value: workspace.id, selected: state.search.workspace === workspace.id }, workspace.name));
  }
  return h(
    "select",
    {
      class: "search-ws",
      hidden: state.search.scope === "room",
      onchange: (event) => {
        state.search.workspace = /** @type {HTMLSelectElement} */ (event.target).value;
        scheduleSearch(0);
      },
    },
    options,
  );
}

// --- dynamic parts (patched on data change) ----------------------------------

function patchResults() {
  const results = $("#search-results");
  const status = $("#search-status");
  if (!results || !status) return;
  const s = state.search;
  if (s.loading) status.textContent = "searching…";
  else if (!s.query.trim()) status.textContent = "type to search — matches across every chat";
  else {
    let text = `${s.hits.length} result${s.hits.length === 1 ? "" : "s"}`;
    if (s.degraded.length) text += ` · ${s.degraded.join("; ")}`;
    status.textContent = text;
  }
  const rows = s.hits.map((hit, index) => ResultRow(hit, index));
  if (!rows.length && s.query.trim() && !s.loading) rows.push(h("div", { class: "search-empty", text: "no matches" }));
  results.replaceChildren(...rows);
}

/** @param {ChatSearchHit} hit @param {number} index */
function ResultRow(hit, index) {
  const snippet = h("div", { class: "sr-snippet" });
  snippet.innerHTML = snippetHtml(hit.snippet);
  return h(
    "button",
    {
      type: "button",
      class: `search-result ${index === state.search.active ? "active" : ""}`,
      "data-index": String(index),
      onclick: () => void openHit(hit),
    },
    h(
      "div",
      { class: "sr-head" },
      h("span", { class: "sr-room", text: hit.roomTitle || hit.roomId }),
      state.search.scope === "chatwide" ? h("span", { class: "sr-ws", text: hit.workspaceName }) : null,
      h("time", { class: "sr-time", text: (hit.ts || "").slice(0, 10) }),
    ),
    snippet,
    hit.speakers?.length ? h("div", { class: "sr-speakers", text: hit.speakers.map((speaker) => `@${speaker}`).join(" ") }) : null,
  );
}

/** Escape the FTS excerpt, then turn the match sentinels into <mark> tags. The
 * only HTML that reaches innerHTML is our own <mark> — content is escaped.
 * @param {string} snippet */
function snippetHtml(snippet) {
  const escaped = String(snippet ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.split(MARK_OPEN).join("<mark>").split(MARK_CLOSE).join("</mark>");
}

// --- behaviour ----------------------------------------------------------------

/** @param {Event} event */
function onInput(event) {
  state.search.query = /** @type {HTMLInputElement} */ (event.target).value;
  scheduleSearch();
}

/** @param {KeyboardEvent} event */
function onInputKeyDown(event) {
  if (event.key === "ArrowDown") {
    event.preventDefault();
    move(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    move(-1);
  } else if (event.key === "Enter") {
    event.preventDefault();
    const hit = state.search.hits[state.search.active];
    if (hit) void openHit(hit);
  }
  // Escape is handled globally (keys.js) so it closes the overlay from anywhere.
}

/** @param {number} delta */
function move(delta) {
  const count = state.search.hits.length;
  if (!count) return;
  state.search.active = (state.search.active + delta + count) % count;
  patchResults();
  $(`#search-results [data-index="${state.search.active}"]`)?.scrollIntoView({ block: "nearest" });
}

/** @param {"chatwide"|"room"} scope */
function setScope(scope) {
  if (scope === "room" && !state.snapshot) return;
  state.search.scope = scope;
  refreshChrome();
  scheduleSearch(0);
}

/** @param {number} [delay] */
function scheduleSearch(delay = 220) {
  window.clearTimeout(debounce);
  debounce = window.setTimeout(() => void runSearch(), delay);
}

async function runSearch() {
  const query = state.search.query.trim();
  const seq = ++state.search.seq;
  if (!query) {
    state.search.hits = [];
    state.search.degraded = [];
    state.search.loading = false;
    patchResults();
    return;
  }
  state.search.loading = true;
  patchResults();
  const params = new URLSearchParams({ q: query });
  if (state.search.scope === "room" && state.snapshot) params.set("room", state.snapshot.room.id);
  else if (state.search.workspace !== "all") params.set("workspace", state.search.workspace);
  try {
    const body = await api(`/api/search?${params.toString()}`);
    if (seq !== state.search.seq) return; // a newer query already superseded this
    state.search.hits = body.hits ?? [];
    state.search.degraded = body.degraded ?? [];
    state.search.active = 0;
  } catch (error) {
    if (seq !== state.search.seq) return;
    state.search.hits = [];
    state.search.degraded = [error instanceof Error ? error.message : String(error)];
  } finally {
    if (seq === state.search.seq) {
      state.search.loading = false;
      patchResults();
    }
  }
}

/** Navigate to a result: open its workspace/room if needed, then flash the
 * matched message. Closing first so the overlay never covers the landing.
 * @param {ChatSearchHit} hit */
async function openHit(hit) {
  closeSearch();
  const currentWorkspace = state.snapshot?.workspace?.id;
  if (currentWorkspace !== hit.workspaceId) {
    await loadWorkspace(hit.workspaceId);
    await selectRoom(hit.workspaceId, hit.roomId);
  } else if (state.snapshot?.room?.id !== hit.roomId) {
    await selectRoom(hit.workspaceId, hit.roomId);
  }
  await jumpToEvent(hit.eventId);
}
