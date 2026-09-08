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
  append(...children) { for (const child of children) { if (child instanceof Fragment) this.childNodes.push(...child.childNodes); else if (child != null && child !== false) this.childNodes.push(child); } }
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
    this.listeners = {};
  }
  set className(value) { this._class = String(value); }
  get className() { return this._class; }
  set textContent(value) { this._text = String(value); this.childNodes = []; }
  get textContent() { return this._text ?? ""; }
  setAttribute(key, value) { this.attributes[key] = String(value); }
  getAttribute(key) { return this.attributes[key] ?? null; }
  remove() { if (this.parentNode) this.parentNode.childNodes = this.parentNode.childNodes.filter(child => child !== this); }
  replaceChildren(...children) { this.childNodes = []; this._text = null; this.append(...children); }
  get open() { return "open" in this.attributes; }
  set open(value) { if (value) this.attributes.open = ""; else delete this.attributes.open; }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  toggle(open) { this.open = open; this.listeners.toggle?.({ currentTarget: this }); }
  append(...children) {
    for (const child of children) {
      if (child == null || child === false) continue;
      if (child instanceof Fragment) this.childNodes.push(...child.childNodes);
      else { this.childNodes.push(child); child.parentNode = this; }
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
  const inner = node._text != null ? node._text : node.innerHTML ?? node.childNodes.map(serialize).join("");
  return `<${node.tagName}${attributes.length ? ` ${attributes.join(" ")}` : ""}>${inner}</${node.tagName}>`;
}

const { OrderedBlocks, ToolActivity, SkillInvocationActivity } = await import("../web/src/transcript.js");

const { state } = await import("../web/src/state.js");

test("OrderedBlocks defers collapsed GAIA thoughts but keeps visible text spans", () => {
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
  expect(html).not.toContain("trace-body");
  const thoughts = fragment.childNodes.filter(node => node.tagName === "details");
  thoughts.forEach(node => node.toggle(true));
  expect(serialize(thoughts[0])).toContain(">A<");
  expect(serialize(thoughts[1])).toContain(">B<");
  expect(html).toContain("first reply");
  expect(html).toContain("second reply");
});


test("closed tool bodies skip payload serialization; expand once and preserve body on reopen", () => {
  let serialized = 0;
  const tool = { id: "lazy-tool", toolName: "bash", status: "complete", args: { command: "echo marker", toJSON() { serialized++; return { command: "echo marker" }; } }, result: "marker" };
  const details = ToolActivity(tool);
  expect(serialized).toBe(0);
  expect(serialize(details)).not.toContain("trace-body");
  details.toggle(true);
  expect(serialized).toBe(1);
  expect(serialize(details)).toContain("trace-bash-output");
  expect(serialize(details)).toContain("marker");
  const body = details.childNodes[1];
  details.toggle(false); details.toggle(true);
  expect(serialized).toBe(1);
  expect(details.childNodes[1]).toBe(body);
  expect(details.childNodes).toHaveLength(2);
  details.toggle(false);
});

test("restored-open tool renders updated payload synchronously", () => {
  const tool = { id: "restored-tool", toolName: "bash", status: "running", args: { command: "echo output" }, partialResult: "first" };
  const first = ToolActivity(tool); first.toggle(true);
  const updated = ToolActivity({ ...tool, status: "complete", result: "latest result" });
  expect(updated.open).toBe(true);
  expect(serialize(updated)).toContain("latest result");
  expect(serialize(updated)).toContain("trace-body");
  updated.toggle(false);
});

test("native thinking and skill content are lazy; encrypted thinking still opens", () => {
  const [thought, encrypted] = OrderedBlocks({ id: "lazy-native", streaming: false }, [{kind:"thinking",text:"hidden reasoning"},{kind:"thinking",text:""}], []);
  const skill = SkillInvocationActivity({ name:"probe", location:"/probe/SKILL.md", content:"hidden skill" });
  for (const row of [thought, encrypted, skill]) {
    expect(serialize(row)).not.toContain("trace-body"); row.toggle(true);
  }
  expect(serialize(thought)).toContain("hidden reasoning");
  expect(serialize(encrypted)).toContain("reasoning not returned");
  expect(serialize(skill)).toContain("hidden skill");
  for (const row of [thought, encrypted, skill]) row.toggle(false);
});
