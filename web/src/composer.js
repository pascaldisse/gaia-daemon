// The composer. Unlike v1 (which rebuilt the whole form per keystroke), the
// textarea and send button are PERSISTENT nodes built once — renders only
// update the dynamic parts around them (autocomplete, running banner, target
// preview, thinking control, voice buttons), so typing never loses the caret.
//
// Features: / command preview + @ agent preview (↑/↓/Tab/Enter/Esc), thinking
// control (💭 #level: click toggles off, right-click menu), queueing while
// busy, panic stop, and bare-key routing (typing anywhere lands here).
import { editMessage, selectRoom, sendMessage, stopAll, uploadAttachment } from "./actions.js";
import { api } from "./api.js";
import { CompactBar, compactDetail } from "./compactprogress.js";
import { $, h } from "./dom.js";
import { shortModel } from "./models.js";
import { markDirty, registerRegion, setError } from "./render.js";
import { buildAudioPlayer } from "./readaloud.js";
import { isBusy, runningSummonRooms, state } from "./state.js";
import { endCall, setMicMuted } from "./voice.js";
import {
  cancelDictation,
  discardFailedDictation,
  discardRecoveredDraft,
  finalizeDictationForSend,
  hasFailedDictation,
  refreshDictationDrafts,
  retryDictation,
  toggleDictation,
  transcribeRecoveredDraft,
} from "./dictation.js";

/** @typedef {import("./types.js").Snapshot} Snapshot */
/** @typedef {import("./types.js").AgentStatus} AgentStatus */
/** @typedef {import("./types.js").RoomSummary} RoomSummary */
/** @typedef {{ label: string, value: string, description?: string, suffix?: string }} CompletionOption */
/** @typedef {{ kind: "/"|"@", start: number, query: string, options: CompletionOption[] }} Completion */

/** @type {HTMLTextAreaElement|null} */
let textarea = null;
/** @type {HTMLButtonElement|null} */
let sendButton = null;
/** @type {HTMLElement|null} */
let autocompleteEl = null;
/** @type {HTMLElement|null} */
let bannerEl = null;
/** @type {HTMLElement|null} */
let bannerLabelEl = null;
/** @type {HTMLElement|null} */
let bannerBarEl = null;
/** @type {HTMLElement|null} */
let summonListEl = null;
/** @type {HTMLElement|null} */
let editBannerEl = null;
/** @type {HTMLElement|null} */
let attachmentsEl = null;
/** @type {HTMLElement|null} */
let dictationStatusEl = null;
/** @type {HTMLElement|null} */
let targetStatusEl = null;
/** @type {HTMLElement|null} */
let thinkingWrapEl = null;
/** @type {HTMLElement|null} */
let modelWrapEl = null;
/** @type {HTMLElement|null} */
let voiceWrapEl = null;

// Draft persistence (composer durability — "nothing is ever lost"): the
// in-progress text survives a reload/crash and is restored per-room.
/** @returns {string|null} */
function draftKey() {
  const s = state.snapshot;
  return s ? `gaia.draft.${s.workspace.id}.${s.room.id}` : null;
}

/** @param {string} text */
function persistDraft(text) {
  const k = draftKey();
  if (!k) return;
  try {
    if (text.trim()) localStorage.setItem(k, text);
    else localStorage.removeItem(k);
  } catch {}
}

function clearDraft() {
  const k = draftKey();
  if (!k) return;
  try {
    localStorage.removeItem(k);
  } catch {}
}

// Tracks which room's draft has already been restored into state.composerText,
// so switching rooms restores at most once (and doesn't clobber live typing).
/** @type {string|null} */
let restoredRoomKey = null;

export function initComposer() {
  const form = $("#composer");
  if (!form) return;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitComposer();
  });

  textarea = /** @type {HTMLTextAreaElement} */ (
    h("textarea", {
      rows: "1",
      class: "command-input",
      oninput: () => {
        if (!textarea) return;
        state.composerText = textarea.value;
        state.completionHidden = false;
        persistDraft(textarea.value);
        resizeComposer(textarea);
        markDirty("composer");
      },
      onpaste: (event) => {
        if (capturePastedFiles(event)) return;
        requestAnimationFrame(() => textarea && resizeComposer(textarea));
      },
      onkeydown: onComposerKeydown,
    })
  );
  sendButton = /** @type {HTMLButtonElement} */ (h("button", { class: "send-button", text: ">" }));
  autocompleteEl = h("div", { class: "autocomplete", hidden: true });
  // Clicking the label toggles the summon list (only meaningful when this room
  // has running summons — renderComposer adds/removes the `has-summons` class).
  bannerLabelEl = h("span", {
    class: "running-label",
    onclick: () => {
      if (runningSummonRooms(state.snapshot).length === 0) return;
      state.summonListOpen = !state.summonListOpen;
      markDirty("composer");
    },
  });
  bannerBarEl = h("span", { class: "compact-bar-wrap", hidden: true });
  // Expandable list of this room's running summons; each row jumps to its
  // sub-room. Anchored above the banner, populated + shown in renderComposer.
  summonListEl = h("div", { class: "summon-list", hidden: true });
  bannerEl = h(
    "div",
    { class: "running-banner", hidden: true },
    h("span", { class: "running-dot" }),
    bannerLabelEl,
    bannerBarEl,
    h("button", { type: "button", class: "stop-btn", title: "stop all agents (Esc)", text: "■ stop", onclick: () => void stopAll() }),
    summonListEl,
  );
  editBannerEl = h(
    "div",
    { class: "editing-banner", hidden: true },
    h("span", { text: "✎ editing message — Enter re-sends from that point, later replies are rewound" }),
    h("button", { type: "button", class: "stop-btn", title: "cancel editing (Esc)", text: "cancel", onclick: () => cancelEditing() }),
  );
  attachmentsEl = h("div", { class: "attachment-strip", hidden: true });
  dictationStatusEl = h("div", { class: "dictation-status", hidden: true });
  targetStatusEl = h("div", { class: "target-status" });
  thinkingWrapEl = h("div", { class: "thinking-wrap" });
  modelWrapEl = h("div", { class: "model-wrap" });
  voiceWrapEl = h("div", { class: "voice-wrap" });

  form.replaceChildren(
    autocompleteEl,
    // The read-aloud mini player (play/pause + seekable timeline). Built once and
    // driven by readaloud.js; sits above the running banner, hidden until a
    // message is played.
    buildAudioPlayer(),
    bannerEl,
    editBannerEl,
    attachmentsEl,
    dictationStatusEl,
    h("div", { class: "input-shell" }, textarea, sendButton),
    h("div", { class: "composer-row" }, targetStatusEl, thinkingWrapEl, modelWrapEl, h("div", { class: "composer-spacer" }), voiceWrapEl),
  );
}

