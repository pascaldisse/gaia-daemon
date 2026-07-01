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
];

const STORAGE_KEY = "gaia.theme";
const DEFAULT_THEME = "tokyo-night";

let currentId = DEFAULT_THEME;

/** @param {string} id @returns {ThemeMeta} */
export function themeById(id) {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0];
}

export function currentThemeId() {
  return currentId;
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
  applyTheme(saved && themeById(saved).id === saved ? saved : DEFAULT_THEME);
}

/** Step through the catalogue; used by Alt+Shift+T. @param {number} [direction] */
export function cycleTheme(direction = 1) {
  const index = THEMES.findIndex((theme) => theme.id === currentId);
  const next = THEMES[(index + direction + THEMES.length) % THEMES.length];
  applyTheme(next.id);
}
