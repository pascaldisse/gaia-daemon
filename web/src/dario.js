// The Thanks-Dario review popup. A reviewer persona (seeded as @dario on
// DeepSeek, repointable with /model) reads the room's replay window and
// proposes minimal redactions when a provider-side safety classifier keeps
// rerouting the room's model. This module owns the overlay, its API calls,
// and the auto-trigger. Nothing is rewritten without explicit approval here,
// and apply never deletes: originals land in the room's redactions.jsonl.

import { api } from "./api.js";
import { $, h } from "./dom.js";
import { markDirty, registerRegion } from "./render.js";
import { state } from "./state.js";

/** @typedef {import("./types.js").SanitizeProposal} SanitizeProposal */
/** @typedef {import("./types.js").SanitizeSuggestion} SanitizeSuggestion */
/** @typedef {import("./types.js").RoomEvent} RoomEvent */

function roomApiBase() {
  const snapshot = state.snapshot;
  if (!snapshot) return null;
  return `/api/workspaces/${encodeURIComponent(snapshot.workspace.id)}/rooms/${encodeURIComponent(snapshot.room.id)}`;
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error ?? "");
}

export function openDario() {
  state.dario.open = true;
  markDirty("dario");
  if (!state.dario.proposal && !state.dario.loading) void fetchProposal();
}

export function closeDario() {
  state.dario.open = false;
  markDirty("dario");
}

/** Load the last saved proposal (popup re-open, or after a daemon restart). */
async function fetchProposal() {
  const base = roomApiBase();
  if (!base) return;
  state.dario.loading = true;
  state.dario.error = "";
  markDirty("dario");
  try {
    const body = await api(`${base}/sanitize`);
    setProposal(body.proposal ?? null);
  } catch (error) {
    state.dario.error = messageOf(error);
  } finally {
    state.dario.loading = false;
    markDirty("dario");
  }
}

/** Run a fresh review — a real agent turn in a summon room, so it takes a
 * moment. The popup opens immediately in its loading state. */
export function runDario() {
  const base = roomApiBase();
  if (!base || state.dario.loading) return;
  state.dario.open = true;
  state.dario.loading = true;
  state.dario.error = "";
  markDirty("dario");
  void (async () => {
    try {
      const body = await api(`${base}/sanitize`, { method: "POST" });
      setProposal(body.proposal ?? null);
    } catch (error) {
      state.dario.error = messageOf(error);
    } finally {
      state.dario.loading = false;
      markDirty("dario");
    }
  })();
}

/** @param {SanitizeProposal|null} proposal */
function setProposal(proposal) {
  state.dario.proposal = proposal;
  // Default to EVERY suggestion selected — the classifier scores the whole
  // topic, so aggressive coverage is the safe default; the user dials down with
  // the option presets / checkboxes, not up. (Under-editing is the failure mode.)
  state.dario.selected = new Set((proposal?.suggestions ?? []).map((suggestion) => suggestion.id));
  if (proposal?.at) {
    state.dario.knownAt = proposal.at;
    // Whatever proposal the popup is now showing counts as seen for this room,
    // so closing a manually-run review doesn't re-pop it on the next snapshot.
    const roomId = state.snapshot?.room.id;
    if (roomId) seenSanitizeAt.set(roomId, proposal.at);
  }
}

async function applyDario() {
  const base = roomApiBase();
  const proposal = state.dario.proposal;
  if (!base || !proposal) return;
  const chosen = proposal.suggestions.filter((suggestion) => state.dario.selected.has(suggestion.id));
  if (chosen.length === 0) return;
  state.dario.loading = true;
  state.dario.error = "";
  markDirty("dario");
  try {
    await api(`${base}/sanitize/apply`, {
      method: "POST",
      body: JSON.stringify({ edits: chosen.map(({ eventId, quote, replacement }) => ({ eventId, quote, replacement })) }),
    });
    state.dario.open = false;
    state.dario.proposal = { ...proposal, appliedAt: new Date().toISOString() };
  } catch (error) {
    state.dario.error = messageOf(error);
  } finally {
    state.dario.loading = false;
    markDirty("dario");
  }
}

// --- triggers ----------------------------------------------------------------

/**
 * Auto-trigger (mode: /thanks-dario on): a committed reply carrying a model
 * fallback kicks off one review per fallback event. Called from the SSE
 * room-event handler — keyed purely on event data, never on a provider id.
 * @param {RoomEvent} event
 */
