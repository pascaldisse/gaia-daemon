// The right-hand room panel: agents (role select, main-agent star, voice call
// button) and recent tasks.
import { accountsCatalog, cancelActiveTask, deleteAgent, deleteQueuedMessage, sendMessage, setAgentAccount, setAgentDefaultRole, setAgentRole, setDefaultAgent, setRoomAgentDialogue } from "./actions.js";
import { agentGlyph, STATE, UI } from "./glyphs.js";
import { armCompactTick, CompactBar, compactDetail } from "./compactprogress.js";
import { $, h } from "./dom.js";
import { LinkedText, PathText } from "./links.js";
import { shortModel } from "./models.js";
import { markDirty, registerRegion } from "./render.js";
import { openAgentSettings } from "./settings.js";
import { activeTask, state } from "./state.js";
import { toggleCall } from "./voice.js";

/** Draft text for the todo-section's quick-add row. Module-level (like
 * accountsCatalogValue above) so it survives the full-subtree replace every
 * renderPanel() does — an inline input's typed value would otherwise vanish
 * on the next unrelated snapshot re-render. Local UI-only state; never
 * touches state.js. */
let todoDraftText = "";

/** Account catalog for the per-agent picker below: fetched once (accountsCatalog()
 * caches the request itself), held here as the last resolved value so a render
 * pass stays synchronous. Guarded by `accountsCatalogRequested` so attaching
 * .then() doesn't re-fire markDirty on every render once it has resolved. */
/** @type {import("./actions.js").AccountsCatalog | null} */
let accountsCatalogValue = null;
let accountsCatalogRequested = false;

function ensureAccountsCatalog() {
  if (accountsCatalogRequested) return;
  accountsCatalogRequested = true;
  void accountsCatalog()
    .then((catalog) => {
      accountsCatalogValue = catalog;
      markDirty("panel");
    })
    .catch(() => {
      accountsCatalogRequested = false; // let the next render retry
    });
}

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
  ensureAccountsCatalog();
  const snapshot = state.snapshot;
  const agents = snapshot?.agents ?? [];
  // The agent this room is currently addressing: its remembered active agent,
  // or the workspace default when it has none yet. Marks the "active" row and
  // is who a bare next message goes to.
  const activeAgent = snapshot ? (snapshot.room.activeAgent ?? snapshot.workspace.defaultAgent) : undefined;
  const agentMenu = AgentContextMenu();
  const swarmSection = SwarmSection(snapshot);
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
        // Only offer an account picker when there's actually a choice: at least
        // one named account declared for THIS agent's harness. Renders nothing
        // (not even a default-account no-op select) while the catalog is
        // unresolved, and for harnesses/accounts with zero matches.
        const agentAccounts = (accountsCatalogValue?.accounts ?? []).filter((account) => account.harness === agent.harness);
        return h(
          "div",
          {
            // roster-row (v2 parity class) rides ALONGSIDE the existing
            // agent-row layout — never replaces it, so the role/account
            // selects below keep their current markup and behavior untouched.
            class: `agent-row roster-row roster-agent ${onCall ? "on-call" : ""} ${agent.status === "running" || agent.status === "compacting" ? "running" : ""} ${effectiveRole ? "has-role" : ""} ${agent.id === activeAgent ? "active-agent" : ""}`,
            oncontextmenu: (/** @type {MouseEvent} */ event) => {
              event.preventDefault();
              state.agentContextMenu = { agentId: agent.id, x: event.clientX, y: event.clientY };
              markDirty("panel");
            },
          },
          h("i", { text: agentGlyph(agent.id), "aria-hidden": "true" }),
          h(
            "div",
            // The role-select is pinned to this cell's bottom-right (the model
            // line) and lives OUTSIDE the name's flow, so it can never share
            // horizontal space with, or overlap, the @name above it. Same
            // anchoring for the account-select, pinned just left of it.
            { class: `agent-cell ${roles.length > 0 ? "with-role" : ""} ${agentAccounts.length > 0 ? "with-account" : ""}` },
            h(
              "button",
              { class: "agent-main", title: `open @${agent.id} settings`, onclick: () => void openAgentSettings(agent.id) },
              // Speaker/roster names render PLAIN — @ is for addressing only
              // (targets, mentions), never a header (V2-SKIN.md design law).
              h("strong", { text: agent.id }),
              h("small", {
                // One line, ellipsized when narrow — mirror the full text into
                // title so it stays recoverable on hover.
                title: agentSubtitle(agent, activeAgent),
                text: agentSubtitle(agent, activeAgent),
              }),
              agent.status === "compacting" && agent.compact ? CompactBar(agent.compact) : null,
            ),
            agentAccounts.length > 0
              ? h(
                  "select",
                  {
                    class: `account-select ${agent.account ? "active" : ""}`,
                    title: `account for @${agent.id}`,
                    onchange: (event) => void setAgentAccount(agent.id, /** @type {HTMLSelectElement} */ (event.target).value || null),
                  },
                  h("option", { value: "", text: "default account", selected: !agent.account }),
                  agentAccounts.map((account) =>
                    h("option", { value: account.id, text: account.label || account.id, selected: account.id === agent.account }),
                  ),
                )
              : null,
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
            text: agent.isDefault ? UI.favorite : UI.favoriteOff,
          }),
          h("button", {
            class: `call-button ${onCall ? "active" : ""}`,
            title: onCall ? `hang up @${agent.id}` : `start voice call with @${agent.id}`,
            disabled: connecting || (Boolean(state.voice) && !onCall),
            onclick: () => void toggleCall(agent.id),
            text: connecting ? "…" : onCall ? UI.stop : UI.call,
          }),
        );
      }),
    ),
    TodoSection(snapshot),
    ...(swarmSection ? [swarmSection] : []),
    ...(agentMenu ? [agentMenu] : []),
  );
  // Keep the elapsed advancing between server snapshots while any pass runs.
  armCompactTick(agents.some((agent) => agent.status === "compacting"));
}

