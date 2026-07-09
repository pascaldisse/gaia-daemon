// The status region: topbar (workspace identity + call indicator), the error
// banner, and the signature powerline status bar. Every segment is one fact
// about the session; arrows are pure CSS so no Nerd Font is required. Also
// owns the omarchy-style theme palette (the "theme" region).
import { selectRoom } from "./actions.js";
import { api } from "./api.js";
import { $, h } from "./dom.js";
import { LinkedText, PathText } from "./links.js";
import { stopReadAloud } from "./readaloud.js";
import { clearError, markDirty, registerRegion } from "./render.js";
import { openSearch } from "./search.js";
import { runningSummonRooms, state } from "./state.js";
import { applyTheme, currentThemeId, themeById, THEMES } from "./themes.js";
import { jumpToEvent } from "./transcript.js";

/** @typedef {{ spacer: true }|{ spacer?: undefined, text: string, cls: string, title?: string, id?: string, onclick?: () => void }} Seg */

function renderStatus() {
  renderTopbar();
  renderErrorBanner();
  renderStatusbar();
}

registerRegion("status", renderStatus);

function renderTopbar() {
  const topbar = $("#topbar");
  if (!topbar) return;
  const snapshot = state.snapshot;
  topbar.replaceChildren(
    h(
      "div",
      {},
      h("strong", {}, snapshot ? PathText(snapshot.workspace.rootDir) : LinkedText("No workspace selected")),
      h("small", {}, snapshot ? PathText(snapshot.workspace.configPath) : LinkedText("Add an initialized workspace to begin.")),
    ),
    h(
      "div",
      { class: "topbar-right" },
      // Search THIS chat — the same overlay as ⌘K, pre-scoped to the open room.
      snapshot
        ? h("button", {
            class: "topbar-search",
            type: "button",
            title: "search this chat (⌘F)",
            "aria-label": "search this chat",
            onclick: () => openSearch("room"),
            text: "⌕",
          })
        : null,
      h("div", {
        class: state.voice || state.voiceStatusText ? "status on-call" : "status",
        text: state.voiceStatusText
          ? state.voiceStatusText
          : snapshot
            ? `${state.voice ? `on call @${state.voice.agentId}` : `@${snapshot.room.activeAgent ?? snapshot.workspace.defaultAgent}`}`
            : "idle",
      }),
    ),
  );
}

function renderErrorBanner() {
  const banner = $("#error");
  if (!banner) return;
  banner.hidden = !state.error;
  banner.replaceChildren(
    h("span", { class: "error-text", text: state.error }),
    h("button", {
      class: "error-close",
      type: "button",
      title: "dismiss",
      "aria-label": "dismiss error",
      text: "✕",
      onclick: () => clearError(),
    }),
  );
}

function renderStatusbar() {
  const footer = $("#statusbar");
  if (!footer) return;
  const snapshot = state.snapshot;
  /** @type {Seg[]} */
  const segs = [];
  if (snapshot) {
    const runningAgents = (snapshot.agents ?? []).filter((agent) => agent.status === "running" || agent.status === "compacting").length;
    const runningRooms = (snapshot.rooms ?? []).filter((room) => room.running).length;
    const running = runningAgents + runningRooms;
    const activeRoom = snapshot.rooms?.find((room) => room.id === snapshot.room.id);
    const activeRoomLabel = activeRoom?.title ?? snapshot.room.id;
    segs.push({ text: snapshot.workspace.rootDir.split("/").filter(Boolean).pop() ?? snapshot.workspace.id, cls: "seg-head", title: snapshot.workspace.rootDir });
    segs.push({ text: `⊞ ${activeRoomLabel}`, cls: "seg-a", title: `active room: ${snapshot.room.id}` });
    segs.push({ text: `${snapshot.rooms?.length ?? 0} rooms`, cls: "seg-b" });
    segs.push({
      text: running ? `● ${running} running` : "○ idle",
      cls: running ? "seg-run on" : "seg-run",
      title: "running agents + summons",
    });
    if (state.voice) segs.push({ text: `🎙 @${state.voice.agentId}`, cls: "seg-voice", title: "on a voice call" });
  } else {
    segs.push({ text: "no workspace", cls: "seg-head" });
  }
  segs.push({ spacer: true });
  // Read-aloud "now playing": a message may keep speaking after you switch
  // rooms, so a lit chip shows which room it's in — click to jump to that
  // message, ■ to stop. Absent when nothing is playing.
  const playing = state.readAloud;
  if (playing) {
    // Only "playing"/"loading" pulse; a paused or ended message keeps a steady
    // chip so you can still jump to it (its player stays up by the composer).
    const icon = playing.phase === "loading" ? "◌" : playing.phase === "playing" ? "▶" : playing.phase === "paused" ? "⏸" : "⏹";
    const idle = playing.phase === "paused" || playing.phase === "ended";
    segs.push({
      text: `${icon} ${shortRoom(playing.roomId)}`,
      cls: `seg-nowplaying on${playing.phase === "loading" ? " loading" : ""}${idle ? " idle" : ""}`,
      title: `read-aloud in ${playing.roomId} — click to jump to it`,
      onclick: () => void jumpToPlaying(playing),
    });
    segs.push({ text: "■", cls: "seg-nowplaying stop on", title: "stop playback", onclick: stopReadAloud });
  }
  const usage = usageChipSeg();
  if (usage) segs.push(usage);
  const bg = bgChipSeg();
  if (bg) segs.push(bg);
  const theme = themeById(currentThemeId());
  segs.push({ text: `◈ ${theme.name}`, cls: "seg-theme", title: "themes (Alt+T)", onclick: openThemePalette });
  segs.push({ text: clockText(), cls: "seg-clock", id: "statusClock" });
  segs.push({ text: "^T new · ^B panes", cls: "seg-keys", title: "Ctrl+T new room · Ctrl+B/G toggle panes" });

  footer.replaceChildren(
    ...segs.map((seg) =>
      seg.spacer
        ? h("div", { class: "seg spacer" })
        : h(seg.onclick ? "button" : "div", {
            class: `seg ${seg.cls}`,
            id: seg.id ?? null,
            title: seg.title ?? null,
            text: seg.text,
            onclick: seg.onclick ?? null,
          }),
    ),
  );
}

