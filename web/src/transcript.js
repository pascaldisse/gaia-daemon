// Keyed transcript rendering. Every message renders into a node keyed by its
// transcript event id (data-event-id) with a version stamp (data-v):
//   - committed events are immutable → version "c", node built once, reused;
//   - streaming replies (state.streams, keyed by the reserved eventId that v2
//     deltas carry) bump a version per mutation → only that node is rebuilt.
// The container is never replaced, so a delta patches one message instead of
// rebuilding the whole transcript. v1's author+text merge heuristic is gone:
// when the final room-event commits under the same id, the stream entry is
// dropped and the keyed node swaps to the committed version in place.
import { retryMessage } from "./actions.js";
import { api } from "./api.js";
import { beginEditMessage, humanSize } from "./composer.js";
import { $, h } from "./dom.js";
import { LinkedText } from "./links.js";
import { MarkdownMessage } from "./markdown.js";
import { toggleReadAloud } from "./readaloud.js";
import { markDirty, registerRegion, setError } from "./render.js";
import { state } from "./state.js";

/** @typedef {import("./types.js").RoomEvent} RoomEvent */
/** @typedef {import("./types.js").UserRoomEvent} UserRoomEvent */
/** @typedef {import("./types.js").MessageAttachment} MessageAttachment */
/** @typedef {import("./types.js").AgentRoomEvent} AgentRoomEvent */
/** @typedef {import("./types.js").EventDetails} EventDetails */
/** @typedef {import("./types.js").MessageBlock} MessageBlock */
/** @typedef {import("./types.js").ToolDetail} ToolDetail */

/**
 * The normalized shape both committed events and in-flight streams render as.
 * @typedef {Object} MessageView
 * @property {string} id
 * @property {string} version
 * @property {string} timestamp
 * @property {string} author
 * @property {string[]} targets
 * @property {AgentRoomEvent["kind"]} [kind]
 * @property {string} [channel]
 * @property {string} text
 * @property {EventDetails} [details]
 * @property {MessageAttachment[]} [attachments]
 * @property {boolean} [redacted]
 * @property {boolean} streaming
 * @property {boolean} [queued] A not-yet-run queued message (ghost bubble).
 */

/**
 * A system event that confirms a real compaction — "session compacted (…)",
 * "thread compacted by codex.", etc. Excludes the "nothing to compact" no-op.
 * Content heuristic, NOT a harness branch: it only decides how to DISPLAY a
 * legacy event whose structured `kind` predates the compact-boundary marker.
 * @param {string} text
 */
function isCompactionConfirmation(text) {
  return /\bcompacted\b/i.test(text ?? "") && !/nothing to compact/i.test(text ?? "");
}

/** @param {RoomEvent} event @returns {MessageView} */
function viewOfEvent(event) {
  const isUser = event.author === "user";
  const agentEvent = isUser ? undefined : /** @type {AgentRoomEvent} */ (event);
  // The daemon now stamps `kind:"compact-complete"` from the harness's structured
  // signal. Older compaction confirmations have no kind — fall back to content so
  // past compaction points still show a boundary (display-only).
  const kind =
    agentEvent?.kind ?? (event.author === "system" && isCompactionConfirmation(event.text) ? "compact-complete" : undefined);
  return {
    id: event.id,
    version: `${event.redacted ? "c-redacted" : "c"}:${kind ?? ""}`,
    timestamp: event.timestamp,
    author: event.author,
    kind,
    targets: isUser ? (/** @type {UserRoomEvent} */ (event).targets ?? []) : [],
    channel: event.channel,
    text: event.text,
    details: agentEvent?.details,
    attachments: isUser ? /** @type {UserRoomEvent} */ (event).attachments : undefined,
    redacted: event.redacted,
    streaming: false,
  };
}

/**
 * Committed events the client holds: paged-in older history followed by the
 * snapshot's tail window, deduped by id (the windows can overlap after new
 * turns shift the snapshot).
 * @returns {import("./types.js").RoomEvent[]}
 */