function renderComposer() {
  if (!textarea || !sendButton || !autocompleteEl || !bannerEl || !bannerLabelEl || !editBannerEl || !attachmentsEl || !dictationStatusEl || !targetStatusEl || !thinkingWrapEl || !modelWrapEl || !voiceWrapEl) return;
  const snapshot = state.snapshot;
  const busy = isBusy(snapshot);

  // Restore a persisted draft once per room switch (never clobbers text
  // already typed for this room, e.g. from a fresh page load mid-composition).
  const currentDraftKey = draftKey();
  if (currentDraftKey !== restoredRoomKey) {
    restoredRoomKey = currentDraftKey;
    if (!state.composerText.trim()) {
      try {
        const stored = currentDraftKey ? localStorage.getItem(currentDraftKey) : null;
        if (stored) {
          state.composerText = stored;
          textarea.value = stored;
        }
      } catch {}
    }
    // Recovered dictation drafts (crash/reload durability) are per-room too —
    // refresh the chip list whenever the room switches.
    void refreshDictationDrafts();
  }

  // Textarea chrome; the value is only written when state changed elsewhere
  // (voice transcription, background routing, submit) so typing keeps its caret.
  textarea.placeholder = !snapshot
    ? "select a workspace"
    : state.voice
      ? `on call with @${state.voice.agentId} - speak, or type`
      : snapshot.room.incognito
        ? "🕶 incognito — message @agent or /command (nothing saved to memory)"
        : "message @agent or /command";
  textarea.disabled = !snapshot;
  if (textarea.value !== state.composerText) {
    const hadFocus = document.activeElement === textarea;
    textarea.value = state.composerText;
    if (hadFocus) textarea.setSelectionRange(state.composerText.length, state.composerText.length);
  }
  resizeComposer(textarea);

  const dictationPending = state.dictating || state.dictationBusy;
  sendButton.disabled = !snapshot;
  sendButton.textContent = state.dictationBusy ? "…" : busy ? "»" : ">";
  sendButton.title = dictationPending
    ? "send voice message — stops recording, transcribes, then sends"
    : busy
      ? "steer the running turn — injects your message mid-turn (⌘/Ctrl+Enter to queue instead · Esc to stop)"
      : "send";

  // Running banner. While a compaction runs, the label carries the numbers and
  // the bar between it and ■ stop shows the estimated fraction.
  bannerEl.hidden = !busy;
  if (busy) bannerLabelEl.textContent = runningLabel(snapshot);
  const compactingAgent = busy ? (snapshot?.agents ?? []).find((agent) => agent.status === "compacting" && agent.compact) : undefined;
  if (bannerBarEl) {
    bannerBarEl.hidden = !compactingAgent;
    bannerBarEl.replaceChildren(...(compactingAgent?.compact ? [CompactBar(compactingAgent.compact)] : []));
  }

  // Summon list: the label is a click target only when this room has running
  // summons; clicking expands the list of them, each a jump to its sub-room.
  const summons = busy ? runningSummonRooms(snapshot) : [];
  bannerLabelEl.classList.toggle("has-summons", summons.length > 0);
  if (summons.length === 0) state.summonListOpen = false;
  if (summonListEl) {
    const open = state.summonListOpen && summons.length > 0;
    summonListEl.hidden = !open;
    summonListEl.replaceChildren(...(open && snapshot ? SummonRows(summons, snapshot.workspace.id) : []));
  }

  editBannerEl.hidden = !state.editingEventId;

  // Pending pasted files (uploaded on send).
  attachmentsEl.hidden = state.pendingAttachments.length === 0;
  attachmentsEl.replaceChildren(...AttachmentChips());

  // The live panel (recording/transcribing/failed) and recovered-draft chips
  // (from a crash/reload) are independent — a recovered chip renders
  // regardless of whether a live recording is in progress, and never
  // disables the mic or send button.
  const dictationPanel = DictationPanel();
  const draftChips = DictationDraftChips();
  const dictationChildren = [...(dictationPanel ? [dictationPanel] : []), ...draftChips];
  dictationStatusEl.hidden = dictationChildren.length === 0;
  dictationStatusEl.replaceChildren(...dictationChildren);

  // Autocomplete.
  const completion = completionFor(state.composerText);
  if (completion && !state.completionHidden) {
    autocompleteEl.hidden = false;
    autocompleteEl.replaceChildren(...AutocompleteRows(completion));
  } else {
    autocompleteEl.hidden = true;
    autocompleteEl.replaceChildren();
  }

  targetStatusEl.textContent = composerTargetStatus(snapshot, state.composerText);

  const thinking = ThinkingControl(snapshot, state.composerText);
  thinkingWrapEl.replaceChildren(...(thinking ? [thinking] : []));

  const model = ModelChip(snapshot, state.composerText);
  const context = ContextChip(snapshot, state.composerText);
  const memory = MemoryChip(snapshot);
  modelWrapEl.replaceChildren(...[model, context, memory].filter((chip) => chip !== null));

  voiceWrapEl.replaceChildren(...VoiceButtons());
}

