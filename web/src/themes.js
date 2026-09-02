// Omarchy-style theme engine. The palettes themselves live ONCE, in CSS
// ([data-theme="…"] blocks in styles.css); this module only switches the
// html[data-theme] attribute, tracks the catalogue for the palette overlay
// and the cycle shortcut, and persists the choice. Swatches in the palette
// scope the same CSS variables by carrying their own data-theme attribute,
// so there is no second copy of any colour anywhere.

/**
 * @typedef {Object} ThemeMeta
 * @property {string} id
 * @property {string} name
 * @property {boolean} [retro] true => CRT scanlines + pixel font (Matrix)
 */

/** @type {ThemeMeta[]} */
export const THEMES = [
  { id: "obsidian-violet", name: "Obsidian Violet" },
  { id: "tokyo-night", name: "Tokyo Night" },
  { id: "cyberpunk", name: "Cyberpunk" },
  { id: "catppuccin", name: "Catppuccin" },
  { id: "gruvbox", name: "Gruvbox" },
  { id: "nord", name: "Nord" },
  { id: "everforest", name: "Everforest" },
  { id: "kanagawa", name: "Kanagawa" },
  { id: "rose-pine", name: "Rosé Pine" },
  { id: "dracula", name: "Dracula" },
  { id: "matte-black", name: "Matte Black" },
  { id: "matrix", name: "Matrix", retro: true },
  { id: "bloodborne", name: "Bloodborne" },
];

const STORAGE_KEY = "gaia.theme";
const DEFAULT_THEME = "obsidian-violet";

let currentId = DEFAULT_THEME;

// v2 model: the palette shown right now (`currentId`) is a PREVIEW; the one
// the user actually chose is `committedId` and lives on the daemon
// (~/.gaia/app.json, services/theme.ts) so every window opens the same.
// localStorage stays, but only as the pre-paint cache.
let committedId = DEFAULT_THEME;
/** @type {((theme: string) => void)|null} */
let persist = null;

/** Wire the daemon persistence hook once, from actions.js (keeps this module
 * free of any import of the API layer, so themes stay paint-only).
 * @param {(theme: string) => void} save */
export function setThemePersist(save) {
  persist = save;
}

/** The chosen palette, as opposed to whatever a hover is previewing. */
export function committedThemeId() {
  return committedId;
}

/** @param {string} id @returns {ThemeMeta} */
export function themeById(id) {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0];
}

export function currentThemeId() {
  return currentId;
}

/** Adopt the daemon's persisted palette (from /api/app). Empty/unknown id →
 * leave the local choice alone.
 * @param {string|undefined} id */
export function adoptServerTheme(id) {
  if (!id || themeById(id).id !== id || id === committedId) return;
  committedId = id;
  applyTheme(id);
}

/** Commit a palette: paint it, remember it, and persist it daemon-side.
 * @param {string} id */
export function commitTheme(id) {
  applyTheme(id);
  committedId = currentId;
  persist?.(currentId);
}

/** Drop a hover/focus preview and repaint the committed palette (v2: leaving
 * a swatch restores immediately, no Esc required). */
export function revertTheme() {
  if (currentId !== committedId) applyTheme(committedId);
}

/** Paint a palette WITHOUT committing it — preview only. @param {string} id */
export function previewTheme(id) {
  applyTheme(id);
}

/** @param {string} id */
export function applyTheme(id) {
  const theme = themeById(id);
  currentId = theme.id;
  const root = document.documentElement;
  root.dataset.theme = theme.id;
  root.classList.toggle("retro", Boolean(theme.retro));
  try {
    localStorage.setItem(STORAGE_KEY, theme.id);
  } catch {
    // private mode / storage disabled — theme just won't persist.
  }
}

// Restore before first paint so there is no flash of the default theme.
export function initTheme() {
  /** @type {string|null} */
  let saved;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    saved = null;
  }
  const initial = saved && themeById(saved).id === saved ? saved : DEFAULT_THEME;
  committedId = initial;
  applyTheme(initial);
}

/** Step through the catalogue; used by Alt+Shift+T. @param {number} [direction] */
export function cycleTheme(direction = 1) {
  const index = THEMES.findIndex((theme) => theme.id === currentId);
  const next = THEMES[(index + direction + THEMES.length) % THEMES.length];
  commitTheme(next.id);
}