function committedEvents() {
  const snapshot = state.snapshot;
  if (!snapshot) return [];
  const older = state.older.roomId === snapshot.room.id ? state.older.events : [];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {import("./types.js").RoomEvent[]} */
  const merged = [];
  for (const event of [...older, ...snapshot.room.events]) {
    if (seen.has(event.id)) continue;
    seen.add(event.id);
    merged.push(event);
  }
  return merged;
}

/** How many committed events exist before the oldest one the client holds. */
function olderRemaining() {
  const snapshot = state.snapshot;
  if (!snapshot) return 0;
  return Math.max(0, snapshot.room.eventTotal - committedEvents().length);
}

/**
 * Reconcile the pager with a fresh snapshot: drop paged-in history when the
 * room changed or the transcript shrank (rewind/truncate/fork) — kept events
 * would otherwise resurrect what the server removed.
 */
export function syncOlderFromSnapshot() {
  const snapshot = state.snapshot;
  if (!snapshot) return;
  const older = state.older;
  if (older.roomId !== snapshot.room.id || snapshot.room.eventTotal < older.lastTotal) {
    state.older = { roomId: snapshot.room.id, events: [], loading: false, lastTotal: snapshot.room.eventTotal };
  } else {
    older.lastTotal = snapshot.room.eventTotal;
  }
}

/** Page one chunk of older committed events in above the current history. */
async function loadOlderEvents() {
  const snapshot = state.snapshot;
  if (!snapshot || state.older.loading) return;
  const oldest = committedEvents()[0];
  if (!oldest) return;
  state.older.loading = true;
  markDirty("transcript");
  const container = $("#transcript");
  const heightBefore = container ? container.scrollHeight : 0;
  try {
    const base = `/api/workspaces/${encodeURIComponent(snapshot.workspace.id)}/rooms/${encodeURIComponent(snapshot.room.id)}/events`;
    const body = await api(`${base}?before=${encodeURIComponent(oldest.id)}&limit=100`);
    /** @type {import("./types.js").RoomEvent[]} */
    const events = body.events ?? [];
    if (state.older.roomId !== snapshot.room.id) state.older = { roomId: snapshot.room.id, events: [], loading: false, lastTotal: snapshot.room.eventTotal };
    const have = new Set(committedEvents().map((event) => event.id));
    state.older.events = [...events.filter((event) => !have.has(event.id)), ...state.older.events];
  } catch (error) {
    setError(error instanceof Error ? error.message : String(error));
  } finally {
    state.older.loading = false;
    markDirty("transcript");
    // Keep the viewport anchored on the message the user was reading: the
    // render runs in its own rAF, so adjust one frame after it.
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        const el = $("#transcript");
        if (el && heightBefore) el.scrollTop += el.scrollHeight - heightBefore;
      }),
    );
  }
}

/**
 * Scroll a committed message into view and flash it — the landing action for a
 * chat-search result. Pages older history in (bounded) until the target event
 * is in the DOM, since a hit can predate the snapshot's tail window. Assumes
 * the correct room is already open.
 * @param {string} eventId
 */
export async function jumpToEvent(eventId) {
  if (!eventId) return;
  const find = () => /** @type {HTMLElement|null} */ ($(`#transcript [data-event-id="${CSS.escape(eventId)}"]`));
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  await frame();
  for (let i = 0; i < 60 && !find(); i += 1) {
    if (olderRemaining() <= 0) break;
    await loadOlderEvents();
    await frame();
  }
  const el = find();
  if (!el) {
    setError("couldn't locate that message — it may have been rewound");
    return;
  }
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  state.search.highlightEventId = eventId;
  markDirty("transcript");
  window.setTimeout(() => {
    if (state.search.highlightEventId !== eventId) return;
    state.search.highlightEventId = "";
    markDirty("transcript");
  }, 2600);
}