registerRegion("composer", renderComposer);

/** @param {{ focus?: boolean, queue?: boolean }} [options] */
async function submitComposer(options = {}) {
  if (state.dictating || state.dictationBusy) {
    const ok = await finalizeDictationForSend();
    if (ok) await submitComposer(options);
    return;
  }

  const text = state.composerText;
  const editing = state.editingEventId;
  const pending = state.pendingAttachments;
  state.composerText = "";
  state.editingEventId = null;
  state.pendingAttachments = [];
  state.completionIndex = 0;
  state.completionHidden = false;
  markDirty("composer");
  if (options.focus) focusComposer();

  // The clear above is optimistic — if the dispatch fails, put the text back
  // (and re-arm edit mode) rather than silently losing it. Only restores when
  // the composer is still empty (the user hasn't typed something new meanwhile).
  const restoreOnFailure = (/** @type {Promise<boolean>} */ p) => {
    void p.then((ok) => {
      if (ok) {
        clearDraft();
        return;
      }
      if (!state.composerText.trim()) {
        state.composerText = text;
        if (editing) state.editingEventId = editing;
        persistDraft(text);
        markDirty("composer");
      }
    });
  };

  if (editing && text.trim()) {
    releasePreviews(pending);
    restoreOnFailure(editMessage(editing, text));
  } else if (pending.length > 0) {
    restoreOnFailure(sendWithAttachments(text, pending, { queue: options.queue }));
  } else {
    restoreOnFailure(sendMessage(text, [], { queue: options.queue }));
  }
}

/**
 * Upload the pasted files, then send the message referencing them. Uploads
 * happen at send time so an abandoned paste never reaches the server.
 * @param {string} text
 * @param {import("./types.js").PendingAttachment[]} pending
 * @param {{ queue?: boolean }} [options]
 * @returns {Promise<boolean>}
 */
async function sendWithAttachments(text, pending, options = {}) {
  try {
    /** @type {import("./types.js").UploadedAttachment[]} */
    const uploaded = [];
    for (const item of pending) uploaded.push(await uploadAttachment(item.file, item.name));
    return await sendMessage(text, uploaded, { queue: options.queue });
  } catch (error) {
    setError(error);
    return false;
  } finally {
    releasePreviews(pending);
  }
}

/**
 * Capture files from a paste (the system-level paste — no attach button).
 * Returns true when the event carried files and was consumed.
 * @param {ClipboardEvent} event
 */
export function capturePastedFiles(event) {
  const files = [...(event.clipboardData?.files ?? [])];
  if (files.length === 0) return false;
  event.preventDefault();
  if (state.editingEventId) {
    setError(new Error("Finish (or cancel) editing before attaching files — an edit keeps the original attachments."));
    return true;
  }
  for (const file of files) {
    state.pendingAttachments.push({
      file,
      name: file.name || pastedName(file.type),
      mime: file.type || "application/octet-stream",
      size: file.size,
      previewUrl: file.type.startsWith("image/") ? URL.createObjectURL(file) : null,
    });
  }
  markDirty("composer");
  return true;
}

/** A readable filename for clipboard data that has none (screenshots).
 * @param {string} mime */
function pastedName(mime) {
  const ext = (mime.split("/")[1] ?? "bin").split("+")[0];
  return `pasted-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.${ext}`;
}

/** @param {import("./types.js").PendingAttachment[]} pending */
function releasePreviews(pending) {
  for (const item of pending) {
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
  }
}

