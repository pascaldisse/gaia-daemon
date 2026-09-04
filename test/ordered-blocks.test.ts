// @ts-nocheck — intentional minimal DOM shim for the browser renderer.
import { expect, mock, test } from "bun:test";

// `web/src/design` is a submodule symlink whose host-relative imports resolve
// outside the web tree under Bun. OrderedBlocks does not exercise artifacts.
mock.module("../web/src/design/artifacts.js", () => ({
  artifactPanelOpen: () => false,
  detectArtifacts: () => [],
  roomArtifacts: () => [],
  selectArtifact: () => {},
  selectedArtifact: () => null,
  setArtifactPanelOpen: () => {},
  toggleArtifactPanel: () => {},
  upsertArtifact: () => {},
}));

class Node {}
class TextNode extends Node {
  constructor(text) { super(); this.nodeType = 3; this.data = String(text); }
}
class Fragment extends Node {
  constructor() { super(); this.nodeType = 11; this.childNodes = []; }
  append(...children) { this.childNodes.push(...children.filter((child) => child != null && child !== false)); }
}
class Element extends Node {
  constructor(tag) {
    super();
    this.nodeType = 1;
    this.tagName = tag;
    this.attributes = {};
    this.childNodes = [];
    this._class = "";
    this._text = null;
  }
  set className(value) { this._class = String(value); }
  get className() { return this._class; }
  set textContent(value) { this._text = String(value); this.childNodes = []; }
  get textContent() { return this._text ?? ""; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  addEventListener() {}
  append(...children) {
    for (const child of children) {
      if (child == null || child === false) continue;
      if (child instanceof Fragment) this.childNodes.push(...child.childNodes);
      else this.childNodes.push(child);
    }
  }
}

globalThis.Node = Node;
globalThis.document = {
  createElement: (tag) => new Element(tag),
  createTextNode: (text) => new TextNode(text),
  createDocumentFragment: () => new Fragment(),
  querySelector: () => null,
};
globalThis.window = globalThis;
globalThis.location = { href: "http://localhost/", search: "", hash: "" };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.navigator = { userAgent: "bun" };

function serialize(node) {
  if (node == null) return "";
  if (node instanceof TextNode) return node.data;
  if (node instanceof Fragment) return node.childNodes.map(serialize).join("");
  const attributes = [];
  if (node._class) attributes.push(`class="${node._class}"`);
  for (const [key, value] of Object.entries(node.attributes)) attributes.push(`${key}="${value}"`);
  const inner = node._text != null ? node._text : node.childNodes.map(serialize).join("");
  return `<${node.tagName}${attributes.length ? ` ${attributes.join(" ")}` : ""}>${inner}</${node.tagName}>`;
}

const { OrderedBlocks } = await import("../web/src/transcript.js");

test("OrderedBlocks renders leading GAIA thoughts in every text span", () => {
  const blocks = [
    { kind: "text", text: "<gaia:think>A</gaia:think>first reply" },
    { kind: "tool", id: "tool-1" },
    { kind: "text", text: "<gaia:think>B</gaia:think>second reply" },
  ];
  const rendered = OrderedBlocks({ id: "event-1", streaming: false }, blocks, []);
  const fragment = document.createDocumentFragment();
  fragment.append(...rendered);
  const html = serialize(fragment);

  expect(html.match(/class="activity-details thinking gaia-think complete"/g)).toHaveLength(2);
  expect(html).toContain("A");
  expect(html).toContain("B");
  expect(html).toContain("first reply");
  expect(html).toContain("second reply");
});