/**
 * Creation-time ordering key for a view. Room-event / task ids are
 * `<prefix>_<base36(Date.now())>_<rand>` (see core/ids.ts), so the middle
 * segment is the ms the id was minted. This is stable across a turn's
 * stream→commit because a committed agent event REUSES the id reserved at turn
 * START — its stored `timestamp` is commit time (later), but its id is the
 * reservation time. Ordering by id-time therefore keeps a streaming reply
 * anchored where it began (its text patches in place instead of the row jumping
 * when it commits). A message that COMMITTED mid-turn — a user steer or a summon
 * note — is re-keyed in messageViews so it reads ABOVE that reply rather than
 * below. Falls back to the timestamp for any id not in the minted shape (e.g.
 * imported history).
 * @param {string} id @param {string} timestamp @returns {number}
 */
function creationOrder(id, timestamp) {
  const seg = id.split("_")[1];
  const ms = seg ? Number.parseInt(seg, 36) : Number.NaN;
  if (Number.isFinite(ms)) return ms;
  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** @returns {MessageView[]} */
function messageViews() {
  const events = committedEvents();
  const views = events.map(viewOfEvent);
  const committed = new Set(events.map((event) => event.id));
  for (const stream of state.streams.values()) {
    if (committed.has(stream.id)) continue;
    views.push({
      id: stream.id,
      version: `s${stream.version}`,
      timestamp: stream.startedAt,
      author: stream.author,
      targets: [],
      channel: undefined,
      text: stream.text,
      details: stream.details,
      streaming: true,
    });
  }
  // Queued messages: durable tasks waiting behind the running turn. Show them as
  // ghost user bubbles the moment they're accepted (they aren't committed WAL
  // events yet — the server appends the real user event when the turn runs, and
  // drops the queued task from the snapshot, so the ghost swaps to the committed
  // bubble with no overlap).
  for (const task of state.snapshot?.tasks ?? []) {
    if (task.status !== "queued" || !task.text.trim()) continue;
    // Agent-authored hand-offs / summon callbacks aren't human-typed: their
    // driving text is an agent message or an internal pointer, not a queued
    // user message, so they get no "user →" ghost (the summon result note and
    // the eventual reply are the artifacts).
    if (task.callback) continue;
    views.push({
      id: `queued:${task.id}`,
      version: "queued",
      timestamp: task.startedAt,
      author: "user",
      targets: task.targets ?? [],
      channel: undefined,
      text: task.text,
      streaming: false,
      queued: true,
    });
  }
  // Order by creation time (see creationOrder). Array.sort is stable, so views
  // minted in the same ms keep their append (WAL/commit) order. A no-op for a
  // plain transcript; it only matters for a message that COMMITTED mid-turn,
  // whose late mint would otherwise sink it below the reply whose [start, commit]
  // window it landed in. Two shapes need this, and both must read ABOVE that reply:
  //  - a summon-result NOTE is a worker's OUTPUT the caller's reply reacted to;
  //  - a user STEER is a question the reply then answered (its own late id would
  //    otherwise drop it under the reply, since the reply is anchored at its
  //    earlier turn-start id — the bug this fixes).
  // Re-key each to the start-order of the turn it landed in (turns are serialized,
  // so at most one window matches; a still-streaming reply has no commit yet, so
  // its window is open-ended). It then ties with that reply's key and, having
  // committed first, its lower append index sorts it just above. A plain user
  // message sent BETWEEN turns matches no window and is left exactly where it is;
  // a queued ghost (still waiting to run) is excluded so it stays at the bottom.
  const ranked = views.map((view, index) => ({
    view,
    index,
    order: creationOrder(view.id, view.timestamp),
    commit: Date.parse(view.timestamp),
  }));
  const turns = ranked.filter((r) => r.view.author !== "user" && r.view.author !== "system" && !summonView(r.view));
  for (const item of ranked) {
    const midTurn = Boolean(summonView(item.view)) || (item.view.author === "user" && !item.view.queued);
    if (!midTurn) continue;
    const turn = turns.find(
      (t) => t.order < item.order && (t.view.streaming || !Number.isFinite(t.commit) || item.order <= t.commit),
    );
    if (turn) item.order = turn.order;
  }
  return ranked.sort((a, b) => a.order - b.order || a.index - b.index).map((entry) => entry.view);
}

function renderTranscript() {
  const container = $("#transcript");
  if (!container) return;
  const stick = container.scrollHeight - container.scrollTop - container.clientHeight < 140;

  const views = messageViews();
  if (views.length === 0) {
    container.replaceChildren(h("div", { class: "empty", text: "no messages" }));
    return;
  }

  /** @type {Map<string, HTMLElement>} */
  const existing = new Map();
  for (const child of container.children) {
    const el = /** @type {HTMLElement} */ (child);
    if (el.dataset.eventId) existing.set(el.dataset.eventId, el);
  }

  const nextNodes = views.map((view) => {
    // Read-aloud playback and the search-jump flash both fold into the version
    // stamp, so exactly the affected message re-renders when either toggles.
    const version =
      view.version +
      (state.readAloud?.eventId === view.id ? `:ra-${state.readAloud.phase}` : "") +
      (state.search.highlightEventId === view.id ? ":search-hit" : "");
    const current = existing.get(view.id);
    if (current && current.dataset.v === version) return current;
    const node = Message(view);
    if (state.search.highlightEventId === view.id) node.classList.add("search-hit");
    node.dataset.eventId = view.id;
    node.dataset.v = version;
    return node;
  });

  // "load older" pager above the history, keyed like a message so the sync
  // below keeps it. Only shown while committed events precede what we hold.
  const remaining = olderRemaining();
  if (remaining > 0) {
    const version = `older:${state.older.loading ? "loading" : remaining}`;
    const current = existing.get("__load-older");
    const node =
      current && current.dataset.v === version
        ? current
        : h(
            "div",
            { class: "load-older-row" },
            h("button", {
              type: "button",
              class: "load-older",
              text: state.older.loading ? "loading older messages..." : `↑ load older messages (${remaining.toLocaleString()} more)`,
              ...(state.older.loading ? { disabled: true } : {}),
              onclick: () => void loadOlderEvents(),
            }),
          );
    node.dataset.eventId = "__load-older";
    node.dataset.v = version;
    nextNodes.unshift(node);
  }

  // Keyed sync: drop nodes that are gone, then walk the desired order and
  // insert/move only where the DOM differs.
  const keep = new Set(nextNodes);
  for (const child of [...container.children]) {
    if (!keep.has(/** @type {HTMLElement} */ (child))) child.remove();
  }
  let ref = container.firstChild;
  for (const node of nextNodes) {
    if (node === ref) {
      ref = node.nextSibling;
      continue;
    }
    container.insertBefore(node, ref);
  }

  if (stick) container.scrollTop = container.scrollHeight;
}

registerRegion("transcript", renderTranscript);

/** @param {MessageView} view @returns {HTMLElement} */
function Message(view) {
  if (view.kind === "compact-complete") return CompactBoundary(view);
  const isUser = view.author === "user";
  const isAgent = !isUser && view.author !== "system";
  const label = isUser ? `user -> ${view.targets.map((target) => `@${target}`).join(", ")}` : `@${view.author}`;
  const text = isUser ? stripLeadingRouteMentions(view.text, view.targets) : view.text;
  const details = view.details ?? {};
  // A summon worker's result lands as a collapsed, summon-labeled block (reusing
  // the thinking/tool expander) rather than a wall of agent prose — click to
  // reveal the full run. Redacted results fall back to the plain text path.
  const summon = isAgent && !view.redacted ? summonView(view) : null;
  const showThinking = details.thinkingStarted || details.thinking;
  // Preferred layout: replay the turn's segments in the exact order they
  // streamed (text ↔ thinking ↔ tool), so a reply reads like it did live
  // instead of the flattened thinking→tools→text buckets. Falls back to the
  // buckets for events committed before `blocks` existed, and for redacted
  // events (whose sanitized text lives only in `view.text`, not the blocks).
  const orderedBlocks = isAgent && !view.redacted && details.blocks?.length ? details.blocks : null;
  // Claude.ai-style fork actions: ✎ edits a user message, ⟳ regenerates a
  // reply. Both rewind the room to that point (rewound.jsonl keeps the rest).
  // A queued ghost isn't a committed event yet, so it can't be forked.
  const canFork = !view.streaming && !view.queued && view.author !== "system";
  // The action row lives at the FOOT of the message (Claude-style), not the meta
  // header — on a long reply the buttons should sit where the reader ends up, not
  // scrolled far above. Built here, appended after the body below.
  const actions = [
    canFork && isUser
      ? h("button", {
          type: "button",
          class: "msg-action",
          title: "edit & re-send from here — later replies are rewound",
          text: "✎",
          onclick: () => beginEditMessage(view.id, view.text),
        })
      : null,
    canFork && !isUser
      ? h("button", {
          type: "button",
          class: "msg-action",
          title: "retry — regenerate from the message that produced this reply",
          text: "⟳",
          onclick: () => void retryMessage(view.id),
        })
      : null,
    isAgent && !view.streaming ? ReadAloudButton(view.id) : null,
  ].filter(Boolean);
  return h(
    "article",
    { class: `message ${isUser ? "user" : "agent"} ${view.author === "system" ? "system" : ""} ${view.queued ? "queued" : ""}` },
    h(
      "div",
      { class: "message-meta" },
      h("span", { text: label }),
      view.queued ? h("small", { class: "channel-tag", title: "queued — runs after the current turn", text: "queued" }) : null,
      view.channel === "voice" ? h("small", { class: "channel-tag", title: "spoken on a voice call", text: "🎙" }) : null,
      details.model ? h("small", { class: "model-tag", text: details.model }) : null,
      details.modelFallback
        ? h("small", {
            class: "model-tag fallback",
            title: details.modelFallback.reason,
            text: `⚠ ${details.modelFallback.from} → ${details.modelFallback.to}`,
          })
        : null,
      view.redacted
        ? h("small", {
            class: "redacted-tag",
            title: "sanitized by thanks-dario — the original text is preserved in the room's redactions.jsonl",
            text: "✂",
          })
        : null,
      h("time", { text: formatTime(view.timestamp) }),
    ),
    // A summon result is a single collapsed block; everything else renders the
    // normal ordered/bucketed body.
    summon ? SummonResultActivity(view, summon) : null,
    summon || !orderedBlocks ? null : OrderedBlocks(view, orderedBlocks, details.tools ?? []),
    summon || orderedBlocks || !showThinking
      ? null
      : ThinkingActivity(`thinking:${view.id}`, details.thinking ?? "", Boolean(view.streaming)),
    summon || orderedBlocks ? null : details.tools?.length ? ToolActivityList(details.tools) : null,
    view.attachments?.length ? AttachmentGallery(view.attachments) : null,
    summon || orderedBlocks ? null : text.trim() ? (isAgent || view.author === "system" ? MarkdownMessage(text) : h("pre", {}, LinkedText(text))) : null,
    actions.length ? h("div", { class: "message-actions" }, actions) : null,
  );
}

/** @param {MessageView} view @returns {HTMLElement} */
function CompactBoundary(view) {
  const tokens = compactTokensBefore(view.text);
  const detail = tokens ? `${formatTokenCount(tokens)} tokens before` : "context compacted";
  return h(
    "div",
    {
      class: "compact-boundary",
      role: "separator",
      title: view.text,
      "aria-label": `Context compacted${tokens ? `, ${tokens.toLocaleString()} tokens before` : ""}`,
    },
    h(
      "span",
      { class: "compact-boundary-pill" },
      h("span", { class: "compact-boundary-icon", text: "✂" }),
      h("span", { text: "Context compacted" }),
      h("small", { text: detail }),
    ),
    h("time", { text: formatTime(view.timestamp) }),
  );
}

/** @param {string} text @returns {number|undefined} */
function compactTokensBefore(text) {
  const match = text.match(/\((\d[\d,._ ]*)\s+tokens?\s+before\)/iu);
  if (!match) return undefined;
  const tokens = Number.parseInt(match[1].replace(/[^\d]/g, ""), 10);
  return Number.isFinite(tokens) ? tokens : undefined;
}

/** @param {number} tokens @returns {string} */
function formatTokenCount(tokens) {
  if (tokens < 1000) return tokens.toLocaleString();
  if (tokens < 1_000_000) return `${Math.round(tokens / 1000).toLocaleString()}k`;
  return `${(tokens / 1_000_000).toFixed(tokens < 10_000_000 ? 1 : 0)}M`;
}

/**
 * Recognize a summon worker's result — the new metadata form
 * (details.summonResult, body is the whole text) or the LEGACY form where the
 * "↩︎ Summon '…' finished." header was baked into the message text before the
 * metadata existed. Either way returns the child room, outcome, and the body to
 * reveal. Non-summon agent messages return null.
 * @param {MessageView} view
 * @returns {{ childRoomId: string, failed: boolean, body: string } | null}
 */
function summonView(view) {
  const meta = view.details?.summonResult;
  if (meta) return { childRoomId: meta.childRoomId, failed: meta.failed, body: view.text };
  const header = view.text.match(/^(?:↩︎|⚠️)\s*Summon '([^']+)' (finished|FAILED)/u);
  if (!header) return null;
  // Strip the header line (and the blank line after it) for the collapsed body.
  const body = view.text.replace(/^[^\n]*\n\n?/u, "").trim();
  return { childRoomId: header[1], failed: header[2] === "FAILED", body };
}

