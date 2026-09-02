// @ts-nocheck — minimal DOM shim; exercises the real link-token listeners.
import { expect, test } from "bun:test";
class Node {}
class TextNode extends Node {
  constructor(text) { super(); this.data = String(text); }
}
class Element extends Node {
  constructor(tag) { super(); this.tagName = tag; this.childNodes = []; this.listeners = {}; }
  set className(value) { this._class = String(value); }
  setAttribute() {}
  addEventListener(type, listener) { this.listeners[type] = listener; }
  append(...children) { this.childNodes.push(...children.filter(Boolean)); }
}
globalThis.Node = Node;
globalThis.document = {
  createElement: (tag) => new Element(tag),
  createTextNode: (text) => new TextNode(text),
};
globalThis.location = { href: "http://localhost/", search: "", hash: "" };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const opened = [];
globalThis.window = { open: (...args) => opened.push(args) };
const { LinkedText } = await import("./links.js");
function mouseEvent(modifier) {
  return {
    metaKey: modifier === "meta",
    ctrlKey: modifier === "ctrl",
    prevented: false,
    stopped: false,
    preventDefault() { this.prevented = true; },
    stopPropagation() { this.stopped = true; },
  };
}
test("Cmd/Ctrl mousedown opens a chat link immediately and its following click does not double-open", () => {
  const root = LinkedText("See https://example.com/docs.");
  const token = root.childNodes.find((node) => node instanceof Element && node._class === "link-token");
  expect(token).toBeDefined();
  const down = mouseEvent("meta");
  token.listeners.mousedown(down);
  expect(down.prevented).toBe(true);
  expect(down.stopped).toBe(true);
  expect(opened).toEqual([["https://example.com/docs", "_blank", "noopener"]]);

  token.listeners.click(mouseEvent("meta"));
  expect(opened).toHaveLength(1);

  const ctrlRoot = LinkedText("https://example.org");
  const ctrlToken = ctrlRoot.childNodes.find((node) => node instanceof Element && node._class === "link-token");
  ctrlToken.listeners.mousedown(mouseEvent("ctrl"));
  expect(opened.at(-1)).toEqual(["https://example.org", "_blank", "noopener"]);
});
