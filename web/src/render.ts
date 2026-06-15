import { addRoom, addWorkspace, loadWorkspace, selectRoom } from "./actions.ts";
import { cancelSummon, fetchSummon } from "./api.ts";
import { Composer, focusComposer } from "./composer.ts";
import { h } from "./dom.ts";
import { LinkedText, PathText } from "./links.ts";
import { openAgentSettings, SettingsModal, WorkspacePanel } from "./settings.ts";
import { state } from "./state.ts";
import { Transcript } from "./transcript.ts";
import { toggleCall } from "./voice.ts";

export function setError(error) {
  state.error = error instanceof Error ? error.message : String(error ?? "");
  render();
}

function App() {
  return h(
    "div",
    { class: "shell" },
    Sidebar(),
    h("main", { class: "main" }, Topbar(), h("div", { class: "main-stack" }, state.error ? h("div", { class: "error", text: state.error }) : null, Transcript()), Composer()),
    h("aside", { class: "right" }, RoomPanel(), WorkspacePanel()),
    SummonDrawer(),
    state.settingsOpen ? SettingsModal() : null,
  );
}

function Sidebar() {
  const workspaces = state.workspaces;
  const current = state.snapshot?.workspace.id;
  return h(
    "nav",
    { class: "sidebar" },
    h("div", { class: "brand" }, h("span", { text: "GAIA" }), h("small", { text: "local room" })),
    h("div", { class: "nav-title", text: "workspaces" }),
    h(
      "div",
      { class: "workspace-list" },
      workspaces.map((workspace) =>
        h(
          "button",
          {
            class: `nav-item ${workspace.id === current ? "active" : ""} ${workspace.isInitialized ? "" : "muted"}`,
            onclick: () => (workspace.isInitialized ? loadWorkspace(workspace.id) : setError(`Missing .gaia workspace: ${workspace.path}`)),
          },
          h("span", { text: workspace.name }),
          h("small", {}, PathText(workspace.path)),
        ),
      ),
    ),
    h("button", { class: "nav-action", onclick: addWorkspace, text: "+ add workspace" }),
    h("div", { class: "nav-title", text: "rooms" }),
    (state.snapshot?.rooms ?? [{ id: "no room", path: "select a workspace", isCurrent: true }]).map((room) =>
      h(
        "button",
        {
          class: `nav-item ${room.isCurrent ? "active" : ""}`,
          onclick: room.isCurrent || !state.snapshot ? undefined : () => selectRoom(state.snapshot.workspace.id, room.id),
        },
        h("span", { text: room.id }),
        h("small", {}, PathText(room.path)),
      ),
    ),
    state.snapshot ? h("button", { class: "nav-action", onclick: addRoom, text: "+ add room" }) : null,
    h("div", { class: "spacer" }),
    h("button", { class: "nav-action", onclick: () => ((state.settingsOpen = true), render()), text: "global settings" }),
  );
}

function Topbar() {
  const snapshot = state.snapshot;
  return h(
    "header",
    { class: "topbar" },
    h(
      "div",
      {},
      h("strong", {}, snapshot ? PathText(snapshot.workspace.rootDir) : LinkedText("No workspace selected")),
      h("small", {}, snapshot ? PathText(snapshot.workspace.configPath) : LinkedText("Add an initialized workspace to begin.")),
    ),
    h("div", {
      class: state.voice || state.voiceStatusText ? "status on-call" : "status",
      text: state.voiceStatusText
        ? state.voiceStatusText
        : snapshot
          ? `${state.voice ? `on call:@${state.voice.agentId} ` : ""}room:${snapshot.room.id} default:@${snapshot.workspace.defaultAgent}`
          : "idle",
    }),
  );
}

function RoomPanel() {
  const snapshot = state.snapshot;
  const agents = snapshot?.agents ?? [];
  const tasks = snapshot?.tasks ?? [];
  const summons = snapshot?.summons ?? [];
  return h(
    "section",
    { class: "panel" },
    h("div", { class: "panel-head" }, h("h2", { text: "Room" }), h("small", {}, snapshot?.room.statePath ? PathText(snapshot.room.statePath) : LinkedText("no room"))),
    h("h3", { text: "agents" }),
    h(
      "div",
      { class: "agent-list" },
      agents.map((agent) => {
        const onCall = state.voice?.agentId === agent.id;
        const connecting = state.voicePendingAgentId === agent.id;
        return h(
          "div",
          { class: `agent-row ${onCall ? "on-call" : ""}` },
          h(
            "button",
            { class: "agent-main", title: `open @${agent.id} settings`, onclick: () => void openAgentSettings(agent.id) },
            h("span", { class: `dot ${agent.status}` }),
            h("strong", { text: `${agent.icon} @${agent.id}` }),
            h("small", {
              text: [agent.isDefault ? "default" : "", agent.activeRole ? `role:${agent.activeRole}` : "", agent.voice ? `voice:${agent.voice}` : "", agent.modelLabel]
                .filter(Boolean)
                .join(" / "),
            }),
          ),
          h("button", {
            class: `call-button ${onCall ? "active" : ""}`,
            title: onCall ? `hang up @${agent.id}` : `start voice call with @${agent.id}`,
            disabled: connecting || (Boolean(state.voice) && !onCall),
            onclick: () => void toggleCall(agent.id),
            text: connecting ? "..." : onCall ? "⏹" : "📞",
          }),
        );
      }),
    ),
    h("h3", { text: "summons" }),
    h(
      "div",
      { class: "summon-list" },
      summons.length === 0
        ? h("div", { class: "empty", text: "no summons" })
        : summons.slice(0, 8).map((summon) =>
            h(
              "button",
              {
                class: `summon-row ${summon.status} ${state.selectedSummonId === summon.id ? "active" : ""}`,
                onclick: () => void openSummon(summon),
              },
              h("span", { text: summon.status }),
              h("strong", { text: `@${summon.agentId}` }),
              h("small", { text: summon.prompt }),
            ),
          ),
    ),
    h("h3", { text: "tasks" }),
    h(
      "div",
      { class: "task-list" },
      tasks.length === 0
        ? h("div", { class: "empty", text: "no tasks" })
        : tasks.slice(-5).map((task) => h("div", { class: `task ${task.status}` }, h("span", { text: task.status }), h("small", { text: task.text }))),
    ),
  );
}