/**
 * A summon worker's result as a collapsed expander (reusing ActivityDetails, so
 * it behaves exactly like a thinking/tool block — collapsed by default, opens on
 * click, open state persists across re-renders). The header names the child room
 * and its outcome; the body is the worker's full reply.
 * @param {MessageView} view
 * @param {{ childRoomId: string, failed: boolean, body: string }} summon
 */
function SummonResultActivity(view, summon) {
  return ActivityDetails(
    {
      id: `summon:${view.id}`,
      className: "summon-result",
      status: summon.failed ? "error" : "complete",
      icon: summon.failed ? "⚠️" : "↩︎",
      title: `summon ${summon.childRoomId}`,
      extra: summon.failed ? "failed" : "finished",
    },
    summon.body.trim() ? MarkdownMessage(summon.body) : h("pre", {}, "(no output)"),
  );
}

/**
 * Render the ordered block timeline: prose, thinking, and tool calls exactly
 * where they occurred in the turn. Thinking and tools reuse the same collapsible
 * activity element as the bucketed layout — a turn can think more than once, so
 * each thinking span is its own expander. Tool blocks reference `tools[]` by id.
 * @param {MessageView} view
 * @param {MessageBlock[]} blocks
 * @param {ToolDetail[]} tools
 */
function OrderedBlocks(view, blocks, tools) {
  const toolsById = new Map(tools.map((tool) => [tool.id, tool]));
  const lastIndex = blocks.length - 1;
  return blocks.map((block, index) => {
    if (block.kind === "text") return block.text.trim() ? MarkdownMessage(block.text) : null;
    if (block.kind === "thinking") {
      // A thinking span still filling in is the running one; an empty span that
      // isn't currently streaming carries nothing to show.
      const running = Boolean(view.streaming) && index === lastIndex;
      if (!block.text.trim() && !running) return null;
      return ThinkingActivity(`thinking:${view.id}:${index}`, block.text, running);
    }
    const tool = toolsById.get(block.id);
    return tool ? ToolActivity(tool) : null;
  });
}