/** @returns {HTMLElement[]} */
function AttachmentChips() {
  return state.pendingAttachments.map((item, index) => {
    const remove = h("button", {
      type: "button",
      class: "attach-remove",
      title: `remove ${item.name}`,
      text: "×",
      onclick: () => {
        if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
        state.pendingAttachments.splice(index, 1);
        markDirty("composer");
      },
    });
    if (item.previewUrl) {
      return h(
        "div",
        { class: "attach-chip image", title: `${item.name} (${humanSize(item.size)})` },
        h("img", { class: "attach-thumb", src: item.previewUrl, alt: item.name }),
        remove,
      );
    }
    return h(
      "div",
      { class: "attach-chip", title: item.name },
      h("span", { class: "attach-icon", text: "📎" }),
      h("span", { class: "attach-name", text: item.name }),
      h("small", { text: humanSize(item.size) }),
      remove,
    );
  });
}

/** @param {number} bytes */
export function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} kB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Enter claude.ai-style edit mode for a user message: the composer takes the
 * message text and submit forks the room at that message (transcript.js's ✎).
 * @param {string} eventId
 * @param {string} text
 */
export function beginEditMessage(eventId, text) {
  state.editingEventId = eventId;
  state.composerText = text;
  state.completionHidden = true;
  markDirty("composer");
  focusComposer();
}

function cancelEditing() {
  state.editingEventId = null;
  state.composerText = "";
  markDirty("composer");
}

/** @param {KeyboardEvent} event */
function onComposerKeydown(event) {
  const completion = state.completionHidden ? null : completionFor(state.composerText);
  if (completion && ["ArrowDown", "ArrowUp", "Tab", "Escape", "Enter"].includes(event.key)) {
    event.preventDefault();
    const count = Math.max(1, completion.options.length);
    if (event.key === "ArrowDown") state.completionIndex = (state.completionIndex + 1) % count;
    else if (event.key === "ArrowUp") state.completionIndex = (state.completionIndex - 1 + count) % count;
    else if (event.key === "Escape") state.completionHidden = true;
    else if (completion.options.length > 0) applyCompletion(completion, completion.options[state.completionIndex] ?? completion.options[0]);
    markDirty("composer");
    return;
  }

  if (event.key === "Escape" && state.editingEventId) {
    event.preventDefault();
    cancelEditing();
    return;
  }

  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    // Enter is the default send. While busy the server STEERS the running turn
    // (injects the message mid-turn); Cmd/Ctrl+Enter forces the durable queue
    // instead. Stopping is a separate action (Esc / Ctrl+C / the banner ■).
    void submitComposer({ queue: event.metaKey || event.ctrlKey });
  }
}

// ---------------------------------------------------------------------------
// Autocomplete: /commands and @agents.

/** @param {string} text @returns {Completion|null} */
function completionFor(text) {
  if (!state.snapshot) return null;
  const slash = text.match(/^\/([^\s]*)$/);
  if (slash) {
    const query = slash[1].toLowerCase();
    const options = (state.snapshot.commands ?? [])
      .filter((command) => command.name.toLowerCase().startsWith(query))
      .map((command) => ({
        label: command.name,
        value: `/${command.name}`,
        description: command.description,
        // Commands that take an argument (roles, and native passthrough like
        // /deep-research <query>) get a trailing space to keep typing.
        suffix: command.native || command.name === "role" || command.name === "roles" ? " " : "",
      }));
    state.completionIndex = Math.min(state.completionIndex, Math.max(0, options.length - 1));
    return { kind: "/", start: 0, query, options };
  }

  const mention = text.match(/(^|\s)@([a-z0-9_-]*)$/i);
  if (!mention || mention.index === undefined) return null;
  const separator = mention[1];
  const query = mention[2].toLowerCase();
  const start = mention.index + separator.length;
  // Mentions only route at the message HEAD (see composerTargets); don't
  // hijack an "@" typed mid-prose (emails, npm scopes) with the agent popup.
  // The zone before the caret's @token must be only whitespace + addresses.
  if (!/^(?:\s*@[a-z0-9_-]+[,:]?)*\s*$/i.test(text.slice(0, start))) return null;
  const options = (state.snapshot.agents ?? [])
    .filter((agent) => agent.id.toLowerCase().startsWith(query))
    .map((agent) => ({
      label: agent.id,
      value: `@${agent.id}`,
      description: [agent.isDefault ? "default" : "", agent.activeRole ? `role:${agent.activeRole}` : "", agent.modelLabel].filter(Boolean).join(" / "),
      suffix: " ",
    }));
  state.completionIndex = Math.min(state.completionIndex, Math.max(0, options.length - 1));
  return { kind: "@", start, query, options };
}

/** @param {Completion} completion @param {CompletionOption|undefined} option */
function applyCompletion(completion, option) {
  if (!option) return;
  state.composerText = `${state.composerText.slice(0, completion.start)}${option.value}${option.suffix ?? ""}`;
  state.completionIndex = 0;
  state.completionHidden = true;
}

/** @param {Completion} completion @returns {HTMLElement[]} */
function AutocompleteRows(completion) {
  const options = completion.options.slice(0, 8);
  if (options.length === 0) {
    return [h("div", { class: "completion-row empty", text: `${completion.kind}${completion.query}  no matches` })];
  }
  return options.map((option, index) =>
    h(
      "button",
      {
        type: "button",
        class: `completion-row ${index === state.completionIndex ? "active" : ""}`,
        onmousedown: (event) => event.preventDefault(),
        onclick: () => {
          applyCompletion(completion, option);
          markDirty("composer");
          focusComposer();
        },
      },
      h("span", { text: option.value }),
      h("small", { text: option.description ?? "" }),
    ),
  );
}

