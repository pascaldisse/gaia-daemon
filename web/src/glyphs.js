// The UI's symbol vocabulary — ONE place, ported from gaia-daemon v2
// (v2 web/src/normalize.ts AGENT_GLYPHS + transcript.ts KIND/STATE glyphs).
//
// Law: monochrome unicode, never emoji, except the three marks v2 itself
// keeps for activity kinds (thinking/tool/skill). Colour comes from the
// theme's CSS variables, never from the glyph — so every palette recolours
// the whole symbol set for free.
//
// Call sites import from here; no component defines its own glyph.

/** Per-agent identity marks (v2 normalize.ts). Unknown ghouls share ⛧;
 * anything else falls back to the neutral ring. */
export const AGENT_GLYPHS = /** @type {Record<string, string>} */ ({
  ari: "♛",
  nyari: "☾",
  gaia: "☉",
  code: "▣",
  dario: "♜",
  echo: "◌",
});

/** @param {string} agentId @returns {string} */
export function agentGlyph(agentId) {
  const id = (agentId ?? "").toLowerCase();
  return AGENT_GLYPHS[id] ?? (id.startsWith("ghoul") ? "⛧" : "◈");
}

/** Activity kinds inside a turn (v2 transcript.ts KIND_GLYPH). */
export const KIND = {
  thinking: "💭",
  tool: "🛠",
  skill: "🧩",
  compaction: "✂",
  handoff: "↩︎",
  warning: "⚠",
};

/** Run states (v2 transcript.ts STATE_GLYPH). */
export const STATE = {
  running: "⠧",
  done: "✓",
  error: "×",
};

/** Chrome + control glyphs. v2 where v2 has one; same monochrome family
 * where the element exists only in v1 (attachments, incognito, calls). */
export const UI = {
  brand: "◆",
  theme: "◈",
  human: "❯",
  system: "◇",
  send: "▸",
  sendBusy: "»",
  edit: "✎",
  retry: "↻",
  close: "×",
  search: "⌕",
  favorite: "★",
  favoriteOff: "☆",
  incognito: "⊚",
  attach: "▤",
  memory: "◍",
  watchdog: "◉",
  mic: "⌁",
  recording: "⏺",
  micMuted: "⌁̸",
  call: "☏",
  stop: "◼",
  twistyOpen: "▾",
  twistyClosed: "▸",
};
