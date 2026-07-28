// @ts-nocheck — intentional minimal DOM shim; not app code, exercised via bun test.
// Renders the REAL transcript.js <gaia:think> path against a minimal DOM shim.
// Run: bun test web/src/gaia-think.test.js
import { expect, test } from "bun:test";

class Node {}
class TextNode extends Node {
  constructor(text) { super(); this.nodeType = 3; this.data = String(text); }
}
class Fragment extends Node {
  constructor() { super(); this.nodeType = 11; this.childNodes = []; }
  append(...kids) { for (const k of kids) this.childNodes.push(k); }
}
class Element extends Node {
  constructor(tag) { super(); this.nodeType = 1; this.tagName = tag; this.attributes = {}; this.childNodes = []; this._class = ""; this._text = null; }
  set className(v) { this._class = String(v); }
  get className() { return this._class; }
  set textContent(v) { this._text = String(v); this.childNodes = []; }
  get textContent() { return this._text ?? ""; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return this.attributes[k] ?? null; }
  addEventListener() {}
  append(...kids) {
    for (const k of kids) {
      if (k == null || k === false) continue;
      if (k instanceof Fragment) { for (const c of k.childNodes) this.childNodes.push(c); }
      else this.childNodes.push(k);
    }
  }
}
globalThis.Node = Node;
globalThis.document = {
  createElement: (t) => new Element(t),
  createTextNode: (t) => new TextNode(t),
  createDocumentFragment: () => new Fragment(),
  querySelector: () => null,
};
globalThis.window = globalThis;
globalThis.location = { href: "http://localhost/", search: "", hash: "" };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.navigator = { userAgent: "bun" };

function serialize(node) {
  if (node instanceof TextNode) return node.data;
  if (node instanceof Fragment) return node.childNodes.map(serialize).join("");
  const attrs = [];
  if (node._class) attrs.push(`class="${node._class}"`);
  for (const [k, v] of Object.entries(node.attributes)) attrs.push(`${k}="${v}"`);
  const open = `<${node.tagName}${attrs.length ? " " + attrs.join(" ") : ""}>`;
  const inner = node._text != null ? node._text : node.childNodes.map(serialize).join("");
  return `${open}${inner}</${node.tagName}>`;
}

const { AgentText, splitLeadingGaiaThink } = await import("./transcript.js");

test("splitLeadingGaiaThink: leading closed block", () => {
  expect(splitLeadingGaiaThink("<gaia:think>weighing</gaia:think>the answer")).toEqual({
    thought: "weighing", remainder: "the answer", closed: true,
  });
});

test("splitLeadingGaiaThink: unclosed leading block (streaming)", () => {
  expect(splitLeadingGaiaThink("<gaia:think>still reasoning")).toEqual({
    thought: "still reasoning", remainder: "", closed: false,
  });
});

test("splitLeadingGaiaThink: non-leading occurrence is ignored", () => {
  expect(splitLeadingGaiaThink("answer <gaia:think>x</gaia:think>")).toBeNull();
});

test("AgentText: closed block -> collapsed thinking expander with 鳴 marker + remainder markdown", () => {
  const html = serialize(AgentText("id1", "<gaia:think>weighing the options</gaia:think>Real answer.", false));
  // mirrors native thinking: activity-details + thinking class, collapsed (no open attr)
  expect(html).toContain('class="activity-details thinking gaia-think complete"');
  expect(html).not.toContain("open");
  // marker symbol differs: 鳴 not 💭
  expect(html).toContain('class="activity-icon" aria-hidden="true">鳴</span>');
  expect(html).toContain("weighing the options");
  // remainder renders as its own markdown block after the expander
  expect(html).toContain("Real answer.");
});

test("AgentText: unclosed while streaming -> running expander, whole rest is thought", () => {
  const html = serialize(AgentText("id2", "<gaia:think>still reasoning", true));
  expect(html).toContain('class="activity-details thinking gaia-think running"');
  expect(html).toContain("still reasoning");
});

test("AgentText: no leading block -> plain markdown, no thinking expander", () => {
  const html = serialize(AgentText("id3", "Just a normal reply.", false));
  expect(html).not.toContain("activity-details");
  expect(html).toContain("Just a normal reply.");
});

test("AgentText: literal non-leading tag is escaped as text (no raw HTML / XSS)", () => {
  const html = serialize(AgentText("id4", "Hello <gaia:think>evil</gaia:think> world", false));
  // rendered via text nodes, never as a real <details> block
  expect(html).not.toContain("activity-details");
  expect(html).toContain("Hello <gaia:think>evil");
});