// ---------------------------------------------------------------------------
// Target preview + thinking control.

/** @param {Snapshot|null} snapshot */
function runningLabel(snapshot) {
  const agents = (snapshot?.agents ?? []).filter((agent) => agent.status === "running").map((agent) => `@${agent.id}`);
  const compacting = (snapshot?.agents ?? []).filter((agent) => agent.status === "compacting");
  const summons = runningSummonRooms(snapshot).length;
  const queued = (snapshot?.tasks ?? []).filter((task) => task.status === "queued").length;
  const parts = [];
  if (agents.length) parts.push(agents.join(", "));
  if (compacting.length) {
    parts.push(compacting.map((agent) => `compacting @${agent.id}${agent.compact ? ` ${compactDetail(agent.compact)}` : "…"}`).join(", "));
  }
  if (summons) parts.push(`${summons} summon${summons === 1 ? "" : "s"}`);
  let label = parts.length ? `running: ${parts.join(" + ")}` : "running…";
  if (queued) label += ` · ${queued} queued`;
  return label;
}

/**
 * Rows for the expandable summon list — one clickable button per running summon
 * sub-room; clicking jumps to that room's live output and collapses the list.
 * @param {RoomSummary[]} summons
 * @param {string} workspaceId
 * @returns {HTMLElement[]}
 */
function SummonRows(summons, workspaceId) {
  return summons.map((room) =>
    h(
      "button",
      {
        type: "button",
        class: "summon-row",
        title: `jump to ${room.id}`,
        onclick: () => {
          state.summonListOpen = false;
          void selectRoom(workspaceId, room.id);
        },
      },
      h("span", { class: "summon-row-dot" }),
      h("span", { class: "summon-row-name", text: room.title ?? room.id }),
      h("span", { class: "summon-row-hint", text: "watch →" }),
    ),
  );
}

// Mirror of the server-side mention router (services/commands.ts): mentions
// are ADDRESSES — only the run of consecutive @id tokens heading the message
// routes it. "@" anywhere later is plain text (pasted emails, npm scopes,
// quoted logs), so the preview must not claim it retargets the message.
const LEADING_MENTION = /^@([a-z0-9_-]+)[,:]?(?=\s|$)/i;

/** @param {string} text @returns {string[]} lowercased @ids heading the message */
function leadingMentionIds(text) {
  /** @type {string[]} */
  const ids = [];
  let rest = text.trimStart();
  for (;;) {
    const match = LEADING_MENTION.exec(rest);
    if (!match) return ids;
    ids.push(match[1].toLowerCase());
    rest = rest.slice(match[0].length).trimStart();
  }
}

/** @param {Snapshot|null} snapshot @param {string} text @returns {string[]} */
function composerTargets(snapshot, text) {
  const knownAgents = new Set((snapshot?.agents ?? []).map((agent) => agent.id));
  const targets = leadingMentionIds(text).filter((id, index, all) => knownAgents.has(id) && all.indexOf(id) === index);
  // No leading mention → the room's active agent (who you're last talking to),
  // falling back to the workspace default when the room hasn't set one yet.
  if (targets.length === 0 && snapshot) targets.push(snapshot.room.activeAgent ?? snapshot.workspace.defaultAgent);
  return targets;
}

/** @param {Snapshot|null} snapshot @param {string} text */
function composerTargetStatus(snapshot, text) {
  if (!snapshot) return "no room";
  if (text.trimStart().startsWith("/")) {
    // A native passthrough command (/deep-research …) runs as a turn to the
    // active agent, so preview the target like a message; gaia commands show
    // "command mode".
    const name = text.trimStart().slice(1).split(/\s+/)[0]?.toLowerCase();
    const isNative = (snapshot.commands ?? []).some((command) => command.native && command.name.toLowerCase() === name);
    if (!isNative) return "command mode";
  }
  // A leading mention that matches no agent will REJECT the send — say so in
  // the chip instead of quietly previewing the default agent.
  const knownAgents = new Set((snapshot.agents ?? []).map((agent) => agent.id));
  const unknown = leadingMentionIds(text).filter((id) => !knownAgents.has(id));
  if (unknown.length) return `unknown: ${unknown.map((id) => `@${id}`).join(", ")}`;
  return composerTargets(snapshot, text).map((target) => `@${target}`).join(", ");
}

// Last non-off level per agent, so the off-toggle can come back to it.
/** @type {Map<string, string>} */
const thinkingReturnLevels = new Map();

/**
 * @param {Snapshot} snapshot
 * @param {AgentStatus} agent
 * @param {string} level
 * @param {boolean} onCall
 */
async function postThinking(snapshot, agent, level, onCall) {
  try {
    await api(`/api/workspaces/${encodeURIComponent(snapshot.workspace.id)}/agents/${encodeURIComponent(agent.id)}/thinking`, {
      method: "POST",
      body: JSON.stringify({ level, roomId: snapshot.room.id }),
    });
    if (onCall && state.voice) state.voice.thinking = level;
    // Optimistic: updates the snapshot's per-agent effective view for THIS
    // room; the next snapshot refresh reflects the room-scoped override.
    else agent.thinking = level;
    state.thinkingMenuOpen = false;
    markDirty("composer");
  } catch (error) {
    setError(error);
  }
}