/**
 * The collapsible "thinking" expander, reused by both layouts (and, in the
 * ordered layout, once per thinking span in the turn).
 * @param {string} id @param {string} text @param {boolean} running
 */
function ThinkingActivity(id, text, running) {
  return ActivityDetails(
    { id, className: "thinking", status: running ? "running" : "complete", icon: "💭", title: "thinking" },
    h("pre", {}, text ? LinkedText(text) : ""),
  );
}

/**
 * Attached files on a user message: image thumbnails inline (click opens the
 * full file, served from the room's files dir), other files as download chips.
 * @param {MessageAttachment[]} attachments
 */
function AttachmentGallery(attachments) {
  return h(
    "div",
    { class: "msg-attachments" },
    attachments.map((file) => {
      const url = attachmentUrl(file);
      if (file.mime.startsWith("image/")) {
        return h(
          "a",
          { class: "attachment-link", href: url, target: "_blank", rel: "noopener", title: `${file.name} (${humanSize(file.size)})` },
          h("img", { class: "attachment-image", src: url, alt: file.name, loading: "lazy" }),
        );
      }
      return h(
        "a",
        { class: "attachment-chip", href: url, target: "_blank", rel: "noopener", title: file.path },
        h("span", { text: "📎" }),
        h("span", { class: "attach-name", text: file.name }),
        h("small", { text: humanSize(file.size) }),
      );
    }),
  );
}