async function openSummon(summon) {
  state.selectedSummonId = summon.id;
  state.selectedSummon = { session: summon, events: [], result: summon.summary ?? "" };
  render();
  try {
    state.selectedSummon = await fetchSummon(summon.id);
    render();
  } catch (error) {
    setError(error);
  }
}

function SummonDrawer() {
  const selectedId = state.selectedSummonId;
  if (!selectedId) return null;
  const fallback = state.snapshot?.summons?.find((summon) => summon.id === selectedId);
  const details = state.selectedSummon?.session?.id === selectedId ? state.selectedSummon : null;
  const session = details?.session ?? fallback;
  if (!session) return null;
  const events = details?.events ?? [];
  const result = details?.result || session.summary || "";
  return h(
    "div",
    { class: "summon-backdrop" },
    h(
      "section",
      { class: "summon-drawer" },
      h(
        "header",
        { class: "summon-drawer-head" },
        h("div", {}, h("h2", { text: `summon @${session.agentId}` }), h("small", { text: `${session.status} / ${session.harness} / ${session.id}` })),
        h(
          "div",
          { class: "summon-actions" },
          session.status === "running"
            ? h("button", {
                class: "danger-button",
                text: "cancel",
                onclick: async () => {
                  try {
                    const body = await cancelSummon(session.id);
                    state.selectedSummon = { ...(state.selectedSummon ?? { events: [] }), session: body.session };
                    render();
                  } catch (error) {
                    setError(error);
                  }
                },
              })
            : null,
          h("button", { text: "close", onclick: () => ((state.selectedSummonId = null), (state.selectedSummon = null), render()) }),
        ),
      ),
      h("div", { class: "summon-prompt" }, h("span", { text: "task" }), h("pre", {}, LinkedText(session.prompt))),
      h(
        "div",
        { class: "summon-events" },
        events.length === 0 ? h("div", { class: "empty", text: "waiting for summon events" }) : events.map(SummonEventView),
      ),
      result ? h("div", { class: "summon-result" }, h("h3", { text: "result" }), h("pre", {}, LinkedText(result))) : null,
    ),
  );
}

function SummonEventView(event) {
  if (event.type === "text-delta") return h("pre", { class: "summon-text" }, LinkedText(event.delta));
  if (event.type === "model-info") return h("div", { class: "summon-meta", text: `${event.provider}/${event.modelId}` });
  if (event.type === "thinking-start") return h("div", { class: "summon-meta", text: "thinking started" });
  if (event.type === "thinking-delta") return h("pre", { class: "summon-thinking" }, LinkedText(event.delta));
  if (event.type === "thinking-end") return event.content ? h("pre", { class: "summon-thinking" }, LinkedText(event.content)) : null;
  if (event.type === "tool-start") return h("div", { class: "summon-tool running", text: `tool ${event.toolName} started` });
  if (event.type === "tool-update") return h("pre", { class: "summon-tool" }, LinkedText(formatSummonPayload(event.partialResult)));
  if (event.type === "tool-end") return h("pre", { class: `summon-tool ${event.isError ? "error" : "complete"}` }, LinkedText(formatSummonPayload(event.result)));
  return null;
}

function formatSummonPayload(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

// Streaming deltas arrive far faster than the screen refreshes; coalesce
// transcript rebuilds to one per animation frame.
let transcriptRenderQueued = false;

export function renderTranscriptOnly() {
  if (transcriptRenderQueued) return;
  transcriptRenderQueued = true;
  requestAnimationFrame(() => {
    transcriptRenderQueued = false;
    const target = document.querySelector("#transcript");
    if (!target) {
      render();
      return;
    }
    target.replaceWith(Transcript());
    document.querySelector("#transcript")?.scrollTo({ top: 100000 });
  });
}

export function render() {
  const root = document.querySelector("#app");
  const shouldKeepComposerFocus = document.activeElement === document.querySelector(".command-input") || document.activeElement === document.body;
  root.replaceChildren(App());
  document.querySelector("#transcript")?.scrollTo({ top: 100000 });
  if (shouldKeepComposerFocus && !state.settingsOpen) focusComposer();
}
