// The composer. Unlike v1 (which rebuilt the whole form per keystroke), the
// textarea and send button are PERSISTENT nodes built once — renders only
// update the dynamic parts around them (autocomplete, running banner, target
// preview, thinking control, voice buttons), so typing never loses the caret.
//
// Features: / command preview + @ agent preview (↑/↓/Tab/Enter/Esc), thinking
// control (💭 #level: click toggles off, right-click menu), queueing while
// busy, panic stop, and bare-key routing (typing anywhere lands here).
import { editMessage, sendMessage, stopAll, uploadAttachment } from "./actions.js";
import { api } from "./api.js";
import { $, h } from "./dom.js";
import { markDirty, registerRegion, setError } from "./render.js";
import { isBusy, state } from "./state.js";
import { endCall, setMicMuted } from "./voice.js";

/** @typedef {import("./types.js").Snapshot} Snapshot */
/** @typedef {import("./types.js").AgentStatus} AgentStatus */
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
let editBannerEl = null;
/** @type {HTMLElement|null} */
let attachmentsEl = null;
/** @type {HTMLElement|null} */
let targetStatusEl = null;
/** @type {HTMLElement|null} */
let thinkingWrapEl = null;
/** @type {HTMLElement|null} */
let modelWrapEl = null;
/** @type {HTMLElement|null} */
let voiceWrapEl = null;

export function initComposer() {
  const form = $("#composer");
  if (!form) return;
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    submitComposer();
  });

  textarea = /** @type {HTMLTextAreaElement} */ (
    h("textarea", {
      rows: "1",
      class: "command-input",
      oninput: () => {
        if (!textarea) return;
        state.composerText = textarea.value;
        state.completionHidden = false;
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
  bannerLabelEl = h("span", { class: "running-label" });
  bannerEl = h(
    "div",
    { class: "running-banner", hidden: true },
    h("span", { class: "running-dot" }),
    bannerLabelEl,
    h("button", { type: "button", class: "stop-btn", title: "stop all agents (Esc)", text: "■ stop", onclick: () => void stopAll() }),
  );
  editBannerEl = h(
    "div",
    { class: "editing-banner", hidden: true },
    h("span", { text: "✎ editing message — Enter re-sends from that point, later replies are rewound" }),
    h("button", { type: "button", class: "stop-btn", title: "cancel editing (Esc)", text: "cancel", onclick: () => cancelEditing() }),
  );
  attachmentsEl = h("div", { class: "attachment-strip", hidden: true });
  targetStatusEl = h("div", { class: "target-status" });
  thinkingWrapEl = h("div", { class: "thinking-wrap" });
  modelWrapEl = h("div", { class: "model-wrap" });
  voiceWrapEl = h("div", { class: "voice-wrap" });

  form.replaceChildren(
    autocompleteEl,
    bannerEl,
    editBannerEl,
    attachmentsEl,
    h("div", { class: "input-shell" }, textarea, sendButton),
    h("div", { class: "composer-row" }, targetStatusEl, thinkingWrapEl, modelWrapEl, h("div", { class: "composer-spacer" }), voiceWrapEl),
  );
}

function renderComposer() {
  if (!textarea || !sendButton || !autocompleteEl || !bannerEl || !bannerLabelEl || !editBannerEl || !attachmentsEl || !targetStatusEl || !thinkingWrapEl || !modelWrapEl || !voiceWrapEl) return;
  const snapshot = state.snapshot;
  const busy = isBusy(snapshot);

  // Textarea chrome; the value is only written when state changed elsewhere
  // (voice transcription, background routing, submit) so typing keeps its caret.
  textarea.placeholder = !snapshot ? "select a workspace" : state.voice ? `on call with @${state.voice.agentId} - speak, or type` : "message @agent or /command";
  textarea.disabled = !snapshot;
  if (textarea.value !== state.composerText) {
    const hadFocus = document.activeElement === textarea;
    textarea.value = state.composerText;
    if (hadFocus) textarea.setSelectionRange(state.composerText.length, state.composerText.length);
  }
  resizeComposer(textarea);

  sendButton.disabled = !snapshot;
  sendButton.textContent = busy ? "+" : ">";
  sendButton.title = busy ? "queue message — runs after the current turn (Esc to stop instead)" : "send";

  // Running banner.
  bannerEl.hidden = !busy;
  if (busy) bannerLabelEl.textContent = runningLabel(snapshot);

  editBannerEl.hidden = !state.editingEventId;

  // Pending pasted files (uploaded on send).
  attachmentsEl.hidden = state.pendingAttachments.length === 0;
  attachmentsEl.replaceChildren(...AttachmentChips());

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

/** @param {{ focus?: boolean }} [options] */
function submitComposer(options = {}) {
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
  if (editing && text.trim()) {
    releasePreviews(pending);
    void editMessage(editing, text);
  } else if (pending.length > 0) {
    void sendWithAttachments(text, pending);
  } else {
    void sendMessage(text);
  }
}

/**
 * Upload the pasted files, then send the message referencing them. Uploads
 * happen at send time so an abandoned paste never reaches the server.
 * @param {string} text
 * @param {import("./types.js").PendingAttachment[]} pending
 */
async function sendWithAttachments(text, pending) {
  try {
    /** @type {import("./types.js").UploadedAttachment[]} */
    const uploaded = [];
    for (const item of pending) uploaded.push(await uploadAttachment(item.file, item.name));
    await sendMessage(text, uploaded);
  } catch (error) {
    setError(error);
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
    // While busy this queues (the server stacks it behind the running turn);
    // stopping is a separate action (Esc / Ctrl+C / the banner ■).
    submitComposer();
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
  const compacting = (snapshot?.agents ?? []).filter((agent) => agent.status === "compacting").map((agent) => `@${agent.id}`);
  const summons = (snapshot?.rooms ?? []).filter((room) => room.running).length;
  const queued = (snapshot?.tasks ?? []).filter((task) => task.status === "queued").length;
  const parts = [];
  if (agents.length) parts.push(agents.join(", "));
  if (compacting.length) parts.push(`compacting ${compacting.join(", ")}…`);
  if (summons) parts.push(`${summons} summon${summons === 1 ? "" : "s"}`);
  let label = parts.length ? `running: ${parts.join(" + ")}` : "running…";
  if (queued) label += ` · ${queued} queued`;
  return label;
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
      body: JSON.stringify({ level }),
    });
    if (onCall && state.voice) state.voice.thinking = level;
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
 * call-scoped (reverts on hang-up); otherwise it persists to agent.json.
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
      text: `⚠ ${agent.modelLabel}`,
    });
  }
  return h("span", {
    class: "model-chip",
    title: `model for @${agent.id} (configured: ${agent.configuredModel})`,
    text: agent.modelLabel,
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

/** @returns {HTMLElement[]} */
function VoiceButtons() {
  if (!state.voice) return [];
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
  if (!state.snapshot || state.settingsOpen || state.dario.open) return false;
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
      if (!state.snapshot || state.settingsOpen || state.dario.open) return;
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

      if (!shouldRouteKeyToComposer(event)) return;
      event.preventDefault();

      if (event.key === "Enter") {
        if (event.shiftKey) state.composerText += "\n";
        else if (state.composerText.trim()) {
          submitComposer({ focus: true });
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
  if (state.settingsOpen || state.dario.open) return;
  if (isEditableElement(event.target)) return;
  if (event.target instanceof HTMLElement && event.target.closest("button")) return;
  focusComposer();
}