export function maybeAutoDario(event) {
  if (!state.snapshot?.room?.thanksDario) return;
  if (event.author === "user" || !("details" in event) || !event.details?.modelFallback) return;
  if (state.dario.lastAutoEventId === event.id || state.dario.open || state.dario.loading) return;
  state.dario.lastAutoEventId = event.id;
  runDario();
}

/** The proposal `at` this tab has already surfaced (or seen applied) PER ROOM.
 * A fresh review then opens the popup exactly once — even when you switch INTO
 * the room after Dario finished (e.g. you ran /thanks-dario, then clicked into
 * the summon sub-room to watch him work, then clicked back) — while a seen or
 * applied proposal never nags on later snapshots. The old single global marker
 * silently swallowed exactly that switch-in case, so a ready proposal showed
 * nothing at all. */
const seenSanitizeAt = new Map();

/**
 * Snapshot-driven trigger: surface an un-applied proposal for the room in view
 * the first time this tab sees it (the user ran /thanks-dario, auto-review
 * fired in a summon room, or another tab reviewed). Keyed per room.
 */
export function syncDarioFromSnapshot() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const roomId = snapshot.room.id;
  const at = snapshot.room.sanitize?.at ?? "";
  const applied = Boolean(snapshot.room.sanitize?.appliedAt);
  const actionable = (snapshot.room.sanitize?.suggestions ?? 0) > 0;
  // Nothing pending, already applied, or nothing to act on: record it so it
  // never pops later. A review that returned no output, didn't parse, or found
  // nothing has 0 suggestions and can never be applied — surfacing it would
  // re-pop the popup on every reload (the seen-marker is per page load).
  if (!at || applied || !actionable) {
    seenSanitizeAt.set(roomId, at);
    state.dario.knownAt = at;
    return;
  }
  // Already surfaced this exact proposal, or a popup is mid-flight: leave it.
  if (seenSanitizeAt.get(roomId) === at || state.dario.open || state.dario.loading) return;
  // Fresh, un-applied, un-seen proposal for the room in view → surface it once.
  // Mark seen BEFORE opening so a failed fetch can't re-open in a loop.
  seenSanitizeAt.set(roomId, at);
  state.dario.knownAt = at;
  state.dario.proposal = null; // stale body — refetch the new one
  openDario();
}

// --- rendering -----------------------------------------------------------------

function renderDario() {
  const slot = $("#overlay-dario");
  if (!slot) return;
  if (!state.dario.open) {
    slot.replaceChildren();
    return;
  }
  slot.replaceChildren(DarioModal());
}

registerRegion("dario", renderDario);

function DarioModal() {
  return h(
    "div",
    {
      class: "modal-backdrop",
      onclick: (/** @type {MouseEvent} */ event) => {
        if (event.target === event.currentTarget) closeDario();
      },
    },
    h(
      "section",
      { class: "modal dario-modal" },
      h(
        "div",
        { class: "panel-head" },
        h("h2", { text: "🎩 Thanks, Dario" }),
        h("button", { onclick: closeDario, text: "x" }),
      ),
      ...ModalBody(),
    ),
  );
}

