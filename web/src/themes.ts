// Omarchy-style theme engine. Each theme is one flat token map; everything the
// chrome needs derives from it. Edit/add a theme by adding one object here — no
// build step, it hot-applies. Persisted per-browser in localStorage.
//
// Token contract (every theme sets all of these):
//   bg   app background          fg     primary text
//   bg2  raised panel            muted  secondary text
//   bg3  inset / input           border hairline
//   accent  primary accent       accent2 secondary accent
//   good  running/success        warn   caution        danger  error
//   glow  shadow colour for accent glow ("none" disables)
//   font  the type stack         retro  true => CRT scanlines + pixel font

export const THEMES = [
  {
    id: "tokyo-night",
    name: "Tokyo Night",
    bg: "#16161e", bg2: "#1a1b26", bg3: "#222434", fg: "#c0caf5", muted: "#565f89",
    border: "#2a2e42", accent: "#7aa2f7", accent2: "#bb9af7",
    good: "#9ece6a", warn: "#e0af68", danger: "#f7768e", glow: "rgba(122,162,247,0.30)",
  },
  {
    id: "cyberpunk",
    name: "Cyberpunk",
    bg: "#0a0814", bg2: "#120d22", bg3: "#1c1438", fg: "#f0e9ff", muted: "#6f6398",
    border: "#2a1f4a", accent: "#00f0ff", accent2: "#ff2e97",
    good: "#00ff9f", warn: "#fcee0a", danger: "#ff2e63", glow: "rgba(0,240,255,0.42)",
  },
  {
    id: "catppuccin",
    name: "Catppuccin",
    bg: "#181825", bg2: "#1e1e2e", bg3: "#282a3a", fg: "#cdd6f4", muted: "#6c7086",
    border: "#313244", accent: "#89b4fa", accent2: "#cba6f7",
    good: "#a6e3a1", warn: "#f9e2af", danger: "#f38ba8", glow: "rgba(137,180,250,0.26)",
  },
  {
    id: "gruvbox",
    name: "Gruvbox",
    bg: "#1d2021", bg2: "#282828", bg3: "#32302f", fg: "#ebdbb2", muted: "#928374",
    border: "#3c3836", accent: "#fabd2f", accent2: "#fe8019",
    good: "#b8bb26", warn: "#fabd2f", danger: "#fb4934", glow: "rgba(250,189,47,0.24)",
  },
  {
    id: "nord",
    name: "Nord",
    bg: "#2e3440", bg2: "#343b49", bg3: "#3b4252", fg: "#e5e9f0", muted: "#7b88a1",
    border: "#434c5e", accent: "#88c0d0", accent2: "#81a1c1",
    good: "#a3be8c", warn: "#ebcb8b", danger: "#bf616a", glow: "rgba(136,192,208,0.24)",
  },
  {
    id: "everforest",
    name: "Everforest",
    bg: "#272e33", bg2: "#2d353b", bg3: "#374247", fg: "#d3c6aa", muted: "#859289",
    border: "#3d484d", accent: "#a7c080", accent2: "#7fbbb3",
    good: "#a7c080", warn: "#dbbc7f", danger: "#e67e80", glow: "rgba(167,192,128,0.24)",
  },
  {
    id: "kanagawa",
    name: "Kanagawa",
    bg: "#1a1a22", bg2: "#1f1f28", bg3: "#2a2a37", fg: "#dcd7ba", muted: "#727169",
    border: "#363646", accent: "#7e9cd8", accent2: "#957fb8",
    good: "#98bb6c", warn: "#ffa066", danger: "#e46876", glow: "rgba(126,156,216,0.26)",
  },
  {
    id: "rose-pine",
    name: "Rosé Pine",
    bg: "#16141f", bg2: "#191724", bg3: "#21202e", fg: "#e0def4", muted: "#6e6a86",
    border: "#26233a", accent: "#c4a7e7", accent2: "#ebbcba",
    good: "#9ccfd8", warn: "#f6c177", danger: "#eb6f92", glow: "rgba(196,167,231,0.26)",
  },
  {
    id: "dracula",
    name: "Dracula",
    bg: "#21222c", bg2: "#282a36", bg3: "#343746", fg: "#f8f8f2", muted: "#6272a4",
    border: "#44475a", accent: "#bd93f9", accent2: "#ff79c6",
    good: "#50fa7b", warn: "#f1fa8c", danger: "#ff5555", glow: "rgba(189,147,249,0.28)",
  },
  {
    id: "matte-black",
    name: "Matte Black",
    bg: "#000000", bg2: "#0c0c0c", bg3: "#161616", fg: "#e6e6e6", muted: "#6a6a6a",
    border: "#1f1f1f", accent: "#ededed", accent2: "#8a8a8a",
    good: "#79c07e", warn: "#d6b25e", danger: "#e5707a", glow: "none",
  },
  {
    id: "matrix",
    name: "Matrix",
    bg: "#020403", bg2: "#06110c", bg3: "#091912", fg: "#d5ffe9", muted: "#5f9c78",
    border: "#136b40", accent: "#1cff8b", accent2: "#19c269",
    good: "#1cff8b", warn: "#ffdf70", danger: "#ff5c7a", glow: "rgba(28,255,139,0.40)",
    retro: true,
  },
];

