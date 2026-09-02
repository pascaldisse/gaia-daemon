// Rich payload rendering — ported from gaia-daemon v2 web/src/rich.ts.
// One place for: JSON tinting, source syntax tinting, unified-diff blocks with
// word-level change highlight, bounded (show-more) line lists, numbered file
// previews. Tool traces (transcript.js) render THROUGH here; nothing else may
// re-implement a payload renderer.
//
// Token mapping v2 → v1: --dim → --muted · --alert → --danger · --sel → --bg3.

import { h } from "./dom.js";

/** Lines painted per page before a "show more" reveal (v2 BOUNDED_PREVIEW_LINES). */
const BOUNDED_PREVIEW_LINES = 300;

/** @param {string} value @returns {string} */
function escapeHtml(value) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** JSON (or raw string) with key/string/number/literal tinting. Returns HTML.
 * @param {unknown} value @returns {string} */
export function jsonHtml(value) {
  let source;
  if (typeof value === "string") source = value;
  else {
    try {
      source = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      source = String(value);
    }
  }
  const escaped = escapeHtml(source);
  return escaped.replace(
    /(&quot;[^&\n]*?&quot;)(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?)/g,
    (match, stringToken, colon, literal, number) => {
      if (stringToken) return `<span class="${colon ? "j-key" : "j-string"}">${stringToken}</span>${colon ?? ""}`;
      if (number) return `<span class="j-number">${number}</span>`;
      if (literal) return `<span class="j-literal">${literal}</span>`;
      return match;
    },
  );
}

/** Source-code tinting (keywords/strings/numbers/comments). Returns HTML.
 * @param {string} source @returns {string} */
export function syntaxHtml(source) {
  const pattern =
    /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b(?:const|let|var|function|class|interface|type|return|if|else|for|while|async|await|import|export|from|new|throw|try|catch|true|false|null|undefined|extends|implements|readonly|public|private)\b)/g;
  let result = "";
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    const at = match.index ?? 0;
    result += escapeHtml(source.slice(cursor, at));
    const token = match[0];
    let className = "syn-kw";
    if (/^(\/\*|\/\/|#)/.test(token)) className = "syn-com";
    else if (/^["'`]/.test(token)) className = "syn-str";
    else if (/^\d/.test(token)) className = "syn-num";
    result += `<span class="${className}">${escapeHtml(token)}</span>`;
    cursor = at + token.length;
  }
  return result + escapeHtml(source.slice(cursor));
}

/** @typedef {{ text: string, changed: boolean }} DiffToken */

/** @param {string} value @returns {string[]} */
function tokenize(value) {
  return value.match(/\s+|[A-Za-z0-9_$]+|[^\sA-Za-z0-9_$]/g) ?? [];
}

/** Word-level diff of one removed vs one added line (v2 wordDiff, LCS).
 * @param {string} oldText @param {string} newText
 * @returns {{ oldTokens: DiffToken[], newTokens: DiffToken[] }} */
export function wordDiff(oldText, newText) {
  const a = tokenize(oldText);
  const b = tokenize(newText);
  const n = a.length;
  const m = b.length;
  /** @type {Uint32Array[]} */
  const dp = [];
  for (let i = 0; i <= n; i += 1) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      const row = dp[i];
      const next = dp[i + 1];
      if (!row || !next) continue;
      row[j] = a[i] === b[j] ? (next[j + 1] ?? 0) + 1 : Math.max(next[j] ?? 0, row[j + 1] ?? 0);
    }
  }
  const oldChanged = new Array(n).fill(true);
  const newChanged = new Array(m).fill(true);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      oldChanged[i] = false;
      newChanged[j] = false;
      i += 1;
      j += 1;
    } else if ((dp[i + 1]?.[j] ?? 0) >= (dp[i]?.[j + 1] ?? 0)) i += 1;
    else j += 1;
  }
  return {
    oldTokens: a.map((text, index) => ({ text, changed: Boolean(oldChanged[index]) })),
    newTokens: b.map((text, index) => ({ text, changed: Boolean(newChanged[index]) })),
  };
}

/** Changed tokens get the inverse highlight; whitespace never does.
 * @param {DiffToken[]} tokens @returns {DocumentFragment} */
export function diffTokenNode(tokens) {
  const fragment = document.createDocumentFragment();
  for (const token of tokens) {
    if (token.changed && token.text.trim()) {
      fragment.append(h("span", { class: "chg", text: token.text }));
    } else fragment.append(document.createTextNode(token.text));
  }
  return fragment;
}

/** Unified diff text → gutter-numbered add/remove/context rows with word-level
 * highlight on paired −/+ lines (v2 diffBlock).
 * @param {string} source @returns {HTMLElement} */
