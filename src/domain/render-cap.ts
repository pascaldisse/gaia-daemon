// Generic display-time render cap (see services/plugins.ts PluginRenderCap).
// Content-agnostic on purpose: this module has zero knowledge of WHICH plugin
// asked for a cap or why — it only knows how to derive a shown string from a
// stored one, on demand, at every display surface. The stored text is NEVER
// mutated (root-cause policy: truncating before persisting destroys real
// replies forever the moment a cap applies — see RoomService#commitReply).
export interface RenderCap {
  /** Keep at most this many lines of the real text, from the top. <= 0 shows
   * nothing — the real words are trimmed away, never replaced by fabricated
   * text (no injected prefix/placeholder of any kind lives in this module). */
  maxLines: number;
  /** Optional system-authored chrome note persisted alongside the cap — see
   * RoomService's synthesized companion event. Never part of the capped text
   * itself. */
  note?: string;
}

/** Pure mechanical trim — the only thing that ever shortens a real reply for
 * DISPLAY, and it never fabricates a replacement: maxLines<=0 yields "" (the
 * real text is trimmed away entirely, not swapped for invented text);
 * otherwise the FIRST `maxLines` lines of the real text survive. */
export function applyRenderCap(text: string, cap: RenderCap): string {
  if (cap.maxLines <= 0) return "";
  return text.split("\n").slice(0, cap.maxLines).join("\n").trim();
}

/** What a client/reader should actually see for one persisted (text, cap)
 * pair — the full text, unless a cap applies. Every display call site shares
 * this one function so the live bubble, a post-reload transcript fetch, and a
 * read-aloud request always agree. */
export function displayEventText(text: string, cap: RenderCap | undefined): string {
  return cap ? applyRenderCap(text, cap) : text;
}
