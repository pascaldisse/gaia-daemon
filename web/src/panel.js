// The right-hand room panel: agents (role select, main-agent star, voice call
// button) and recent tasks.
import { setAgentDefaultRole, setAgentRole, setDefaultAgent, setRoomAgentDialogue } from "./actions.js";
import { armCompactTick, CompactBar, compactDetail } from "./compactprogress.js";
import { $, h } from "./dom.js";
import { LinkedText, PathText } from "./links.js";
import { shortModel } from "./models.js";
import { registerRegion } from "./render.js";
import { openAgentSettings } from "./settings.js";
import { state } from "./state.js";
import { toggleCall } from "./voice.js";

/**
 * The one-line agent subtitle (status / model), shown under the @id and mirrored
 * into the row's title so it survives ellipsis-truncation on a narrow panel.
 * @param {import("./types.js").AgentStatus} agent
 * @param {string | undefined} activeAgent
 */
function agentSubtitle(agent, activeAgent) {
  return [
    // Only when it says more than the id already does.
    agent.displayName && agent.displayName.toLowerCase() !== agent.id.toLowerCase() ? agent.displayName : "",
    agent.id === activeAgent ? "active" : "",
    agent.isDefault ? "default" : "",
    agent.status === "running" ? "running" : "",
    agent.status === "compacting" ? `compacting… ${agent.compact ? compactDetail(agent.compact) : ""}`.trim() : "",
    agent.voice ? `voice:${agent.voice}` : "",
    agent.modelLabel ? shortModel(agent.modelLabel) : "",
  ]
    .filter(Boolean)
    .join(" / ");
}

function renderPanel() {
  const panel = $("#room-panel");
  if (!panel) return;
  const snapshot = state.snapshot;
  const agents = snapshot?.agents ?? [];
  const tasks = snapshot?.tasks ?? [];
  // The agent this room is currently addressing: its remembered active agent,
  // or the workspace default when it has none yet. Marks the "active" row and
  // is who a bare next message goes to.
  const activeAgent = snapshot ? (snapshot.room.activeAgent ?? snapshot.workspace.defaultAgent) : undefined;
  panel.replaceChildren(
    h(
      "div",
      { class: "panel-head" },
      h("h2", { text: "Room" }),
      h("small", {}, snapshot?.room.statePath ? PathText(snapshot.room.statePath) : LinkedText("no room")),
    ),
    h(
      "div",
      { class: "room-toggle-wrap" },
      snapshot
        ? h(
            "label",
            { class: "room-toggle", title: "Let agents in this room reply to each other's @mentions. Off by default; bounded by a loop guard." },
            h("input", {
              type: "checkbox",
              checked: Boolean(snapshot.room.agentDialogue),
              onchange: (event) => void setRoomAgentDialogue(/** @type {HTMLInputElement} */ (event.target).checked),
            }),
            h("span", { text: "agents talk to each other" }),
          )
        : null,
    ),
    h("h3", { text: "agents" }),
    h(
      "div",
      { class: "agent-list" },
      agents.map((agent) => {
        const onCall = state.voice?.agentId === agent.id;
        const connecting = state.voicePendingAgentId === agent.id;
        const roles = agent.roles ?? [];
        // "none" is an explicit opt-out; otherwise a room override wins, falling
        // back to the agent's global default role.
        const effectiveRole = agent.activeRole === "none" ? undefined : (agent.activeRole ?? agent.defaultRole);
        return h(
          "div",
          { class: `agent-row ${onCall ? "on-call" : ""} ${agent.status === "running" || agent.status === "compacting" ? "running" : ""} ${effectiveRole ? "has-role" : ""} ${agent.id === activeAgent ? "active-agent" : ""}` },
          h(
            "div",
            // The role-select is pinned to this cell's bottom-right (the model
            // line) and lives OUTSIDE the name's flow, so it can never share
            // horizontal space with, or overlap, the @name above it.
            { class: `agent-cell ${roles.length > 0 ? "with-role" : ""}` },
            h(
              "button",
              { class: "agent-main", title: `open @${agent.id} settings`, onclick: () => void openAgentSettings(agent.id) },
              h("span", { class: `dot ${agent.status}` }),
              h("strong", { text: `${agent.icon} @${agent.id}` }),
              h("small", {
                // One line, ellipsized when narrow — mirror the full text into
                // title so it stays recoverable on hover.
                title: agentSubtitle(agent, activeAgent),
                text: agentSubtitle(agent, activeAgent),
              }),
              agent.status === "compacting" && agent.compact ? CompactBar(agent.compact) : null,
            ),
            roles.length > 0
              ? h(
                  "select",
                  {
                    class: `role-select ${effectiveRole ? "active" : ""}`,
                    title: `role for @${agent.id}`,
                    onchange: (event) => void setAgentRole(agent.id, /** @type {HTMLSelectElement} */ (event.target).value),
                  },
                  h("option", {
                    value: "default",
                    text: agent.defaultRole ? `default (${agent.defaultRole})` : "default",
                    selected: !agent.activeRole,
                  }),
                  h("option", { value: "none", text: "none", selected: agent.activeRole === "none" }),
                  roles.map((roleName) => h("option", { value: roleName, text: roleName, selected: roleName === agent.activeRole })),
                )
              : null,
            agent.activeRole && agent.activeRole !== "none"
              ? h("button", {
                  class: "role-global-button",
                  text: "⌂",
                  title: `make "${agent.activeRole}" the global default for @${agent.id} (all rooms)`,
                  onclick: async () => {
                    const role = agent.activeRole;
                    if (!role) return;
                    await setAgentDefaultRole(agent.id, role);
                    await setAgentRole(agent.id, "default");
                  },
                })
              : null,
          ),
          h("button", {
            class: `main-button ${agent.isDefault ? "active" : ""}`,
            title: agent.isDefault
              ? `@${agent.id} is the default agent — it seeds the active agent in a new room`
              : `make @${agent.id} the default agent (seeds new rooms; doesn't change who this room is talking to)`,
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
  // Keep the elapsed advancing between server snapshots while any pass runs.
  armCompactTick(agents.some((agent) => agent.status === "compacting"));
}

registerRegion("panel", renderPanel);
