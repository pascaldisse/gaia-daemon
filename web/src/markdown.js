// Minimal markdown subset for agent messages: headings, lists, blockquotes,
// fenced code blocks, inline code. Everything else stays literal text (with
// openable link tokens).
import { h } from "./dom.js";
import { LinkedText } from "./links.js";

/** @param {string} text */
export function MarkdownMessage(text) {
  const root = h("div", { class: "markdown-message" });
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  /** @type {string[]} */
  let block = [];
  /** @type {{ lang: string, lines: string[] }|null} */
  let code = null;

  const flushBlock = () => {
    while (block.length > 0 && block[0].trim() === "") block.shift();
    while (block.length > 0 && block[block.length - 1].trim() === "") block.pop();
    if (block.length === 0) return;
    renderMarkdownBlock(root, block);
    block = [];
  };

  for (const line of lines) {
    const fence = line.match(/^```([a-z0-9_-]*)\s*$/i);
    if (fence) {
      if (code) {
        root.append(CodeBlock(code.lang, code.lines.join("\n")));
        code = null;
      } else {
        flushBlock();
        code = { lang: fence[1] ?? "", lines: [] };
      }
      continue;
    }
    if (code) code.lines.push(line);
    else if (line.trim() === "") flushBlock();
    else block.push(line);
  }

  if (code) root.append(CodeBlock(code.lang, code.lines.join("\n")));
  flushBlock();
  return root;
}

/** @param {HTMLElement} root @param {string[]} lines */
function renderMarkdownBlock(root, lines) {
  if (lines.length === 1) {
    const heading = lines[0].match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      root.append(h(`h${Math.min(6, heading[1].length)}`, {}, InlineMarkdown(heading[2])));
      return;
    }
  }

  // GFM table: a header row, a `|---|:--:|` delimiter row, then data rows. The
  // delimiter row is the signal (a lone pipe-y line isn't a table); column
  // alignment comes from the `:` markers on each delimiter cell.
  if (lines.length >= 2 && lines[0].includes("|") && isTableDelimiter(lines[1])) {
    const aligns = splitTableRow(lines[1]).map((cell) => {
      const left = cell.startsWith(":");
      const right = cell.endsWith(":");
      return left && right ? "center" : right ? "right" : left ? "left" : "";
    });
    /** @param {string} tag @param {string} text @param {number} i */
    const cell = (tag, text, i) =>
      h(tag, aligns[i] ? { style: `text-align:${aligns[i]}` } : {}, InlineMarkdown(text));
    const headers = splitTableRow(lines[0]);
    root.append(
      h(
        "div",
        { class: "md-table-wrap" },
        h(
          "table",
          { class: "md-table" },
          h("thead", {}, h("tr", {}, headers.map((c, i) => cell("th", c, i)))),
          h(
            "tbody",
            {},
            lines.slice(2).map((line) => {
              const row = splitTableRow(line);
              return h("tr", {}, headers.map((_, i) => cell("td", row[i] ?? "", i)));
            }),
          ),
        ),
      ),
    );
    return;
  }

  if (lines.every((line) => /^[-*]\s+/.test(line))) {
    root.append(h("ul", {}, lines.map((line) => h("li", {}, InlineMarkdown(line.replace(/^[-*]\s+/, ""))))));
    return;
  }

  if (lines.every((line) => /^\d+\.\s+/.test(line))) {
    root.append(h("ol", {}, lines.map((line) => h("li", {}, InlineMarkdown(line.replace(/^\d+\.\s+/, ""))))));
    return;
  }

  if (lines.every((line) => /^>\s?/.test(line))) {
    root.append(h("blockquote", {}, InlineMarkdown(lines.map((line) => line.replace(/^>\s?/, "")).join("\n"))));
    return;
  }

  root.append(h("p", {}, InlineMarkdown(lines.join("\n"))));
}

// A GFM table delimiter row: pipe-separated cells of dashes with optional `:`
// alignment markers, e.g. `|---|:--:|--:|`. Requires at least one pipe so a
// horizontal-rule-ish line can't masquerade as a one-column table.
/** @param {string} line @returns {boolean} */
function isTableDelimiter(line) {
  return line.includes("|") && /^\s*\|?(\s*:?-+:?\s*\|)+\s*:?-*:?\s*$/.test(line);
}

// Split a table row on unescaped pipes, dropping the empties that optional
// leading/trailing edge pipes create, then trim each cell.
/** @param {string} line @returns {string[]} */
function splitTableRow(line) {
  /** @type {string[]} */
  const cells = [];
  let cur = "";
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\" && line[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (line[i] === "|") {
      cells.push(cur);
      cur = "";
    } else {
      cur += line[i];
    }
  }
  cells.push(cur);
  if (cells.length > 0 && cells[0].trim() === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1].trim() === "") cells.pop();
  return cells.map((c) => c.trim());
}

// Inline spans, ordered so a longer delimiter wins over its own prefix (`**`
// before `*`). Emphasis requires a non-space just inside each delimiter — the
// CommonMark-ish flanking rule that keeps prose like "a * b" or "5 * 3" literal.
// Only asterisk forms are parsed: underscores are left alone so snake_case and
// __dunder__ identifiers (everywhere in a dev chat) never render as emphasis.
// Code content is literal; emphasis content is re-parsed so nesting works. The
// italic opener has a `(?<!\*)` guard so the trailing star of an unclosed `**`
// (e.g. a bare `**/*.ts` glob) can't seed a stray single-star emphasis.
const INLINE_PATTERN = /`([^`\n]+)`|\*\*(\S(?:[^\n]*?\S)?)\*\*|(?<!\*)\*([^\s*](?:[^\n]*?[^\s*])?)\*/g;

/** @param {string} text @returns {Node[]} */
function InlineMarkdown(text) {
  /** @type {Node[]} */
  const nodes = [];
  const source = String(text ?? "");
  let cursor = 0;
  for (const match of source.matchAll(INLINE_PATTERN)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(LinkedText(source.slice(cursor, index)));
    if (match[1] !== undefined) nodes.push(h("code", {}, LinkedText(match[1])));
    else if (match[2] !== undefined) nodes.push(h("strong", {}, InlineMarkdown(match[2])));
    else if (match[3] !== undefined) nodes.push(h("em", {}, InlineMarkdown(match[3])));
    cursor = index + match[0].length;
  }
  if (cursor < source.length) nodes.push(LinkedText(source.slice(cursor)));
  return nodes;
}

/** @param {string} lang @param {string} code */
function CodeBlock(lang, code) {
  return h(
    "div",
    { class: "code-block" },
    lang ? h("div", { class: "code-lang", text: lang }) : null,
    h("pre", {}, h("code", {}, LinkedText(code))),
  );
}