/** Right-click menu on an agent row: delete (moves to trash, recoverable).
 * @returns {HTMLElement|null} */
function AgentContextMenu() {
  const open = state.agentContextMenu;
  if (!open) return null;
  const agent = (state.snapshot?.agents ?? []).find((candidate) => candidate.id === open.agentId);
  if (!agent) return null;
  const close = () => {
    state.agentContextMenu = null;
    markDirty("panel");
  };
  return h(
    "div",
    { class: "room-menu", style: `left:${open.x}px;top:${open.y}px`, oncontextmenu: (/** @type {MouseEvent} */ event) => event.preventDefault() },
    h("div", { class: "room-menu-title", text: `@${agent.id}` }),
    h("button", {
      type: "button",
      class: "danger",
      onclick: () => {
        close();
        void deleteAgent(agent.id);
      },
      text: "Delete agent",
    }),
  );
}

window.addEventListener("click", (event) => {
  if (!state.agentContextMenu) return;
  if (event.target instanceof HTMLElement && event.target.closest(".room-menu")) return;
  state.agentContextMenu = null;
  markDirty("panel");
});

/**
 * v2-parity TODO section (§G4). v1 has no separate agent-authored checklist
 * tool — the REAL nearest data is the room's own task queue (snapshot.tasks:
 * queued/running/complete/error/cancelled, see core/types.ts Task), already
 * shown pre-parity as a plain "tasks" list a few lines above this. This
 * replaces that plain list with the v2 class contract (.native-section
 * .todo-section / .todo-list / .todo-row(+modifier) / .todo-actions /
 * .todo-create) over the SAME real source — cancel wired to the real
 * deleteQueuedMessage/cancelActiveTask actions, create wired to the real
 * sendMessage action. No fake data.
 * @param {import("./types.js").Snapshot | null | undefined} snapshot
 */
function TodoSection(snapshot) {
  const tasks = snapshot?.tasks ?? [];
  const rows = tasks.slice(-8);
  return h(
    "section",
    { class: "native-section todo-section" },
    h("h3", { text: "todo" }),
    h(
      "div",
      { class: "todo-list" },
      rows.length === 0 ? h("div", { class: "empty", text: "no queued tasks" }) : rows.map((task) => TodoRow(task)),
    ),
    TodoCreate(snapshot),
  );
}

/** One task chip. v2 status names are "open"/"in-progress"/"completed"/
 * "cancelled"; v1's real TaskStatus is "queued"/"running"/"complete"/"error"/
 * "cancelled" — mapped onto the v2 modifier spelling where it lines up
 * (completed, cancelled) and kept as-is otherwise (queued, running, error).
 * @param {import("./types.js").Task} task */
