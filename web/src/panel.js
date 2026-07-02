// The right-hand room panel: agents (role select, main-agent star, voice call
// button) and recent tasks. The workspace settings panel below it is owned by
// the settings region, so streaming re-renders here never wipe an edit there.
import { setAgentRole, setDefaultAgent } from "./actions.js";
import { $, h } from "./dom.js";
import { LinkedText, PathText } from "./links.js";
import { registerRegion } from "./render.js";
import { openAgentSettings } from "./settings.js";
import { state } from "./state.js";
import { toggleCall } from "./voice.js";

function renderPanel() {
  const panel = $("#room-panel");
  if (!panel) return;
  const snapshot = state.snapshot;
  const agents = snapshot?.agents ?? [];
  const tasks = snapshot?.tasks ?? [];
  panel.replaceChildren(
    h(
      "div",
      { class: "panel-head" },
      h("h2", { text: "Room" }),
      h("small", {}, snapshot?.room.statePath ? PathText(snapshot.room.statePath) : LinkedText("no room")),
    ),
    h("h3", { text: "agents" }),
    h(
      "div",
      { class: "agent-list" },
      agents.map((agent) => {
        const onCall = state.voice?.agentId === agent.id;
        const connecting = state.voicePendingAgentId === agent.id;
        const roles = agent.roles ?? [];
        return h(
          "div",
          { class: `agent-row ${onCall ? "on-call" : ""} ${agent.status === "running" ? "running" : ""} ${agent.activeRole ? "has-role" : ""}` },
          h(
            "button",
            { class: "agent-main", title: `open @${agent.id} settings`, onclick: () => void openAgentSettings(agent.id) },
            h("span", { class: `dot ${agent.status}` }),
            h("strong", { text: `${agent.icon} @${agent.id}` }),
            h("small", {
              text: [
                // Only when it says more than the id already does.
                agent.displayName && agent.displayName.toLowerCase() !== agent.id.toLowerCase() ? agent.displayName : "",
                agent.isDefault ? "main" : "",
                agent.status === "running" ? "running" : "",
                agent.voice ? `voice:${agent.voice}` : "",
                agent.modelLabel,
              ]
                .filter(Boolean)
                .join(" / "),
            }),
          ),
          roles.length > 0
            ? h(
                "select",
                {
                  class: `role-select ${agent.activeRole ? "active" : ""}`,
                  title: `role for @${agent.id}`,
                  onchange: (event) => void setAgentRole(agent.id, /** @type {HTMLSelectElement} */ (event.target).value),
                },
                h("option", { value: "none", text: "— role —", selected: !agent.activeRole }),
                roles.map((roleName) => h("option", { value: roleName, text: roleName, selected: roleName === agent.activeRole })),
              )
            : null,
          h("button", {
            class: `main-button ${agent.isDefault ? "active" : ""}`,
            title: agent.isDefault ? `@${agent.id} is the main agent` : `make @${agent.id} the main agent`,
            disabled: agent.isDefault,
            onclick: () => void setDefaultAgent(agent.id),
            text: agent.isDefault ? "★" : "☆",
          }),
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

registerRegion("panel", renderPanel);
