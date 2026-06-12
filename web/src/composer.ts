import { cancelActiveTask, sendMessage } from "./actions.ts";
import { api } from "./api.ts";
import { h } from "./dom.ts";
import { render, setError } from "./render.ts";
import { activeTask, state } from "./state.ts";
import { endCall, setMicMuted } from "./voice.ts";

export function isEditableElement(element) {
  if (!(element instanceof HTMLElement)) return false;
  const tag = element.tagName.toLowerCase();
  return tag === "textarea" || tag === "input" || tag === "select" || element.isContentEditable;
}

function shouldRouteKeyToComposer(event) {
  if (!state.snapshot || state.settingsOpen) return false;
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return false;
  if (isEditableElement(event.target)) return false;
  if (event.key.length === 1) return true;
  return ["Enter", "Backspace", "Delete"].includes(event.key);
}

function submitComposer(options = {}) {
  const text = state.composerText;
  state.composerText = "";
  state.completionIndex = 0;
  state.completionHidden = false;
  renderComposerOnly(options);
  void sendMessage(text);
}

export function installComposerRouting() {
  window.addEventListener(
    "pointerdown",
    (event) => {
      if (!state.thinkingMenuOpen) return;
      if (event.target instanceof HTMLElement && event.target.closest(".thinking-wrap")) return;
      state.thinkingMenuOpen = false;
      renderComposerOnly();
    },
    true,
  );
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.ctrlKey && !event.metaKey && !event.altKey && event.key.toLowerCase() === "c" && activeTask()) {
        event.preventDefault();
        void cancelActiveTask();
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

      renderComposerOnly({ focus: true });
    },
    true,
  );
}

function composerTargets(snapshot, text) {
  const knownAgents = new Set((snapshot?.agents ?? []).map((agent) => agent.id));
  const targets = [];
  for (const match of text.matchAll(/@([a-z0-9_-]+)/gi)) {
    const id = match[1];
    if (!knownAgents.has(id) || targets.includes(id)) continue;
    targets.push(id);
  }
  if (targets.length === 0 && snapshot) targets.push(snapshot.workspace.defaultAgent);
  return targets;
}

function composerTargetStatus(snapshot, text) {
  if (!snapshot) return "no room";
  if (text.trimStart().startsWith("/")) return "command mode";
  return composerTargets(snapshot, text).map((target) => `@${target}`).join(", ");
}

// Last non-off level per agent, so the off-toggle can come back to it.
const thinkingReturnLevels = new Map();

async function postThinking(snapshot, agent, level, onCall) {
  try {
    await api(`/api/workspaces/${encodeURIComponent(snapshot.workspace.id)}/agents/${encodeURIComponent(agent.id)}/thinking`, {
      method: "POST",
      body: JSON.stringify({ level }),
    });
    if (onCall) state.voice.thinking = level;
    else agent.thinking = level;
    state.thinkingMenuOpen = false;
    renderComposerOnly();
  } catch (error) {
    setError(error);
  }
}