export function diffBlock(source) {
  const block = h("div", { class: "diff-block" });
  const lines = source.split("\n");
  let oldLine = 0;
  let newLine = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      block.append(row("hunk", "", line));
      continue;
    }
    if (/^(diff |index |--- |\+\+\+ )/.test(line)) {
      block.append(row("meta", "", line));
      continue;
    }
    if (line.startsWith("-")) {
      const paired = lines[index + 1];
      if (paired !== undefined && paired.startsWith("+")) {
        const { oldTokens, newTokens } = wordDiff(line.slice(1), paired.slice(1));
        block.append(row("remove", String(oldLine), "", diffTokenNode(oldTokens)));
        block.append(row("add", String(newLine), "", diffTokenNode(newTokens)));
        oldLine += 1;
        newLine += 1;
        index += 1;
        continue;
      }
      block.append(row("remove", String(oldLine), line.slice(1)));
      oldLine += 1;
      continue;
    }
    if (line.startsWith("+")) {
      block.append(row("add", String(newLine), line.slice(1)));
      newLine += 1;
      continue;
    }
    block.append(row("context", String(newLine), line.startsWith(" ") ? line.slice(1) : line));
    oldLine += 1;
    newLine += 1;
  }
  return block;

  /** @param {string} kind @param {string} gutter @param {string} text @param {Node} [node] */
  function row(kind, gutter, text, node) {
    const body = h("span", { class: "diff-text" });
    if (node) body.append(node);
    else body.textContent = text;
    return h("div", { class: `diff-line ${kind}` }, h("span", { class: "diff-gutter", text: gutter }), body);
  }
}

/** Paint at most BOUNDED_PREVIEW_LINES lines with a local reveal button — the
 * payload is already in hand, nothing is re-fetched (v2 boundedLines).
 * @param {readonly string[]} lines @param {string} className
 * @param {(line: string, index: number) => Node} renderLine @returns {HTMLElement} */
export function boundedLines(lines, className, renderLine) {
  const wrapper = h("div", { class: "trace-bounded" });
  const pre = h("pre", { class: className });
  const more = h("button", { class: "trace-show-more", type: "button" });
  let shown = Math.min(lines.length, BOUNDED_PREVIEW_LINES);
  const paint = () => {
    pre.replaceChildren();
    for (let index = 0; index < shown; index += 1) {
      pre.append(renderLine(lines[index] ?? "", index));
      if (index < shown - 1) pre.append(document.createTextNode("\n"));
    }
    if (shown < lines.length) more.textContent = `\u2026 show ${lines.length - shown} more lines`;
    else more.remove();
  };
  more.addEventListener("click", () => {
    shown = Math.min(lines.length, shown + BOUNDED_PREVIEW_LINES);
    paint();
  });
  paint();
  wrapper.append(pre);
  if (shown < lines.length) wrapper.append(more);
  return wrapper;
}

/** Numbered file preview (v2 readResultNode body).
 * @param {string} text @param {number} [firstLine] @returns {HTMLElement} */
export function filePreview(text, firstLine = 1) {
  return boundedLines(text.split("\n"), "file-preview", (line, index) => {
    const row = h("span", {});
    row.append(h("span", { class: "line-number", text: String(firstLine + index).padStart(5) }), document.createTextNode(` ${line}`));
    return row;
  });
}

/** Fenced source with a language caption (v2 codeBlock).
 * @param {string} source @param {string} language @returns {HTMLElement} */
export function codeBlock(source, language) {
  const pre = h("pre", {});
  pre.innerHTML = syntaxHtml(source);
  return h("figure", { class: "code-block" }, h("figcaption", { text: language || "text" }), pre);
}

/** Generic result payload: diff → diff block · {lines:[{line,text}]} → numbered
 * preview · string → pre · anything else → tinted JSON (v2 resultNode).
 * @param {unknown} value @returns {Node} */
export function resultNode(value) {
  const row = /** @type {Record<string, unknown>} */ (value && typeof value === "object" ? value : {});
  const diff = row.diff ?? (typeof row.type === "string" && row.type.includes("diff") ? value : undefined);
  if (typeof diff === "string") return diffBlock(diff);
  const lines = Array.isArray(row.lines) ? row.lines : [];
  if (lines.length > 0 && lines.every((item) => item && typeof item === "object")) {
    const pre = h("pre", { class: "file-preview" });
    lines.forEach((item, index) => {
      const record = /** @type {Record<string, unknown>} */ (item);
      const line = h("span", {});
      const number = typeof record.line === "number" ? record.line : index + 1;
      line.append(h("span", { class: "line-number", text: String(number).padStart(5) }), document.createTextNode(` ${String(record.text ?? "")}`));
      pre.append(line);
    });
    return pre;
  }
  if (typeof value === "string") return h("pre", { text: value });
  const pre = h("pre", {});
  pre.innerHTML = jsonHtml(value);
  return pre;
}
