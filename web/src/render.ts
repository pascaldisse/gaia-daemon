import { addWorkspace, loadWorkspace } from "./actions.ts";
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
    state.settingsOpen ? SettingsModal() : null,
  );
}

function Sidebar() {
  const workspaces = state.app?.workspaces ?? [];
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
      h("button", { class: `nav-item ${room.isCurrent ? "active" : ""}` }, h("span", { text: room.id }), h("small", {}, PathText(room.path))),
    ),
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
      class: state.voice ? "status on-call" : "status",
      text: snapshot
        ? `${state.voice ? `on call:@${state.voice.agentId} ` : ""}room:${snapshot.room.id} default:@${snapshot.workspace.defaultAgent}`
        : "idle",
    }),
  );
}

function RoomPanel() {
  const snapshot = state.snapshot;
  const agents = snapshot?.agents ?? [];
  const tasks = snapshot?.tasks ?? [];
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

export function renderTranscriptOnly() {
  const target = document.querySelector("#transcript");
  if (!target) {
    render();
    return;
  }
  target.replaceWith(Transcript());
  document.querySelector("#transcript")?.scrollTo({ top: 100000 });
}

export function render() {
  const root = document.querySelector("#app");
  const shouldKeepComposerFocus = document.activeElement === document.querySelector(".command-input") || document.activeElement === document.body;
  root.replaceChildren(App());
  document.querySelector("#transcript")?.scrollTo({ top: 100000 });
  if (shouldKeepComposerFocus && !state.settingsOpen) focusComposer();
}
