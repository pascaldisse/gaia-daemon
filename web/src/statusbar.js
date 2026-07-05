// The status region: topbar (workspace identity + call indicator), the error
// banner, and the signature powerline status bar. Every segment is one fact
// about the session; arrows are pure CSS so no Nerd Font is required. Also
// owns the omarchy-style theme palette (the "theme" region).
import { $, h } from "./dom.js";
import { LinkedText, PathText } from "./links.js";
import { markDirty, registerRegion } from "./render.js";
import { state } from "./state.js";
import { applyTheme, currentThemeId, themeById, THEMES } from "./themes.js";

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
    h("div", {
      class: state.voice || state.voiceStatusText ? "status on-call" : "status",
      text: state.voiceStatusText
        ? state.voiceStatusText
        : snapshot
          ? `${state.voice ? `on call @${state.voice.agentId}` : `@${snapshot.room.activeAgent ?? snapshot.workspace.defaultAgent}`}`
          : "idle",
    }),
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
