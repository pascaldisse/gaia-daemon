// Semantic selector adapter — a stable, named vocabulary of "things on the
// claude.ai/design page" (login check, prompt box, send button, canvas root,
// design title) mapped to concrete DOM queries. Deliberately ISOLATED from
// the CDP transport: this module returns plain strings (JS expressions) or
// evaluates against an injected `evalFn`, never touches WebSocket/CDP
// directly, so the page's DOM changing on redesign only means editing the
// table below — callers and transport stay untouched. Mirrors the plan's
// requirement: "stable semantic selector adapter isolated from transport".

/** Canonical semantic element names this adapter understands. */
export const SEMANTIC = Object.freeze({
  LOGGED_IN_MARKER: "logged-in-marker",
  DESIGN_PROMPT_INPUT: "design-prompt-input",
  DESIGN_SEND_BUTTON: "design-send-button",
  DESIGN_CANVAS_ROOT: "design-canvas-root",
  DESIGN_TITLE: "design-title",
});

// Each entry: an ordered list of CSS selectors, most-specific/most-stable
// first, falling back to looser ones. `query` returns the first that
// matches at least one element (as a JS boolean/text expression string);
// `all` returns every candidate for diagnostics (`inspect`).
const TABLE = {
  [SEMANTIC.LOGGED_IN_MARKER]: [
    "[data-testid=chat-input]",
    "div[contenteditable=true]",
    "nav a[href^=\"/chat\"]",
    "[data-testid=user-menu-button]",
    "textarea", // present on the authenticated /design composer too
  ],
  [SEMANTIC.DESIGN_PROMPT_INPUT]: [
    "[data-testid=design-prompt-input]",
    "textarea[placeholder*=\"design\" i]",
    "div[contenteditable=true]",
    "textarea",
  ],
  [SEMANTIC.DESIGN_SEND_BUTTON]: [
    "[data-testid=design-send-button]",
    "button[aria-label*=\"send\" i]",
    "button[type=submit]",
  ],
  [SEMANTIC.DESIGN_CANVAS_ROOT]: [
    "[data-testid=design-canvas]",
    "[data-testid=artifact-canvas]",
    "main canvas",
    "main [class*=canvas]",
  ],
  [SEMANTIC.DESIGN_TITLE]: [
    "[data-testid=design-title]",
    "h1",
    "[contenteditable=true][role=heading]",
  ],
};

function assertKnown(name) {
  if (!(name in TABLE)) throw new Error(`unknown semantic selector: ${name}`);
}

/** Candidate CSS selectors for a semantic name, most-stable first. */
export function candidatesFor(name) {
  assertKnown(name);
  return [...TABLE[name]];
}

/** JS expression: boolean, true if any candidate for `name` matches. */
export function existsExpr(name) {
  const list = candidatesFor(name)
    .map((sel) => `document.querySelector(${JSON.stringify(sel)})`)
    .join(" || ");
  return `!!(${list})`;
}

/** JS expression: first matching element's selector string, or null. */
export function firstMatchExpr(name) {
  const arr = JSON.stringify(candidatesFor(name));
  return `(() => { for (const sel of ${arr}) if (document.querySelector(sel)) return sel; return null; })()`;
}

/**
 * Resolve a semantic name against a live page via `evalFn` (typically
 * `page.eval`), returning `{ matched, selector }`. Isolated here so a
 * transport swap (CDP -> something else) never touches selector logic.
 */
export async function resolve(evalFn, name) {
  const selector = await evalFn(firstMatchExpr(name));
  return { matched: !!selector, selector: selector || null };
}

/** Diagnostics: which of a semantic's candidate selectors matched, one by one. */
export async function inspectAll(evalFn, name) {
  const candidates = candidatesFor(name);
  const results = [];
  for (const sel of candidates) {
    const matched = await evalFn(`!!document.querySelector(${JSON.stringify(sel)})`);
    results.push({ selector: sel, matched: !!matched });
  }
  return results;
}
