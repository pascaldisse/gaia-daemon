import { h } from "./dom.ts";
import { LinkedText } from "./links.ts";
import { MarkdownMessage } from "./markdown.ts";
import { state } from "./state.ts";

export function Transcript() {
  return TranscriptView(state.snapshot?.room.events ?? [], "transcript");
}

// The room renderer, parameterized so any transcript can reuse it — the main
// room AND a summon's subroom render through the exact same Message().
export function TranscriptView(events, id) {
  return h(
    "section",
    { class: "transcript", id },
    events.length === 0 ? h("div", { class: "empty", text: "no messages" }) : events.map(Message),
  );
}

// Fold a summon's raw AgentEvent stream into the same RoomEvent shape the room
// transcript renders (a user "task" message + the agent's reply with thinking +
// tool activity reconstructed). This is the adapter that lets a summon reuse the
// room renderer instead of a second one.
export function summonTranscript(session, events) {
  const task = {
    id: `${session.id}:task`,
    author: "user",
    targets: [session.agentId],
    text: session.prompt,
    timestamp: session.startedAt,
  };
  const reply = { id: `${session.id}:reply`, author: session.agentId, text: "", timestamp: session.startedAt, _tools: [] };
  const toolsById = new Map();
  let thinking = "";
  for (const event of events ?? []) {
    switch (event.type) {
      case "model-info":
        reply._model = `${event.provider}/${event.modelId}${event.subscription ? " (oauth)" : ""}`;
        break;
      case "text-delta":
        reply.text += event.delta;
        break;
      case "thinking-start":
        reply._thinkingStarted = true;
        break;
      case "thinking-delta":
        reply._thinkingStarted = true;
        thinking += event.delta;
        break;
      case "thinking-end":
        if (event.content) thinking += (thinking ? "\n" : "") + event.content;
        break;
      case "tool-start": {
        const tool = { id: event.toolCallId ?? `t${reply._tools.length}`, toolName: event.toolName, status: "running", args: event.args };
        toolsById.set(tool.id, tool);
        reply._tools.push(tool);
        break;
      }
      case "tool-update": {
        const tool = toolsById.get(event.toolCallId);
        if (tool) tool.partialResult = event.partialResult;
        break;
      }
      case "tool-end": {
        const tool = toolsById.get(event.toolCallId);
        if (tool) {
          tool.status = event.isError ? "error" : "complete";
          tool.result = event.result;
        } else {
          reply._tools.push({ id: event.toolCallId ?? `t${reply._tools.length}`, toolName: event.toolName, status: event.isError ? "error" : "complete", result: event.result });
        }
        break;
      }
    }
  }
  if (thinking) reply._thinking = thinking;
  // Mark the reply as live so the thinking disclosure shows a running spinner.
  if (session.status === "running") reply._streamTaskId = session.id;
  return [task, reply];
}

function Message(event) {
  const isUser = event.author === "user";
  const isAgent = !isUser && event.author !== "system";
  const label = isUser ? `user -> ${(event.targets ?? []).map((target) => `@${target}`).join(", ")}` : `@${event.author}`;
  const text = isUser ? stripLeadingRouteMentions(event.text, event.targets ?? []) : event.text;
  const showThinking = event._thinkingStarted || event._thinking;
  return h(
    "article",
    { class: `message ${isUser ? "user" : "agent"} ${event.author === "system" ? "system" : ""}` },
    h(
      "div",
      { class: "message-meta" },
      h("span", { text: label }),
      event.channel === "voice" ? h("small", { class: "channel-tag", title: "spoken on a voice call", text: "🎙" }) : null,
      event._model ? h("small", { class: "model-tag", text: event._model }) : null,
      h("time", { text: formatTime(event.timestamp) }),
    ),
    showThinking
      ? ActivityDetails(
          {
            id: `thinking:${event._streamTaskId ?? event.id ?? event.timestamp}:${event.author}`,
            className: "thinking",
            status: event._streamTaskId ? "running" : "complete",
            icon: "💭",
            title: "thinking",
          },
          h("pre", {}, event._thinking ? LinkedText(event._thinking) : ""),
        )
      : null,
    event._tools?.length ? ToolActivityList(event._tools) : null,
    text.trim() ? (isAgent || event.author === "system" ? MarkdownMessage(text) : h("pre", {}, LinkedText(text))) : null,
  );
}

function ToolActivityList(tools) {
  return h(
    "div",
    { class: "tool-activity" },
    tools.map((tool) => {
      const presentation = toolPresentation(tool);
      return ActivityDetails(
        { id: `tool:${tool.id}`, className: "tool-call", status: tool.status, icon: presentation.icon, title: presentation.title, extra: presentation.extra },
        ToolPayload("call", { id: tool.id, name: tool.toolName, status: tool.status }),
        ToolPayload("args", tool.args),
        ToolPayload("partial", tool.partialResult),
        ToolPayload("result", tool.result),
      );
    }),
  );
}

function ActivityDetails(options, ...children) {
  const statusText = activityStatusText(options.status);
  const id = options.id ?? `${options.className ?? "activity"}:${options.title ?? ""}:${options.extra ?? ""}`;
  return h(
    "details",
    {
      class: `activity-details ${options.className ?? ""} ${options.status ?? "complete"}`,
      "data-activity-id": id,
      open: state.expandedActivities.has(id),
      ontoggle: (event) => {
        if (event.currentTarget.open) state.expandedActivities.add(id);
        else state.expandedActivities.delete(id);
      },
    },
    h(
      "summary",
      {},
      h("span", { class: "activity-icon", "aria-hidden": "true", text: options.icon ?? "" }),
      h("strong", { class: "activity-title", text: options.title ?? "" }),
      h("small", { class: "activity-extra", text: options.extra ?? "" }),
      h("span", { class: "activity-result", title: statusText, "aria-label": statusText, text: activityResultText(options.status) }),
    ),
    children,
  );
}

function ToolPayload(label, value) {
  if (value === undefined || value === null) return null;
  return h("div", { class: "tool-payload" }, h("span", { text: label }), h("pre", {}, LinkedText(formatPayload(value))));
}

function activityStatusText(status) {
  if (status === "running") return "running";
  if (status === "error") return "error";
  return "complete";
}

function activityResultText(status) {
  if (status === "running") return "";
  if (status === "error") return "x";
  return "✓";
}

function toolPresentation(tool) {
  return {
    icon: "🛠️",
    title: tool.toolName,
    extra: toolSummaryText(tool),
  };
}

function toolSummaryText(tool) {
  const candidates = [
    ...toolSubjectCandidates(tool.args),
    ...toolSubjectCandidates(tool.partialResult),
    ...toolSubjectCandidates(tool.result),
  ];
  return candidates[0]?.summary ?? "";
}

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

function subjectScore(key) {
  const normalized = String(key ?? "").toLowerCase();
  if (["path", "filepath", "file", "filename", "url", "uri", "href", "target"].includes(normalized)) return 100;
  if (["command", "cmd", "query", "pattern", "repo", "repository", "cwd", "name", "id"].includes(normalized)) return 80;
  if (normalized.includes("path") || normalized.includes("file") || normalized.includes("url")) return 90;
  return 10;
}

function compactKey(key) {
  return String(key ?? "")
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase();
}

function compactOneLine(value) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized;
}

function formatPayload(value) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

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

function formatTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
