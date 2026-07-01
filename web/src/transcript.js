// Keyed transcript rendering. Every message renders into a node keyed by its
// transcript event id (data-event-id) with a version stamp (data-v):
//   - committed events are immutable → version "c", node built once, reused;
//   - streaming replies (state.streams, keyed by the reserved eventId that v2
//     deltas carry) bump a version per mutation → only that node is rebuilt.
// The container is never replaced, so a delta patches one message instead of
// rebuilding the whole transcript. v1's author+text merge heuristic is gone:
// when the final room-event commits under the same id, the stream entry is
// dropped and the keyed node swaps to the committed version in place.
import { $, h } from "./dom.js";
import { LinkedText } from "./links.js";
import { MarkdownMessage } from "./markdown.js";
import { registerRegion } from "./render.js";
import { state } from "./state.js";

/** @typedef {import("./types.js").RoomEvent} RoomEvent */
/** @typedef {import("./types.js").UserRoomEvent} UserRoomEvent */
/** @typedef {import("./types.js").AgentRoomEvent} AgentRoomEvent */
/** @typedef {import("./types.js").EventDetails} EventDetails */
/** @typedef {import("./types.js").ToolDetail} ToolDetail */

/**
 * The normalized shape both committed events and in-flight streams render as.
 * @typedef {Object} MessageView
 * @property {string} id
 * @property {string} version
 * @property {string} timestamp
 * @property {string} author
 * @property {string[]} targets
 * @property {string} [channel]
 * @property {string} text
 * @property {EventDetails} [details]
 * @property {boolean} streaming
 */

/** @param {RoomEvent} event @returns {MessageView} */
function viewOfEvent(event) {
  const isUser = event.author === "user";
  return {
    id: event.id,
    version: "c",
    timestamp: event.timestamp,
    author: event.author,
    targets: isUser ? (/** @type {UserRoomEvent} */ (event).targets ?? []) : [],
    channel: event.channel,
    text: event.text,
    details: isUser ? undefined : /** @type {AgentRoomEvent} */ (event).details,
    streaming: false,
  };
}

/** @returns {MessageView[]} */
function messageViews() {
  const events = state.snapshot?.room.events ?? [];
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
  return views;
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
    const current = existing.get(view.id);
    if (current && current.dataset.v === view.version) return current;
    const node = Message(view);
    node.dataset.eventId = view.id;
    node.dataset.v = view.version;
    return node;
  });

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
  const isUser = view.author === "user";
  const isAgent = !isUser && view.author !== "system";
  const label = isUser ? `user -> ${view.targets.map((target) => `@${target}`).join(", ")}` : `@${view.author}`;
  const text = isUser ? stripLeadingRouteMentions(view.text, view.targets) : view.text;
  const details = view.details ?? {};
  const showThinking = details.thinkingStarted || details.thinking;
  return h(
    "article",
    { class: `message ${isUser ? "user" : "agent"} ${view.author === "system" ? "system" : ""}` },
    h(
      "div",
      { class: "message-meta" },
      h("span", { text: label }),
      view.channel === "voice" ? h("small", { class: "channel-tag", title: "spoken on a voice call", text: "🎙" }) : null,
      details.model ? h("small", { class: "model-tag", text: details.model }) : null,
      h("time", { text: formatTime(view.timestamp) }),
    ),
    showThinking
      ? ActivityDetails(
          {
            id: `thinking:${view.id}`,
            className: "thinking",
            status: view.streaming ? "running" : "complete",
            icon: "💭",
            title: "thinking",
          },
          h("pre", {}, details.thinking ? LinkedText(details.thinking) : ""),
        )
      : null,
    details.tools?.length ? ToolActivityList(details.tools) : null,
    text.trim() ? (isAgent || view.author === "system" ? MarkdownMessage(text) : h("pre", {}, LinkedText(text))) : null,
  );
}

/** @param {ToolDetail[]} tools */
function ToolActivityList(tools) {
  return h(
    "div",
    { class: "tool-activity" },
    tools.map((tool) =>
      ActivityDetails(
        { id: `tool:${tool.id}`, className: "tool-call", status: tool.status, icon: "🛠️", title: tool.toolName, extra: toolSummaryText(tool) },
        ToolPayload("call", { id: tool.id, name: tool.toolName, status: tool.status }),
        ToolPayload("args", tool.args),
        ToolPayload("partial", tool.partialResult),
        ToolPayload("result", tool.result),
      ),
    ),
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