function TodoRow(task) {
  const modifier = task.status === "complete" ? "todo-completed" : task.status === "cancelled" ? "todo-cancelled" : `todo-${task.status}`;
  const glyph = task.status === "running" ? STATE.running : task.status === "complete" ? STATE.done : task.status === "error" ? STATE.error : task.status === "cancelled" ? UI.stop : "";
  const targets = (task.targets ?? []).map((id) => `@${id}`).join(" ");
  const canCancel = task.status === "queued" || task.status === "running";
  return h(
    "div",
    { class: `todo-row ${modifier}` },
    h("strong", { title: task.text, text: task.text || "(no text)" }),
    h("small", { text: [glyph, task.status, targets].filter(Boolean).join(" ") }),
    canCancel
      ? h(
          "div",
          { class: "todo-actions" },
          h("button", {
            type: "button",
            text: "cancel",
            onclick: () => void (task.status === "running" ? cancelActiveTask() : deleteQueuedMessage(task.id)),
          }),
        )
      : null,
  );
}

/** Quick-add row: sends straight through the real message pipe (queued if a
 * turn is already running, dispatched immediately otherwise) — a genuinely
 * new task lands in snapshot.tasks, same as one typed in the composer.
 * @param {import("./types.js").Snapshot | null | undefined} snapshot */
function TodoCreate(snapshot) {
  if (!snapshot) return null;
  return h(
    "div",
    { class: "todo-create" },
    h("input", {
      type: "text",
      placeholder: "new task…",
      "aria-label": "New task text",
      value: todoDraftText,
      oninput: (event) => {
        todoDraftText = /** @type {HTMLInputElement} */ (event.target).value;
      },
      onkeydown: (event) => {
        if (event.key === "Enter") submitTodoDraft(snapshot);
      },
    }),
    h("button", { type: "button", text: "+ task", onclick: () => submitTodoDraft(snapshot) }),
  );
}

/** @param {import("./types.js").Snapshot} snapshot */
function submitTodoDraft(snapshot) {
  const text = todoDraftText.trim();
  if (!text) return;
  todoDraftText = "";
  void sendMessage(text, [], { queue: Boolean(activeTask(snapshot)) });
}

/**
 * v2-parity swarm phase tree (§G4). v2's tree rides live `swarm.phase`
 * events (started/completed/failed) rendered inline in the transcript —
 * transcript.js is out of this lane's ownership, and v1 has no such event on
 * the wire. The REAL data available here is the child-room roster:
 * `summon` spawns each whale into its own sub-room with `parentRoomId` set
 * to this room (see harness/tools-pi.ts createSummonTool + core/types.ts
 * RoomSummary.parentRoomId/.running). That gives an honest 2-state tree —
 * started (still running) / completed (not running any more). v1 surfaces
 * no per-lane failure flag at the snapshot level (would need each child's
 * own transcript), so "failed" is never emitted — no fake state.
 * @param {import("./types.js").Snapshot | null | undefined} snapshot
 */
function SwarmSection(snapshot) {
  if (!snapshot) return null;
  const rooms = snapshot.rooms ?? [];
  const lanes = rooms.filter((room) => room.parentRoomId === snapshot.room.id);
  if (lanes.length === 0) return null;
  return h(
    "section",
    { class: "native-section swarm-section" },
    h("h3", { text: "swarm" }),
    h(
      "ol",
      { class: "swarm-phase-tree" },
      h(
        "ul",
        { class: "swarm-phase-level" },
        lanes.map((room) => SwarmNode(room)),
      ),
    ),
  );
}

/** @param {import("./types.js").RoomSummary} room */
function SwarmNode(room) {
  const phase = room.running ? "started" : "completed";
  const glyph = agentGlyph(room.title ?? room.id);
  return h(
    "li",
    { class: `swarm-phase-node swarm-phase-${phase}` },
    h(
      "div",
      { class: "swarm-phase-row" },
      h("i", { class: "swarm-phase-glyph", text: glyph }),
      h("span", { class: "swarm-phase-title", text: room.title || room.id }),
    ),
  );
}

registerRegion("panel", renderPanel);