const MODERN_FONT =
  '"Berkeley Mono","JetBrains Mono","SF Mono","SFMono-Regular","Cascadia Code",ui-monospace,Menlo,Consolas,monospace';
const RETRO_FONT =
  '"Perfect DOS VGA 437","Px437 IBM VGA8","Fixedsys","Terminal",Menlo,"Courier New",monospace';

const STORAGE_KEY = "gaia.theme";
const DEFAULT_THEME = "tokyo-night";

export function themeById(id) {
  return THEMES.find((theme) => theme.id === id) ?? THEMES[0];
}

export function currentThemeId() {
  return state_themeId;
}

let state_themeId = DEFAULT_THEME;

// Map a theme's flat tokens onto CSS custom properties. We set both the new
// chrome variables and the legacy aliases (--line, --panel, --text, …) the
// older CSS still reads, so the whole stylesheet recolours from one source.
export function applyTheme(id) {
  const theme = themeById(id);
  state_themeId = theme.id;
  const root = document.documentElement;
  const font = theme.retro ? RETRO_FONT : MODERN_FONT;
  const vars = {
    "--bg": theme.bg, "--bg2": theme.bg2, "--bg3": theme.bg3,
    "--fg": theme.fg, "--muted": theme.muted,
    "--border": theme.border, "--border-strong": theme.accent,
    "--accent": theme.accent, "--accent2": theme.accent2,
    "--good": theme.good, "--warn": theme.warn, "--danger": theme.danger,
    "--glow": theme.glow, "--font": font,
    // legacy aliases used across the existing stylesheet
    "--panel": theme.bg2, "--panel2": theme.bg3,
    "--line": theme.accent, "--line-dim": theme.border,
    "--text": theme.fg, "--amber": theme.warn,
  };
  for (const [key, value] of Object.entries(vars)) root.style.setProperty(key, value);
  root.dataset.theme = theme.id;
  root.classList.toggle("retro", Boolean(theme.retro));
  try {
    localStorage.setItem(STORAGE_KEY, theme.id);
  } catch {
    // private mode / storage disabled — theme just won't persist.
  }
}

export function initTheme() {
  let saved;
  try {
    saved = localStorage.getItem(STORAGE_KEY);
  } catch {
    saved = null;
  }
  applyTheme(saved && themeById(saved).id === saved ? saved : DEFAULT_THEME);
}

// Step through the catalogue; used by the keyboard shortcut.
export function cycleTheme(direction = 1) {
  const index = THEMES.findIndex((theme) => theme.id === state_themeId);
  const next = THEMES[(index + direction + THEMES.length) % THEMES.length];
  applyTheme(next.id);
}