/**
 * Thinking-effort indicator: click toggles between the current level and
 * off; right-click opens a menu with all levels. On a call the change is
 * call-scoped (reverts on hang-up); otherwise it is room-scoped (matches
 * /role) — it never persists to agent.json.
 * @param {Snapshot|null} snapshot
 * @param {string} text
 * @returns {HTMLElement|null}
 */
function ThinkingControl(snapshot, text) {
  if (!snapshot) return null;
  const onCall = Boolean(state.voice);
  const targetId = state.voice ? state.voice.agentId : composerTargets(snapshot, text)[0];
  const agent = (snapshot.agents ?? []).find((candidate) => candidate.id === targetId);
  if (!agent) return null;

  const effective = onCall ? (state.voice?.thinking ?? agent.thinking ?? "off") : (agent.thinking ?? "off");
  const levels = snapshot.thinkingLevels ?? [];
  if (levels.length === 0) return null;

  const toggle = h("button", {
    type: "button",
    class: "thinking-toggle",
    title: `thinking effort for @${agent.id} - click toggles off, right-click for levels${onCall ? " (this call only)" : ""}`,
    onclick: (event) => {
      event.preventDefault();
      /** @type {string} */
      let next;
      if (effective === "off") {
        const remembered = thinkingReturnLevels.get(agent.id);
        const configured = agent.thinking && agent.thinking !== "off" ? agent.thinking : undefined;
        next = remembered ?? configured ?? "medium";
      } else {
        thinkingReturnLevels.set(agent.id, effective);
        next = "off";
      }
      void postThinking(snapshot, agent, next, onCall);
    },
    oncontextmenu: (event) => {
      event.preventDefault();
      state.thinkingMenuOpen = !state.thinkingMenuOpen;
      markDirty("composer");
    },
    text: `\u{1F4AD} #${effective}`,
  });

  return h(
    "div",
    { class: "thinking-inner" },
    toggle,
    state.thinkingMenuOpen
      ? h(
          "div",
          { class: "thinking-menu" },
          levels.map((level) =>
            h("button", {
              type: "button",
              class: level === effective ? "active" : "",
              onclick: () => {
                if (level !== "off") thinkingReturnLevels.set(agent.id, level);
                void postThinking(snapshot, agent, level, onCall);
              },
              text: `#${level}`,
            }),
          ),
        )
      : null,
  );
}

/**
 * The agent the composer currently targets (the voice-call peer, else the
 * first mention, else the default agent).
 * @param {Snapshot|null} snapshot
 * @param {string} text
 * @returns {AgentStatus|undefined}
 */
function composerAgent(snapshot, text) {
  if (!snapshot) return undefined;
  const targetId = state.voice ? state.voice.agentId : composerTargets(snapshot, text)[0];
  return (snapshot.agents ?? []).find((candidate) => candidate.id === targetId);
}

/**
 * Model indicator for the composer's target agent: what live turns actually
 * run (`modelLabel`, falling back to the configured model before the first
 * turn). Warning state when the provider switched models mid-turn — e.g.
 * fable rerouted to opus by a capacity fallback or safety classifier.
 * @param {Snapshot|null} snapshot
 * @param {string} text
 * @returns {HTMLElement|null}
 */
function ModelChip(snapshot, text) {
  const agent = composerAgent(snapshot, text);
  if (!agent) return null;
  const fallback = agent.modelFallback;
  if (fallback) {
    // The reroute is per message: every turn re-requests the configured
    // model, so the next clean turn reverts by itself — say so, or the
    // automatic flip back looks like a display glitch.
    return h("span", {
      class: "model-chip fallback",
      title:
        `provider switched models on the last turn: ${fallback.from} → ${fallback.to} — ${fallback.reason} ` +
        `(configured: ${agent.configuredModel}; each turn re-requests it, so this usually reverts on the next clean turn — ` +
        `this chip and each message's model tag always show what actually ran)`,
      text: `⚠ ${shortModel(agent.modelLabel)}`,
    });
  }
  return h("span", {
    class: "model-chip",
    title: `model for @${agent.id} (configured: ${agent.configuredModel}; ran: ${agent.modelLabel})`,
    text: shortModel(agent.modelLabel),
  });
}

/**
 * Context-window usage for the composer's target agent, as its harness last
 * reported. Percentage when the window size is known; warn tint from 80%.
 * @param {Snapshot|null} snapshot
 * @param {string} text
 * @returns {HTMLElement|null}
 */
function ContextChip(snapshot, text) {
  const context = composerAgent(snapshot, text)?.context;
  if (!context) return null;
  const percent = context.maxTokens ? Math.round((context.usedTokens / context.maxTokens) * 100) : null;
  return h("span", {
    class: percent !== null && percent >= 80 ? "context-chip warn" : "context-chip",
    title: context.maxTokens
      ? `context used: ${context.usedTokens.toLocaleString()} of ${context.maxTokens.toLocaleString()} tokens — /compact frees it`
      : `context used: ${context.usedTokens.toLocaleString()} tokens (window size unknown)`,
    text: percent !== null ? `ctx ${percent}%` : `ctx ${Math.round(context.usedTokens / 1000)}k`,
  });
}

