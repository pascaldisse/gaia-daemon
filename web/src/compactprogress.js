// Live /compact progress: a one-line detail (job size · elapsed · summary-so-far),
// a progress BAR, and a self-arming 1s tick so both advance between server
// snapshots. Shared by the panel and composer so both read one formatter.
import { h } from "./dom.js";
import { markDirty } from "./render.js";

/** @typedef {import("../../src/core/types.js").CompactProgress} CompactProgress */

/** Human token count: 1234 -> "1.2k", 295000 -> "295k". @param {number} n */
function tokens(n) {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  return `${Math.round(n / 1000)}k`;
}

/** mm:ss elapsed since a start epoch. @param {number} startedAt */
function elapsed(startedAt) {
  const s = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/**
 * One-line progress detail, e.g. "295k tokens · 2:34 · 1.2k written". Elapsed
 * always shows (it proves the pass is alive even when the harness reports no
 * token counts); the token parts appear only when reported.
 * @param {CompactProgress} c
 */
export function compactDetail(c) {
  const parts = [];
  if (c.contextTokens) parts.push(`${tokens(c.contextTokens)} tokens`);
  parts.push(elapsed(c.startedAt));
  if (c.outputTokens) parts.push(`${tokens(c.outputTokens)} written`);
  return parts.join(" · ");
}

/**
 * Estimated fraction complete (0..1), or null when the job size is unknown
 * (render indeterminate). Time-based against a throughput-derived estimate —
 * a measured real pass ran 295k tokens in 161s (~1.8k tokens/s) plus ~12s of
 * CLI startup. Linear to 90% over the estimate, then an asymptotic creep
 * toward 99%: the bar only ever reads "done" by disappearing when the pass
 * actually finishes, so a slow pass shows a slowing bar, never a lying one.
 * @param {CompactProgress} c
 */
export function compactFraction(c) {
  if (!c.contextTokens) return null;
  const estMs = 12_000 + (c.contextTokens / 1800) * 1000;
  const t = (Date.now() - c.startedAt) / estMs;
  return t <= 1 ? 0.9 * t : 0.9 + 0.09 * (1 - Math.exp((1 - t) / 0.5));
}

/**
 * The progress bar element. Determinate (width = estimated fraction) when the
 * job size is known; an indeterminate slide otherwise.
 * @param {CompactProgress} c
 */
export function CompactBar(c) {
  const frac = compactFraction(c);
  return h(
    "span",
    { class: `compact-bar${frac === null ? " indeterminate" : ""}`, title: "estimated compaction progress" },
    h("span", { class: "compact-bar-fill", style: frac === null ? null : `width:${(frac * 100).toFixed(1)}%` }),
  );
}

// One shared timer. While any agent is compacting, re-render panel + composer
// each second so the elapsed advances without a server round-trip. Every render
// that still sees a compacting agent re-arms it; it stops when none remain.
/** @type {ReturnType<typeof setTimeout>|null} */
let timer = null;
/** @param {boolean} anyCompacting */
export function armCompactTick(anyCompacting) {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  if (anyCompacting) timer = setTimeout(() => markDirty("panel", "composer"), 1000);
}