/**
 * Serve URL for a committed attachment: the on-disk id (path basename) under
 * the current room's files route.
 * @param {MessageAttachment} file
 */
function attachmentUrl(file) {
  const snapshot = state.snapshot;
  if (!snapshot) return "#";
  const id = file.path.split("/").pop() ?? "";
  return `/api/workspaces/${encodeURIComponent(snapshot.workspace.id)}/rooms/${encodeURIComponent(snapshot.room.id)}/files/${encodeURIComponent(id)}`;
}

/**
 * Play/stop toggle for reading one agent message aloud with the author's TTS
 * voice (the server strips markdown and never speaks tool calls).
 * @param {string} eventId
 */
function ReadAloudButton(eventId) {
  const active = state.readAloud?.eventId === eventId ? state.readAloud : null;
  const phase = active?.phase;
  // ◌ loading (click cancels) · ⏸ playing (click pauses) · ▶ idle/paused/ended
  // (click starts / resumes / replays). The seekable player above the composer
  // carries the timeline; this button is the quick play/pause.
  const icon = !phase ? "▶" : phase === "loading" ? "◌" : phase === "playing" ? "⏸" : "▶";
  const title = !phase
    ? "read this message aloud"
    : phase === "loading"
      ? "generating audio... — click to cancel"
      : phase === "playing"
        ? "pause"
        : phase === "ended"
          ? "replay"
          : "resume";
  return h("button", {
    type: "button",
    class: `msg-action read-aloud ${active ? `ra-${phase}` : ""}`,
    title,
    text: icon,
    onclick: () => toggleReadAloud(eventId),
  });
}

