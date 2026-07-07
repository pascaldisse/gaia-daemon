// The status region: topbar (workspace identity + call indicator), the error
// banner, and the signature powerline status bar. Every segment is one fact
// about the session; arrows are pure CSS so no Nerd Font is required. Also
// owns the omarchy-style theme palette (the "theme" region).
import { selectRoom } from "./actions.js";
import { $, h } from "./dom.js";
import { LinkedText, PathText } from "./links.js";
import { stopReadAloud } from "./readaloud.js";
import { markDirty, registerRegion } from "./render.js";
import { openSearch } from "./search.js";
import { state } from "./state.js";
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
  banner.textContent = state.error;
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
    segs.push({ text: snapshot.workspace.rootDir.split("/").filter(Boolean).pop() ?? snapshot.workspace.id, cls: "seg-head", title: snapshot.workspace.rootDir });
    segs.push({ text: `⊞ ${snapshot.room.id}`, cls: "seg-a", title: "active room" });
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
