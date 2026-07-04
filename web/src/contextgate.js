// The context-gate modal. When a NEW agent is addressed in a room whose
// transcript would blow past the warn threshold on its first load, the daemon
// holds that turn and puts a pending decision on snapshot.room.contextGate. This
// module renders the blocking choice — full / last-N / compact — and POSTs it.
//
// It is purely snapshot-driven: the gate is present until resolved, so there is
// no local open/close flag. Resolving clears the gate server-side, which pushes
// a fresh snapshot and the modal disappears. The compaction affects ONLY the
// joining agent's first seed — never the transcript or any other agent.

import { api } from "./api.js";
import { $, h } from "./dom.js";
import { markDirty, registerRegion } from "./render.js";
import { state } from "./state.js";

/** @typedef {import("./types.js").ContextGatePending} ContextGatePending */

function roomApiBase() {
  const snapshot = state.snapshot;
  if (!snapshot) return null;
  return `/api/workspaces/${encodeURIComponent(snapshot.workspace.id)}/rooms/${encodeURIComponent(snapshot.room.id)}`;
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error ?? "");
}

/**
 * @param {"full"|"last"|"compact"} choice
 * @param {number} [n]
 */
async function resolve(choice, n) {
  const base = roomApiBase();
  if (!base || state.contextGate.resolving) return;
  state.contextGate.resolving = true;
  state.contextGate.error = "";
  markDirty("contextgate");
  try {
    await api(`${base}/context-gate`, { method: "POST", body: JSON.stringify({ choice, ...(n ? { n } : {}) }) });
    // The daemon clears the gate and pushes a new snapshot → the modal closes.
  } catch (error) {
    state.contextGate.error = messageOf(error);
  } finally {
    state.contextGate.resolving = false;
    markDirty("contextgate");
  }
}

// --- rendering -----------------------------------------------------------------

function renderContextGate() {
  const slot = $("#overlay-contextgate");
  if (!slot) return;
  const gate = state.snapshot?.room?.contextGate;
  if (!gate) {
    slot.replaceChildren();
    return;
  }
  slot.replaceChildren(ContextGateModal(gate));
}

registerRegion("contextgate", renderContextGate);

/** @param {ContextGatePending} gate */
function ContextGateModal(gate) {
  const busy = state.contextGate.resolving;
  const percent = gate.window ? Math.round((gate.estTokens / gate.window) * 100) : null;
  const size = `~${gate.estTokens.toLocaleString()} tokens`;
  const ofWindow = gate.window ? ` — ${percent}% of @${gate.agentId}'s ${gate.window.toLocaleString()}-token window` : " (window size unknown until its first turn)";
  // Same choice, two stories: a NEW agent's first seed vs an EXISTING agent
  // whose harness session vanished (its history must be reloaded, not skipped).
  const sessionLost = gate.reason === "session-lost";
  const heading = sessionLost ? `🧠 Session lost — how much should @${gate.agentId} reload?` : `🧠 Big room — how much should @${gate.agentId} load?`;
  const lead = sessionLost
    ? `@${gate.agentId}'s harness session for this room is gone, so its memory of the conversation now lives only in the transcript (${size}${ofWindow}). Rather than silently continuing mid-stream, pick how much history to reload — this affects only @${gate.agentId}; every other agent and the transcript stay unchanged.`
    : `@${gate.agentId} is joining a conversation carrying ${size}${ofWindow}. Its prompt cache is empty, so all of it loads on the first turn. Pick how much history to give it — this affects only @${gate.agentId}; every other agent and the transcript stay unchanged.`;

  return h(
    "div",
    { class: "modal-backdrop" },
    h(
      "section",
      { class: "modal contextgate-modal" },
      h("div", { class: "panel-head" }, h("h2", { text: heading })),
      h("p", {
        class: "contextgate-lead",
        text: lead,
      }),
      state.contextGate.error ? h("p", { class: "contextgate-error", text: state.contextGate.error }) : null,
      h(
        "div",
        { class: "contextgate-options" },
        Option(
          "Compact it first",
          "One summary pass (its own model) distills the room, then it starts from that brief.",
          h("button", { class: "contextgate-btn primary", disabled: busy, onclick: () => void resolve("compact"), text: busy ? "Working…" : "Compact & join" }),
        ),
        Option(
          "Last messages only",
          "Skip the older history; load just the most recent messages verbatim.",
          h(
            "div",
            { class: "contextgate-last" },
            h("input", {
              type: "number",
              min: "1",
              class: "contextgate-n",
              value: String(state.contextGate.lastN),
              disabled: busy,
              oninput: (/** @type {Event} */ event) => {
                const value = Number(/** @type {HTMLInputElement} */ (event.target).value);
                if (Number.isFinite(value) && value > 0) state.contextGate.lastN = Math.floor(value);
              },
            }),
            h("button", { class: "contextgate-btn", disabled: busy, onclick: () => void resolve("last", state.contextGate.lastN), text: "Load last N" }),
          ),
        ),
        Option(
          "Full transcript",
          "Load everything. Most complete, but uses the most of its window up front.",
          h("button", { class: "contextgate-btn", disabled: busy, onclick: () => void resolve("full"), text: "Load full" }),
        ),
      ),
    ),
  );
}

/**
 * @param {string} title
 * @param {string} blurb
 * @param {HTMLElement} action
 */
function Option(title, blurb, action) {
  return h(
    "div",
    { class: "contextgate-option" },
    h("div", { class: "contextgate-option-text" }, h("strong", { text: title }), h("span", { text: blurb })),
    action,
  );
}