/**
 * Memory-subsystem degradation warning (MEMORY-DESIGN.md §10 — degradation is
 * loud). The daemon puts short chips on the snapshot ("embedder dead", "index
 * degraded"); healthy memory renders nothing. Same visual family as the
 * model-fallback warning: a glance, not a buried log line.
 * @param {Snapshot|null} snapshot
 * @returns {HTMLElement|null}
 */
function MemoryChip(snapshot) {
  const chips = snapshot?.memoryChips ?? [];
  if (!chips.length) return null;
  return h("span", {
    class: "model-chip fallback",
    title: `memory subsystem degraded: ${chips.join("; ")} — run \`gaia memory status\` in the workspace for detail`,
    text: `⚠ memory: ${chips.join(", ")}`,
  });
}


/** @returns {HTMLElement|null} */
function DictationPanel() {
  const failed = hasFailedDictation();
  if (!state.dictating && !state.dictationBusy && !failed && !state.dictationError) return null;
  const bars = state.dictationBars.length ? state.dictationBars : Array.from({ length: 28 }, () => 0.04);
  const status = state.dictating
    ? "recording"
    : state.dictationBusy
      ? "transcribing…"
      : failed
        ? `transcription failed — ${state.dictationError}`
        : state.dictationError;
  const actions = [];
  if (state.dictating) {
    actions.push(h("button", { type: "button", class: "dictation-action primary", text: "stop + transcribe", onclick: () => void toggleDictation() }));
  } else if (state.dictationBusy) {
    // Transcribing: no actions.
  } else if (failed) {
    actions.push(h("button", { type: "button", class: "dictation-action primary", text: "retry", onclick: () => void retryDictation() }));
    actions.push(h("button", { type: "button", class: "dictation-action danger", text: "discard", onclick: () => discardFailedDictation() }));
  } else {
    // Error without a clip (e.g. secure-context message): dismiss only.
    actions.push(h("button", { type: "button", class: "dictation-action danger", text: "dismiss", onclick: () => discardFailedDictation() }));
  }
  return h(
    "div",
    { class: `dictation-panel${state.dictating ? " recording" : ""}${state.dictationBusy ? " busy" : ""}${failed ? " failed" : ""}` },
    h(
      "div",
      { class: "dictation-wave", title: "live microphone level" },
      bars.map((level) => h("span", { class: "dictation-wave-bar", style: `--level:${Math.max(0.04, Math.min(1, level)).toFixed(3)}` })),
    ),
    h("div", { class: "dictation-copy" }, h("strong", { text: status })),
    h("div", { class: "dictation-actions" }, actions),
  );
}

/**
 * Chips for recovered dictation drafts (from a crash/reload) — one per
 * state.dictationDrafts entry, each with "transcribe" / "discard" actions.
 * Reuses the dictation-panel/dictation-action CSS classes; never disables
 * the mic or the send button.
 * @returns {HTMLElement[]}
 */
function DictationDraftChips() {
  return state.dictationDrafts.map((draft) =>
    h(
      "div",
      { class: `dictation-panel recovered${draft.status === "failed" ? " failed" : ""}` },
      h(
        "div",
        { class: "dictation-wave", title: "recovered recording" },
        Array.from({ length: 28 }, () => h("span", { class: "dictation-wave-bar", style: "--level:0.08" })),
      ),
      h(
        "div",
        { class: "dictation-copy" },
        h("strong", { text: `recovered recording · ${formatDictationDuration(draft.durationMs)} · ${formatDictationTime(draft.startedAt)}` }),
        draft.status === "failed" && draft.error ? h("span", { text: draft.error }) : null,
      ),
      h(
        "div",
        { class: "dictation-actions" },
        h("button", {
          type: "button",
          class: "dictation-action primary",
          text: "transcribe",
          onclick: () => void transcribeRecoveredDraft(draft.id),
        }),
        h("button", {
          type: "button",
          class: "dictation-action danger",
          text: "discard",
          onclick: () => void discardRecoveredDraft(draft.id),
        }),
      ),
    ),
  );
}

