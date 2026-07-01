// The composer. Unlike v1 (which rebuilt the whole form per keystroke), the
// textarea and send button are PERSISTENT nodes built once — renders only
// update the dynamic parts around them (autocomplete, running banner, target
// preview, thinking control, voice buttons), so typing never loses the caret.
//
// Features: / command preview + @ agent preview (↑/↓/Tab/Enter/Esc), thinking
// control (💭 #level: click toggles off, right-click menu), queueing while
// busy, panic stop, and bare-key routing (typing anywhere lands here).
import { sendMessage, stopAll } from "./actions.js";
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
let targetStatusEl = null;
/** @type {HTMLElement|null} */
let thinkingWrapEl = null;
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
      onpaste: () => requestAnimationFrame(() => textarea && resizeComposer(textarea)),
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
  targetStatusEl = h("div", { class: "target-status" });
  thinkingWrapEl = h("div", { class: "thinking-wrap" });
  voiceWrapEl = h("div", { class: "voice-wrap" });

  form.replaceChildren(
    autocompleteEl,
    bannerEl,
    h("div", { class: "input-shell" }, textarea, sendButton),
    h("div", { class: "composer-row" }, targetStatusEl, thinkingWrapEl, h("div", { class: "composer-spacer" }), voiceWrapEl),
  );
}

function renderComposer() {
  if (!textarea || !sendButton || !autocompleteEl || !bannerEl || !bannerLabelEl || !targetStatusEl || !thinkingWrapEl || !voiceWrapEl) return;
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

  voiceWrapEl.replaceChildren(...VoiceButtons());
}

registerRegion("composer", renderComposer);

/** @param {{ focus?: boolean }} [options] */
function submitComposer(options = {}) {
  const text = state.composerText;
  state.composerText = "";
  state.completionIndex = 0;
  state.completionHidden = false;
  markDirty("composer");
  if (options.focus) focusComposer();
  void sendMessage(text);
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
        suffix: command.name === "role" || command.name === "roles" ? " " : "",
      }));
    state.completionIndex = Math.min(state.completionIndex, Math.max(0, options.length - 1));
    return { kind: "/", start: 0, query, options };
  }

  const mention = text.match(/(^|\s)@([a-z0-9_-]*)$/i);
  if (!mention || mention.index === undefined) return null;
  const separator = mention[1];
  const query = mention[2].toLowerCase();
  const start = mention.index + separator.length;
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
  const summons = (snapshot?.rooms ?? []).filter((room) => room.running).length;
  const queued = (snapshot?.tasks ?? []).filter((task) => task.status === "queued").length;
  const parts = [];
  if (agents.length) parts.push(agents.join(", "));
  if (summons) parts.push(`${summons} summon${summons === 1 ? "" : "s"}`);
  let label = parts.length ? `running: ${parts.join(" + ")}` : "running…";
  if (queued) label += ` · ${queued} queued`;
  return label;
}

/** @param {Snapshot|null} snapshot @param {string} text @returns {string[]} */
function composerTargets(snapshot, text) {
  const knownAgents = new Set((snapshot?.agents ?? []).map((agent) => agent.id));
  /** @type {string[]} */
  const targets = [];
  for (const match of text.matchAll(/@([a-z0-9_-]+)/gi)) {
    // Lowercase like the server-side mention router so the preview matches
    // the actual routing.
    const id = match[1].toLowerCase();
    if (!knownAgents.has(id) || targets.includes(id)) continue;
    targets.push(id);
  }
  if (targets.length === 0 && snapshot) targets.push(snapshot.workspace.defaultAgent);
  return targets;
}

/** @param {Snapshot|null} snapshot @param {string} text */
function composerTargetStatus(snapshot, text) {
  if (!snapshot) return "no room";
  if (text.trimStart().startsWith("/")) return "command mode";
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
  if (!state.snapshot || state.settingsOpen) return false;
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return false;
  if (isEditableElement(event.target)) return false;
  if (event.key.length === 1) return true;
  return ["Enter", "Backspace", "Delete"].includes(event.key);
}

export function installComposerRouting() {
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
      if (event.key === "Escape" && isBusy()) {
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
  if (state.settingsOpen) return;
  if (isEditableElement(event.target)) return;
  if (event.target instanceof HTMLElement && event.target.closest("button")) return;
  focusComposer();
}