/** @param {ToolDetail[]} tools */
function ToolActivityList(tools) {
  return h("div", { class: "tool-activity" }, tools.map(ToolActivity));
}

/**
 * One tool-call expander. Reused by the bucketed list and by the ordered
 * layout, where a single tool sits inline between prose blocks.
 * @param {ToolDetail} tool
 */
function ToolActivity(tool) {
  return ActivityDetails(
    { id: `tool:${tool.id}`, className: "tool-call", status: tool.status, icon: "🛠️", title: tool.toolName, extra: toolSummaryText(tool) },
    ToolPayload("call", { id: tool.id, name: tool.toolName, status: tool.status }),
    ToolPayload("args", tool.args),
    ToolPayload("partial", tool.partialResult),
    ToolPayload("result", tool.result),
  );
}

/**
 * Collapsible activity block (thinking, tool calls). Open state lives in
 * state.expandedActivities keyed by a STABLE id — for streams the id carries
 * over to the committed event, so an expander stays open across the commit.
 * @param {{ id: string, className?: string, status?: string, icon?: string, title?: string, extra?: string }} options
 * @param {...(Node|null)} children
 */
function ActivityDetails(options, ...children) {
  const statusText = options.status === "running" ? "running" : options.status === "error" ? "error" : "complete";
  const id = options.id;
  return h(
    "details",
    {
      class: `activity-details ${options.className ?? ""} ${options.status ?? "complete"}`,
      "data-activity-id": id,
      open: state.expandedActivities.has(id),
      ontoggle: (event) => {
        const el = /** @type {HTMLDetailsElement} */ (event.currentTarget);
        if (el.open) state.expandedActivities.add(id);
        else state.expandedActivities.delete(id);
      },
    },
    h(
      "summary",
      {},
      h("span", { class: "activity-icon", "aria-hidden": "true", text: options.icon ?? "" }),
      h("strong", { class: "activity-title", text: options.title ?? "" }),
      h("small", { class: "activity-extra", text: options.extra ?? "" }),
      h("span", {
        class: "activity-result",
        title: statusText,
        "aria-label": statusText,
        text: options.status === "running" ? "" : options.status === "error" ? "x" : "✓",
      }),
    ),
    children,
  );
}