/** @param {number} ms @returns {string} mm:ss */
function formatDictationDuration(ms) {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/** @param {number} ms @returns {string} */
function formatDictationTime(ms) {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}


/** @returns {HTMLElement[]} */
function VoiceButtons() {
  // On a call: mute + hang-up (live STT already fills the composer as you talk).
  if (state.voice) {
    return [
      h("button", {
        type: "button",
        class: state.micMuted ? "voice-button muted" : "voice-button",
        title: state.micMuted ? "unmute microphone" : "mute microphone",
        onclick: () => setMicMuted(!state.micMuted),
        text: state.micMuted ? "\u{1F507}" : "\u{1F3A4}",
      }),
      h("button", {
        type: "button",
        class: "voice-button end-call",
        title: `hang up @${state.voice.agentId}`,
        onclick: () => void endCall(),
        text: "⏹",
      }),
    ];
  }
  // Off a call: the dictation (voice-input) button. One click records, the next
  // stops and transcribes into the composer; right-click cancels a recording.
  if (!state.snapshot) return [];
  const recording = state.dictating;
  const busy = state.dictationBusy;
  return [
    h("button", {
      type: "button",
      class: `voice-button dictation${recording ? " recording" : ""}${busy ? " busy" : ""}`,
      title: busy
        ? "transcribing…"
        : recording
          ? "stop & transcribe (right-click or Esc to discard)"
          : "voice input — click to dictate a message",
      disabled: busy,
      onclick: () => void toggleDictation(),
      oncontextmenu: (event) => {
        event.preventDefault();
        if (recording) cancelDictation();
      },
      text: busy ? "…" : recording ? "⏺" : "\u{1F3A4}",
    }),
  ];
}

// ---------------------------------------------------------------------------
// Focus + bare-key routing.

/** @param {HTMLTextAreaElement} el */
function resizeComposer(el) {
  el.style.height = "0px";
  el.style.height = `${Math.min(180, Math.max(34, el.scrollHeight))}px`;
}

/** @param {number} [selectionStart] @param {number} [selectionEnd] */
export function focusComposer(selectionStart, selectionEnd) {
  if (!textarea || textarea.disabled) return;
  // Sync the value first so the caret can sit at the true end.
  if (textarea.value !== state.composerText) textarea.value = state.composerText;
  textarea.focus();
  const start = selectionStart ?? state.composerText.length;
  const end = selectionEnd ?? start;
  textarea.setSelectionRange(start, end);
  resizeComposer(textarea);
}

/** @param {EventTarget|null} element */
export function isEditableElement(element) {
  if (!(element instanceof HTMLElement)) return false;
  const tag = element.tagName.toLowerCase();
  return tag === "textarea" || tag === "input" || tag === "select" || element.isContentEditable;
}

/** @param {KeyboardEvent} event */
function shouldRouteKeyToComposer(event) {
  if (!state.snapshot || state.dario.open || state.search.open) return false;
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return false;
  if (isEditableElement(event.target)) return false;
  if (event.key.length === 1) return true;
  return ["Enter", "Backspace", "Delete"].includes(event.key);
}

export function installComposerRouting() {
  // Paste-anywhere: files pasted while no input is focused land in the
  // composer, exactly like bare typing does. Text pastes into the composer's
  // own textarea are left to the browser; file pastes are captured there too
  // (its own onpaste handler runs first and consumes the event).
  window.addEventListener(
    "paste",
    (event) => {
      if (!state.snapshot || state.dario.open || state.search.open) return;
      if (event.defaultPrevented || isEditableElement(event.target)) return;
      if (capturePastedFiles(event)) focusComposer();
    },
    true,
  );
  window.addEventListener(
    "pointerdown",
    (event) => {
      if (!state.thinkingMenuOpen) return;
      if (event.target instanceof HTMLElement && event.target.closest(".thinking-wrap")) return;
      state.thinkingMenuOpen = false;
      markDirty("composer");
    },
    true,
  );
  window.addEventListener(
    "keydown",
    (event) => {
      // Esc while dictating cancels the recording (before panic-stop, which
      // targets running turns — a recording isn't one).
      if (event.key === "Escape" && state.dictating) {
        event.preventDefault();
        cancelDictation();
        return;
      }
      // Panic stop: Ctrl+C or Esc aborts the running turn AND all summoned
      // workers, from anywhere in the app, for every agent/harness.
      if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "c" && isBusy()) {
        event.preventDefault();
        void stopAll();
        return;
      }
      // With the Dario popup open, Escape means "close the popup" (keys.js),
      // not panic-stop — his own review summon would be collateral otherwise.
      if (event.key === "Escape" && isBusy() && !state.dario.open) {
        event.preventDefault();
        void stopAll();
        return;
      }

      // Cmd/Ctrl+Enter queues (opts out of steer-by-default) from anywhere. When
      // the composer textarea is focused its own onComposerKeydown handles this;
      // guarding on !isEditableElement here avoids a double-submit.
      if (
        event.key === "Enter" &&
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        state.snapshot &&
        !state.dario.open &&
        !isEditableElement(event.target) &&
        (state.composerText.trim() || state.dictating || state.dictationBusy)
      ) {
        event.preventDefault();
        void submitComposer({ focus: true, queue: true });
        return;
      }

      if (!shouldRouteKeyToComposer(event)) return;
      event.preventDefault();

      if (event.key === "Enter") {
        if (event.shiftKey) state.composerText += "\n";
        else if (state.composerText.trim() || state.dictating || state.dictationBusy) {
          void submitComposer({ focus: true });
          return;
        }
      } else if (event.key === "Backspace") {
        state.composerText = state.composerText.slice(0, -1);
      } else if (event.key === "Delete") {
        // Nothing to delete when the implicit cursor is at the end of the composer.
      } else if (event.key.length === 1) {
        state.composerText += event.key;
        state.completionHidden = false;
      }

      focusComposer();
      markDirty("composer");
    },
    true,
  );
}

/** @param {PointerEvent} event */
export function focusComposerFromBackground(event) {
  // On touch, focusing = popping the iOS keyboard on every tap; keep this
  // background-click-to-focus convenience for desktop mice/trackpads only.
  if (event.pointerType === "touch") return;
  if (state.dario.open || state.search.open) return;
  if (isEditableElement(event.target)) return;
  if (event.target instanceof HTMLElement && event.target.closest("button")) return;
  focusComposer();
}
