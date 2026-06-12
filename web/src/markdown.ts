import { h } from "./dom.ts";
import { LinkedText } from "./links.ts";

export function MarkdownMessage(text) {
  const root = h("div", { class: "markdown-message" });
  const lines = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  let block = [];
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

function renderMarkdownBlock(root, lines) {
  if (lines.length === 1) {
    const heading = lines[0].match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      root.append(h(`h${Math.min(6, heading[1].length)}`, {}, InlineMarkdown(heading[2])));
      return;
    }
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

function InlineMarkdown(text) {
  const nodes = [];
  const pattern = /`([^`\n]+)`/g;
  let cursor = 0;
  for (const match of String(text ?? "").matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push(LinkedText(text.slice(cursor, index)));
    nodes.push(h("code", {}, LinkedText(match[1])));
    cursor = index + match[0].length;
  }
  if (cursor < text.length) nodes.push(LinkedText(text.slice(cursor)));
  return nodes;
}

function CodeBlock(lang, code) {
  return h(
    "div",
    { class: "code-block" },
    lang ? h("div", { class: "code-lang", text: lang }) : null,
    h("pre", {}, h("code", {}, LinkedText(code))),
  );
}
