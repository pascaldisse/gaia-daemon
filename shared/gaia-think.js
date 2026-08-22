// @ts-nocheck — text is raw streaming payload.
/** Parse the one leading GAIA thought block used by the transcript UI. */
export function splitLeadingGaiaThink(text) {
  const open = /^\s*<gaia:think>/u.exec(text);
  if (!open) return null;
  const rest = text.slice(open[0].length);
  const closeIdx = rest.indexOf("</gaia:think>");
  if (closeIdx === -1) return { thought: rest, remainder: "", closed: false };
  return { thought: rest.slice(0, closeIdx), remainder: rest.slice(closeIdx + "</gaia:think>".length), closed: true };
}
/** Remove all complete or unfinished GAIA thought spans for a foreign seat. */
export function stripGaiaThinking(text) {
  let remaining = String(text ?? "");
  let visible = "";
  while (true) {
    const open = remaining.search(/<gaia:think>/i);
    if (open < 0) return (visible + remaining).trim();
    visible += remaining.slice(0, open);
    const afterOpen = remaining.slice(open).search(/<\/gaia:think>/i);
    if (afterOpen < 0) return visible.trim();
    const closeEnd = open + afterOpen + "</gaia:think>".length;
    remaining = remaining.slice(closeEnd);
  }
}