/** @returns {(HTMLElement|null)[]} */
function ModalBody() {
  const dario = state.dario;
  if (dario.loading) {
    return [
      h("p", { class: "dario-loading", text: "Dario is reviewing the room… (a real agent turn — give him a moment)" }),
      dario.error ? h("p", { class: "dario-error", text: dario.error }) : null,
    ];
  }
  const proposal = dario.proposal;
  if (!proposal) {
    return [
      dario.error ? h("p", { class: "dario-error", text: dario.error }) : null,
      h("p", {
        class: "dario-note",
        text: "No review yet. Dario reads the messages that replay into the next turn and proposes the smallest edits that would stop a safety classifier from rerouting your model.",
      }),
      h("div", { class: "dario-actions" }, h("button", { class: "dario-apply", onclick: runDario, text: "Ask Dario to review now" })),
    ];
  }
  const applied = Boolean(proposal.appliedAt);
  return [
    dario.error ? h("p", { class: "dario-error", text: dario.error }) : null,
    h("p", {
      class: "dario-meta",
      text: `Reviewed ${proposal.window} message${proposal.window === 1 ? "" : "s"} · @${proposal.reviewer} · ${new Date(proposal.at).toLocaleTimeString()}${applied ? " · ✂ applied" : ""}${proposal.discarded ? ` · ${proposal.discarded} suggestion(s) discarded (stale quotes)` : ""}`,
    }),
    proposal.summary ? h("p", { class: "dario-summary", text: proposal.summary }) : null,
    proposal.parseError
      ? h(
          "div",
          { class: "dario-raw" },
          h("p", { class: "dario-error", text: `Dario's reply did not parse as suggestions (${proposal.parseError}). His raw notes:` }),
          h("pre", { text: proposal.raw ?? "(empty reply)" }),
        )
      : null,
    proposal.suggestions.length === 0 && !proposal.parseError
      ? h("p", { class: "dario-note", text: "Dario found nothing that should trip a classifier." })
      : null,
    OptionsRow(proposal),
    ...proposal.suggestions.map((suggestion) => SuggestionRow(suggestion, applied)),
    h("p", {
      class: "dario-note",
      text: "Nothing is deleted: originals are preserved in the room's redactions.jsonl and rewritten messages carry a ✂ tag. Applying resets agent sessions so the next turn replays the sanitized history.",
    }),
    h(
      "div",
      { class: "dario-actions" },
      h("button", { onclick: runDario, text: "Re-review" }),
      h("button", { onclick: closeDario, text: "Not now" }),
      applied || proposal.suggestions.length === 0
        ? null
        : h("button", {
            class: "dario-apply",
            ...(dario.selected.size === 0 ? { disabled: true } : {}),
            onclick: () => void applyDario(),
            text: `Apply ${dario.selected.size} edit${dario.selected.size === 1 ? "" : "s"} & refresh context`,
          }),
    ),
  ];
}

/** @param {SanitizeProposal} proposal @returns {HTMLElement|null} */
function OptionsRow(proposal) {
  if (proposal.suggestions.length === 0) return null;
  const allIds = proposal.suggestions.map((suggestion) => suggestion.id);
  /** @param {string[]} ids */
  const pick = (ids) => {
    state.dario.selected = new Set(ids);
    markDirty("dario");
  };
  /** @param {string[]} ids */
  const isActive = (ids) => ids.length === state.dario.selected.size && ids.every((id) => state.dario.selected.has(id));
  return h(
    "div",
    { class: "dario-options" },
    ...proposal.options.map((option) =>
      h("button", {
        class: `dario-option${isActive(option.suggestionIds) ? " active" : ""}`,
        title: option.description,
        onclick: () => pick(option.suggestionIds),
        text: `${option.label} (${option.suggestionIds.length})`,
      }),
    ),
    h("button", { class: `dario-option${isActive(allIds) ? " active" : ""}`, onclick: () => pick(allIds), text: `All (${allIds.length})` }),
    h("button", { class: `dario-option${state.dario.selected.size === 0 ? " active" : ""}`, onclick: () => pick([]), text: "None" }),
  );
}

/** @param {SanitizeSuggestion} suggestion @param {boolean} applied */
function SuggestionRow(suggestion, applied) {
  const checked = state.dario.selected.has(suggestion.id);
  return h(
    "label",
    { class: "dario-suggestion" },
    applied
      ? null
      : h("input", {
          type: "checkbox",
          ...(checked ? { checked: true } : {}),
          onchange: () => {
            if (checked) state.dario.selected.delete(suggestion.id);
            else state.dario.selected.add(suggestion.id);
            markDirty("dario");
          },
        }),
    h(
      "div",
      { class: "dario-suggestion-body" },
      h("small", {
        class: "dario-who",
        text: `${suggestion.author === "user" ? "you" : `@${suggestion.author}`}${suggestion.whole ? " · full rewrite" : ""}`,
      }),
      h(
        "div",
        { class: `dario-diff${suggestion.whole ? " dario-diff-whole" : ""}` },
        h("span", { class: "dario-old", text: suggestion.quote }),
        h("span", { class: "dario-arrow", text: suggestion.whole ? " ↓ " : " → " }),
        h("span", { class: "dario-new", text: suggestion.replacement }),
      ),
      suggestion.reason ? h("small", { class: "dario-reason", text: suggestion.reason }) : null,
    ),
  );
}