// Thinking-effort indicator: click toggles between the current level and
// off; right-click opens a menu with all levels. On a call the change is
// call-scoped (reverts on hang-up); otherwise it persists to agent.json.
function ThinkingControl(snapshot, text) {
  if (!snapshot) return null;
  const onCall = Boolean(state.voice);
  const targetId = onCall ? state.voice.agentId : composerTargets(snapshot, text)[0];
  const agent = (snapshot.agents ?? []).find((candidate) => candidate.id === targetId);
  if (!agent) return null;

  const effective = onCall ? (state.voice.thinking ?? agent.thinking ?? "off") : (agent.thinking ?? "off");
  const levels = snapshot.thinkingLevels ?? [];
  if (levels.length === 0) return null;

  const toggle = h("button", {
    type: "button",
    class: "thinking-toggle",
    title: `thinking effort for @${agent.id} - click toggles off, right-click for levels${onCall ? " (this call only)" : ""}`,
    onclick: (event) => {
      event.preventDefault();
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
      renderComposerOnly();
    },
    text: `\u{1F4AD} #${effective}`,
  });

  return h(
    "div",
    { class: "thinking-wrap" },
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

export function Composer() {
  const snapshot = state.snapshot;
  const runningTask = activeTask(snapshot);
  const completion = completionFor(state.composerText);
  const textarea = h("textarea", {
    rows: "1",
    class: "command-input",
    placeholder: !snapshot ? "select a workspace" : state.voice ? `on call with @${state.voice.agentId} - speak, or type` : "message @agent or /command",
    disabled: !snapshot,
    value: state.composerText,
    oninput: () => {
      state.composerText = textarea.value;
      state.completionHidden = false;
      resizeComposer(textarea);
      renderComposerOnly({ focus: true, selectionStart: textarea.selectionStart, selectionEnd: textarea.selectionEnd });
    },
    onpaste: () => requestAnimationFrame(() => resizeComposer(textarea)),
    onkeydown: (event) => {
      if (completion && !state.completionHidden && ["ArrowDown", "ArrowUp", "Tab", "Escape", "Enter"].includes(event.key)) {
        event.preventDefault();
        if (event.key === "ArrowDown") state.completionIndex = (state.completionIndex + 1) % Math.max(1, completion.options.length);
        else if (event.key === "ArrowUp") state.completionIndex = (state.completionIndex - 1 + Math.max(1, completion.options.length)) % Math.max(1, completion.options.length);
        else if (event.key === "Escape") state.completionHidden = true;
        else if (completion.options.length > 0) applyCompletion(completion, completion.options[state.completionIndex] ?? completion.options[0]);
        renderComposerOnly({ focus: true });
        return;
      }

      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        if (runningTask) return;
        submitComposer();
      }
    },
  });
  requestAnimationFrame(() => resizeComposer(textarea));
  const onCall = Boolean(state.voice);
  return h(
    "form",
    {
      class: "composer",
      onsubmit: (event) => {
        event.preventDefault();
        if (runningTask) {
          void cancelActiveTask();
          return;
        }
        submitComposer();
      },
    },
    completion && !state.completionHidden ? Autocomplete(completion) : null,
    h(
      "div",
      { class: "input-shell" },
      textarea,
      h("button", { class: runningTask ? "send-button cancel" : "send-button", disabled: !snapshot, title: runningTask ? "stop agents" : "send", text: runningTask ? "x" : ">" }),
    ),
    h(
      "div",
      { class: "composer-row" },
      h("div", { class: "target-status", text: composerTargetStatus(snapshot, state.composerText) }),
      ThinkingControl(snapshot, state.composerText),
      h("div", { class: "composer-spacer" }),
      onCall
        ? [
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
          ]
        : null,
    ),
  );
}

function completionFor(text) {
  if (!state.snapshot) return null;
  const slash = text.match(/^\/([^\s]*)$/);
  if (slash) {
    const query = slash[1].toLowerCase();
    const options = (state.snapshot.commands ?? [])
      .filter((command) => command.name.toLowerCase().startsWith(query))
      .map((command) => ({ label: command.name, value: `/${command.name}`, description: command.description, suffix: command.name === "role" || command.name === "roles" ? " " : "" }));
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
    .map((agent) => ({ label: agent.id, value: `@${agent.id}`, description: [agent.isDefault ? "default" : "", agent.activeRole ? `role:${agent.activeRole}` : "", agent.modelLabel].filter(Boolean).join(" / "), suffix: " " }));
  state.completionIndex = Math.min(state.completionIndex, Math.max(0, options.length - 1));
  return { kind: "@", start, query, options };
}

function applyCompletion(completion, option) {
  if (!option) return;
  state.composerText = `${state.composerText.slice(0, completion.start)}${option.value}${option.suffix ?? ""}`;
  state.completionIndex = 0;
  state.completionHidden = true;
}

function Autocomplete(completion) {
  const options = completion.options.slice(0, 8);
  return h(
    "div",
    { class: "autocomplete" },
    options.length === 0
      ? h("div", { class: "completion-row empty", text: `${completion.kind}${completion.query}  no matches` })
      : options.map((option, index) =>
          h(
            "button",
            {
              type: "button",
              class: `completion-row ${index === state.completionIndex ? "active" : ""}`,
              onmousedown: (event) => event.preventDefault(),
              onclick: () => {
                applyCompletion(completion, option);
                renderComposerOnly({ focus: true });
              },
            },
            h("span", { text: option.value }),
            h("small", { text: option.description }),
          ),
        ),
  );
}

function resizeComposer(textarea) {
  textarea.style.height = "0px";
  textarea.style.height = `${Math.min(180, Math.max(34, textarea.scrollHeight))}px`;
}

export function focusComposer(selectionStart, selectionEnd) {
  const textarea = document.querySelector(".command-input");
  if (!textarea || textarea.disabled) return;
  textarea.focus();
  const start = selectionStart ?? state.composerText.length;
  const end = selectionEnd ?? start;
  textarea.setSelectionRange(start, end);
  resizeComposer(textarea);
}

export function focusComposerFromBackground(event) {
  if (state.settingsOpen) return;
  if (isEditableElement(event.target)) return;
  if (event.target instanceof HTMLElement && event.target.closest("button")) return;
  focusComposer();
}

export function renderComposerOnly(options = {}) {
  const target = document.querySelector(".composer");
  if (!target) {
    render();
    return;
  }
  const wasComposerFocus = document.activeElement === target.querySelector(".command-input");
  target.replaceWith(Composer());
  if (options.focus || wasComposerFocus) focusComposer(options.selectionStart, options.selectionEnd);
}