/** @param {string} label @param {unknown} value */
function ToolPayload(label, value) {
  if (value === undefined || value === null) return null;
  return h("div", { class: "tool-payload" }, h("span", { text: label }), h("pre", {}, LinkedText(formatPayload(value))));
}

// --- Tool one-line summaries: pick the most subject-like string from the
// args/results so a collapsed tool row still says what it acted on. ----------

/** @param {ToolDetail} tool */
function toolSummaryText(tool) {
  const candidates = [
    ...toolSubjectCandidates(tool.args),
    ...toolSubjectCandidates(tool.partialResult),
    ...toolSubjectCandidates(tool.result),
  ];
  return candidates[0]?.summary ?? "";
}

/**
 * @param {unknown} value
 * @param {string[]} [path]
 * @param {number} [depth]
 * @returns {{ score: number, summary: string }[]}
 */
function toolSubjectCandidates(value, path = [], depth = 0) {
  if (value === undefined || value === null || depth > 3) return [];
  if (typeof value === "string") {
    const summary = compactOneLine(value);
    return summary ? [{ score: path.length ? subjectScore(path.at(-1)) : 0, summary }] : [];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    const key = path.at(-1);
    const summary = key ? `${key}: ${String(value)}` : String(value);
    return [{ score: subjectScore(key), summary }];
  }
  if (Array.isArray(value)) {
    return value.slice(0, 4).flatMap((item, index) => toolSubjectCandidates(item, [...path, String(index)], depth + 1));
  }
  if (typeof value !== "object") return [];

  return Object.entries(value)
    .flatMap(([key, nested]) => {
      const nextPath = [...path, key];
      const label = compactKey(key);
      if (typeof nested === "string") {
        const body = compactOneLine(nested);
        if (!body) return [];
        return [{ score: subjectScore(key), summary: subjectScore(key) >= 80 ? body : `${label}: ${body}` }];
      }
      if (typeof nested === "number" || typeof nested === "boolean") {
        return [{ score: subjectScore(key), summary: `${label}: ${String(nested)}` }];
      }
      return toolSubjectCandidates(nested, nextPath, depth + 1);
    })
    .sort((left, right) => right.score - left.score);
}

/** @param {string|undefined} key */
function subjectScore(key) {
  const normalized = String(key ?? "").toLowerCase();
  if (["path", "filepath", "file", "filename", "url", "uri", "href", "target"].includes(normalized)) return 100;
  if (["command", "cmd", "query", "pattern", "repo", "repository", "cwd", "name", "id"].includes(normalized)) return 80;
  if (normalized.includes("path") || normalized.includes("file") || normalized.includes("url")) return 90;
  return 10;
}

/** @param {string} key */
function compactKey(key) {
  return String(key ?? "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

/** @param {unknown} value */
function compactOneLine(value) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized;
}

/** @param {unknown} value */
function formatPayload(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

/**
 * User messages start with the routing mentions; the label already shows the
 * targets, so strip them from the body.
 * @param {string} text
 * @param {string[]} targets
 */
function stripLeadingRouteMentions(text, targets) {
  let remaining = String(text ?? "").trimStart();
  const targetSet = new Set(targets ?? []);

  while (true) {
    const match = remaining.match(/^@([a-z0-9_-]+)\b[,\s]*/i);
    if (!match) break;
    const target = match[1];
    if (targetSet.size > 0 && !targetSet.has(target)) break;
    remaining = remaining.slice(match[0].length).trimStart();
  }

  return remaining;
}

/** @param {string} value */
function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