export function clockText() {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Status bar visibility — a purely client-side display preference (mobile
// always hides it via CSS regardless; this only gates the desktop bar).
// Persisted so a reload keeps the choice; applied by toggling a class on #app
// rather than a region re-render, so it takes effect instantly with no dirty
// region plumbing.

const STATUSBAR_STORAGE_KEY = "gaia.statusbar";

/** @returns {boolean} true unless the user has explicitly hidden it */
export function statusbarVisible() {
  try {
    return localStorage.getItem(STATUSBAR_STORAGE_KEY) !== "hidden";
  } catch {
    return true;
  }
}

/** @param {boolean} visible */
function applyStatusbarVisibility(visible) {
  const app = $("#app");
  if (app) app.classList.toggle("statusbar-hidden", !visible);
}

/** @param {boolean} visible */
export function setStatusbarVisible(visible) {
  applyStatusbarVisibility(visible);
  try {
    localStorage.setItem(STATUSBAR_STORAGE_KEY, visible ? "shown" : "hidden");
  } catch {
    // private mode / storage disabled — the choice just won't persist.
  }
}

// Restore before first paint so there is no flash of the status bar.
export function initStatusbarPref() {
  applyStatusbarVisibility(statusbarVisible());
}

// ---------------------------------------------------------------------------
// Account usage chip — subscription session/weekly caps per ACCOUNT
// ("anthropic", "openai"), fed by whatever harness can currently read that
// account's credentials and cached on disk by the daemon so it survives
// restarts and provider outages. Compact in the bar (scoped to the open room's
// provider when it can tell); a click opens the full breakdown with bars, each
// account stamped with when it was last pulled, plus a manual refresh.

/** The cached usage groups relevant to the open room: accounts whose id
 * prefixes one of the active model tokens ("anthropic/fable" → "anthropic",
 * "openai-codex/gpt-5" → "openai"). No match — no room open, unknown provider —
 * falls back to EVERY cached account: the chip must never blank while a cache
 * exists just because we couldn't tell whose meter you're spending.
 * @returns {import("./types.js").UsageLimits[]} */
function visibleUsageGroups() {
  const groups = Object.values(state.usage);
  const tokens = activeRoomModelTokens();
  const matched = groups.filter((limits) => tokens.some((token) => token.startsWith(limits.account.toLowerCase())));
  return matched.length > 0 ? matched : groups;
}

/** @returns {import("./types.js").UsageWindow[]} every window across the visible accounts */
function allUsageWindows() {
  return visibleUsageGroups()
    .flatMap((limits) => limits.windows)
    .filter((win) => win && typeof win.percent === "number");
}

/** Model identifiers for the open room's active agent, lowercased — both the
 * configured model ("anthropic/fable") and the live label ("…claude-fable-5…"),
 * so a provider display name like "Fable" can be matched against either.
 * @returns {string[]} */
function activeRoomModelTokens() {
  const snapshot = state.snapshot;
  if (!snapshot) return [];
  const activeId = snapshot.room.activeAgent ?? snapshot.workspace.defaultAgent;
  const agent = (snapshot.agents ?? []).find((candidate) => candidate.id === activeId);
  if (!agent) return [];
  return [agent.configuredModel, agent.modelLabel].filter(Boolean).map((token) => token.toLowerCase());
}

/** A window is shown when it's account-wide (session, all-models weekly) OR it's
 * scoped to the model the open room is actively using. A dormant per-model cap
 * (e.g. Fable's weekly at 100% while you're on Opus) stays hidden.
 * @param {import("./types.js").UsageWindow} win @param {string[]} activeTokens */
function isUsageWindowVisible(win, activeTokens) {
  if (!win.model) return true;
  const needle = win.model.toLowerCase();
  return activeTokens.some((token) => token.includes(needle));
}

/** @returns {import("./types.js").UsageWindow[]} windows relevant to the open room */
function visibleUsageWindows() {
  const activeTokens = activeRoomModelTokens();
  return allUsageWindows().filter((win) => isUsageWindowVisible(win, activeTokens));
}

/** @param {import("./types.js").UsageWindow[]} windows @returns {"normal"|"warning"|"critical"} */
function worstSeverity(windows) {
  if (windows.some((win) => win.severity === "critical")) return "critical";
  if (windows.some((win) => win.severity === "warning")) return "warning";
  return "normal";
}

/** Relative "resets in …" for a window's reset instant (empty when unknown).
 * @param {string|undefined} iso */
function formatReset(iso) {
  if (!iso) return "";
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "";
  if (ms <= 0) return "resetting…";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `resets in ${mins}m`;
  const hours = Math.floor(mins / 60);
  const remMin = mins % 60;
  if (hours < 24) return remMin ? `resets in ${hours}h ${remMin}m` : `resets in ${hours}h`;
  const days = Math.floor(hours / 24);
  const remHr = hours % 24;
  return remHr ? `resets in ${days}d ${remHr}h` : `resets in ${days}d`;
}

/** The compact status-bar segment, or null when no harness reports usage. Shows
 * session + all-models weekly by default; a per-model weekly cap is appended
 * only when that model is active in the open room (labelled with the model).
 * @returns {Seg|null} */
function usageChipSeg() {
  const windows = visibleUsageWindows();
  if (windows.length === 0) return null;
  const session = windows.find((win) => win.kind === "session");
  const weeklyAll = windows.find((win) => win.kind === "weekly_all");
  const scoped = windows.filter((win) => win.kind === "weekly_scoped");
  const parts = [];
  if (session) parts.push(`${session.percent}%`);
  if (weeklyAll) parts.push(`${weeklyAll.percent}%w`);
  for (const win of scoped) parts.push(`${win.percent}% ${win.model}`);
  if (parts.length === 0) return null;
  const severity = worstSeverity(windows);
  const title = windows.map((win) => `${win.label}: ${win.percent}%${win.resetsAt ? ` · ${formatReset(win.resetsAt)}` : ""}`).join("\n");
  return {
    text: `◔ ${parts.join(" · ")}`,
    cls: `seg-usage${severity === "critical" ? " crit" : severity === "warning" ? " warn" : ""}`,
    title: `usage — click for the breakdown\n${title}`,
    onclick: openUsagePopover,
  };
}

export function openUsagePopover() {
  state.usagePopoverOpen = true;
  markDirty("usage");
}

export function closeUsagePopover() {
  state.usagePopoverOpen = false;
  markDirty("usage");
}

// ---------------------------------------------------------------------------
// Background-process tray — the status-bar chip shows a count of running
// background tasks + summon rooms; a click opens a palette listing each one
// with its command, target, elapsed time, and live-output jump for summons.

/** @returns {Seg|null} */
function bgChipSeg() {
  const snapshot = state.snapshot;
  if (!snapshot) return null;
  const runningTasks = (snapshot.tasks ?? []).filter((task) => task.status === "running").length;
  const summons = runningSummonRooms(snapshot).length;
  const n = runningTasks + summons;
  if (n === 0) return null;
  return {
    text: `\u2699 ${n} bg`,
    cls: `seg-run on`,
    title: "background processes",
    onclick: openBgTasks,
  };
}

export function openBgTasks() {
  state.bgTasksOpen = true;
  markDirty("bgtasks");
}

export function closeBgTasks() {
  state.bgTasksOpen = false;
  markDirty("bgtasks");
}

function renderBgTasks() {
  const slot = $("#overlay-bgtasks");
  if (!slot) return;
  if (!state.bgTasksOpen) slot.replaceChildren();
  else {
    const popover = BgTasksPopover();
    slot.replaceChildren(...(popover ? [popover] : []));
  }
}

registerRegion("bgtasks", renderBgTasks);

/** Format elapsed ms as a short human string. @param {number} ms @returns {string} */
function elapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

function BgTasksPopover() {
  const snapshot = state.snapshot;
  if (!snapshot) return null;
  const runningTasks = (snapshot.tasks ?? []).filter((task) => task.status === "running");
  const summons = runningSummonRooms(snapshot);
  const now = Date.now();
  return h(
    "div",
    {
      class: "palette-backdrop",
      onclick: (event) => {
        if (event.target === event.currentTarget) closeBgTasks();
      },
    },
    h(
      "div",
      { class: "palette usage-popover" },
      h(
        "div",
        { class: "palette-head" },
        h("strong", { text: "background processes" }),
        h("small", { text: `${runningTasks.length + summons.length} running \u00b7 esc to close` }),
      ),
      // Running task rows
      ...runningTasks.map((task) =>
        h(
          "div",
          { class: "usage-row" },
          h(
            "div",
            { class: "usage-row-top" },
            h("span", { class: "usage-label", text: task.text || task.id }),
            h("span", { class: "usage-pct sev-normal", text: task.startedAt ? elapsed(now - new Date(task.startedAt).getTime()) : "" }),
          ),
          task.targets?.length
            ? h("small", { class: "usage-reset", text: `target: ${task.targets.join(", ")}` })
            : null,
        ),
      ),
      // Running summon room rows — clickable, jump to live output
      ...summons.map((room) =>
        h(
          "button",
          {
            class: "usage-row",
            style: "width:100%;text-align:left;background:var(--bg3);border:1px solid var(--border);margin-top:6px;cursor:pointer;",
            onclick: () => {
              selectRoom(snapshot.workspace.id, room.id);
              closeBgTasks();
            },
          },
          h(
            "div",
            { class: "usage-row-top" },
            h("span", { class: "usage-label", text: `\u25b7 ${room.id}` }),
            h("span", { class: "usage-pct sev-normal", text: room.lastActivity ? elapsed(now - new Date(room.lastActivity).getTime()) : "" }),
          ),
          room.running ? h("small", { class: "usage-reset", text: "streaming \u00b7 click to watch" }) : null,
        ),
      ),
      runningTasks.length === 0 && summons.length === 0
        ? h("div", { class: "search-empty", text: "No background processes." })
        : null,
    ),
  );
}

/** @type {number|null} */
let usageAgeTimer = null;

function renderUsagePopover() {
  const slot = $("#overlay-usage");
  if (!slot) return;
  const shouldShow = state.usagePopoverOpen && Object.keys(state.usage).length > 0;
  if (!shouldShow) {
    slot.replaceChildren();
    if (usageAgeTimer !== null) {
      clearInterval(usageAgeTimer);
      usageAgeTimer = null;
    }
    return;
  }
  if (usageAgeTimer === null) {
    usageAgeTimer = window.setInterval(() => markDirty("usage"), 1000);
  }
  slot.replaceChildren(UsagePopover());
}

registerRegion("usage", renderUsagePopover);

function UsagePopover() {
  const activeTokens = activeRoomModelTokens();
  const groups = Object.values(state.usage).map((limits) => {
    const visible = limits.windows.filter((win) => isUsageWindowVisible(win, activeTokens));
    return { limits, windows: visible.length > 0 ? visible : limits.windows };
  });
  return h(
    "div",
    {
      class: "palette-backdrop",
      onclick: (event) => {
        if (event.target === event.currentTarget) closeUsagePopover();
      },
    },
    h(
      "div",
      { class: "palette usage-popover" },
      h(
        "div",
        { class: "palette-head" },
        h("strong", { text: "usage" }),
        h("small", { text: "subscription limits · esc to close" }),
        h("button", {
          class: "usage-refresh",
          type: "button",
          title: "refresh from provider",
          disabled: state.usageRefreshing,
          text: state.usageRefreshing ? "…" : "↻",
          onclick: () => void refreshUsageNow(),
        }),
      ),
      ...groups.map(({ limits, windows }) =>
        h(
          "div",
          { class: "usage-group" },
          h(
            "div",
            { class: "usage-group-head" },
            h("span", { class: "usage-harness", text: limits.account }),
            limits.plan ? h("span", { class: "usage-plan", text: limits.plan }) : null,
            h("span", { class: "usage-age", text: formatAge(limits.fetchedAt) }),
          ),
          ...windows.map((win) =>
            h(
              "div",
              { class: "usage-row" },
              h(
                "div",
                { class: "usage-row-top" },
                h("span", { class: "usage-label", text: win.label }),
                h("span", { class: `usage-pct sev-${win.severity}`, text: `${win.percent}%` }),
              ),
              h("div", { class: "usage-bar" }, h("div", { class: `usage-bar-fill sev-${win.severity}`, style: `width:${win.percent}%` })),
              win.resetsAt ? h("small", { class: "usage-reset", text: formatReset(win.resetsAt) }) : null,
            ),
          ),
        ),
      ),
    ),
  );
}

async function refreshUsageNow() {
  if (state.usageRefreshing) return;
  state.usageRefreshing = true;
  markDirty("usage");
  try {
    const response = await api("/api/usage/refresh", { method: "POST" });
    const accounts = /** @type {Record<string, import("./types.js").UsageLimits>} */ (response?.accounts ?? {});
    for (const account of Object.keys(state.usage)) {
      if (!(account in accounts)) delete state.usage[account];
    }
    for (const [account, limits] of Object.entries(accounts)) {
      state.usage[account] = limits;
    }
  } catch {
    // Keep the cached meter visible if the manual refresh endpoint/provider hiccups.
  } finally {
    state.usageRefreshing = false;
    markDirty("status", "usage");
  }
}

/** Relative fetch age for an account snapshot (empty when unknown).
 * @param {string|undefined} iso */
function formatAge(iso) {
  if (!iso) return "";
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const secs = Math.floor(ms / 1000);
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  const remMin = mins % 60;
  if (hours < 24) return `${hours}h ${remMin}m ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Short room label for the now-playing chip (room ids can be long imports).
 * @param {string} id */
function shortRoom(id) {
  return id.length > 14 ? `${id.slice(0, 13)}…` : id;
}

/** Jump to the room+message the read-aloud chip points at: switch rooms if
 * needed, then scroll the message into view and flash it (same landing as a
 * chat-search hit).
 * @param {NonNullable<typeof state.readAloud>} playing */
async function jumpToPlaying(playing) {
  const snapshot = state.snapshot;
  if (!snapshot || snapshot.workspace.id !== playing.workspaceId || snapshot.room.id !== playing.roomId) {
    await selectRoom(playing.workspaceId, playing.roomId);
  }
  await jumpToEvent(playing.eventId);
}

// ---------------------------------------------------------------------------
// Omarchy-style theme palette. Hover previews live (instant recolour via the
// html[data-theme] attribute, no re-render); click commits; Esc or backdrop
// cancels back to where you were.

/** @type {string|null} */
let themeCommitted = null;

export function openThemePalette() {
  themeCommitted = currentThemeId();
  state.themePaletteOpen = true;
  markDirty("theme", "status");
}

/** @param {boolean} commit */
export function closeThemePalette(commit) {
  if (!commit && themeCommitted) applyTheme(themeCommitted);
  state.themePaletteOpen = false;
  themeCommitted = null;
  markDirty("theme", "status");
}

function renderThemePalette() {
  const slot = $("#overlay-theme");
  if (!slot) return;
  if (!state.themePaletteOpen) slot.replaceChildren();
  else slot.replaceChildren(ThemePalette());
}

registerRegion("theme", renderThemePalette);

function ThemePalette() {
  return h(
    "div",
    {
      class: "palette-backdrop",
      onclick: (event) => {
        if (event.target === event.currentTarget) closeThemePalette(false);
      },
    },
    h(
      "div",
      { class: "palette" },
      h(
        "div",
        { class: "palette-head" },
        h("strong", { text: "themes" }),
        h("small", { text: "hover to preview · click to apply · esc to cancel" }),
      ),
      h(
        "div",
        { class: "palette-grid" },
        THEMES.map((theme) =>
          // Each swatch carries its own data-theme attribute, so the palette
          // variables in styles.css recolour it without a second copy of any
          // theme colour existing in JS.
          h(
            "button",
            {
              class: `swatch ${theme.id === currentThemeId() ? "active" : ""}`,
              "data-theme": theme.id,
              onmouseenter: () => applyTheme(theme.id),
              onclick: () => {
                applyTheme(theme.id);
                themeCommitted = theme.id;
                closeThemePalette(true);
              },
            },
            h(
              "span",
              { class: "sw-preview" },
              h("span", { class: "sw-dot sw-accent" }),
              h("span", { class: "sw-dot sw-accent2" }),
              h("span", { class: "sw-dot sw-good" }),
              h("span", { class: "sw-dot sw-danger" }),
            ),
            h("span", { class: "sw-name", text: theme.name }),
          ),
        ),
      ),
    ),
  );
}
