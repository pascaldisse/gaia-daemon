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
const documentListeners = {};
globalThis.document = {
  createElement: (tag) => new Element(tag),
  createTextNode: (text) => new TextNode(text),
  addEventListener: (type, listener) => { documentListeners[type] = listener; },
  body: { classList: { toggle() {} } },
};
globalThis.location = { href: "http://localhost/", search: "", hash: "" };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
const opened = [];
globalThis.window = { open: (...args) => opened.push(args), addEventListener() {} };
const { LinkedText, installOpenModifierTracking } = await import("./links.js");
installOpenModifierTracking();
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
function nativeFetch(requests) {
  globalThis.window.__TAURI__ = {};
  globalThis.fetch = async (url, options) => {
    requests.push([url, options]);
    return { ok: true, json: async () => ({}) };
  };
}
test("browser Cmd/Ctrl mousedown opens a chat link immediately and its following click does not double-open", () => {
  delete globalThis.window.__TAURI__;
  opened.length = 0;
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
test("native chat web links use the daemon open-target API", () => {
  const requests = [];
  nativeFetch(requests);
  opened.length = 0;
  const root = LinkedText("https://example.com/docs");
  const token = root.childNodes.find((node) => node instanceof Element && node._class === "link-token");
  token.listeners.mousedown(mouseEvent("meta"));
  expect(opened).toEqual([]);
  expect(requests).toEqual([["/api/open-target", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target: "https://example.com/docs", workspaceId: undefined }),
  }]]);
});
test("plain click on an agent-message HTTP(S) link dispatches native open-target", () => {
  const requests = [];
  nativeFetch(requests);
  const root = LinkedText("https://example.com/plain");
  const token = root.childNodes.find((node) => node instanceof Element && node._class === "link-token");
  const click = mouseEvent();
  token.listeners.click(click);
  expect(click.prevented).toBe(true);
  expect(click.stopped).toBe(true);
  expect(requests).toEqual([["/api/open-target", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target: "https://example.com/plain", workspaceId: undefined }),
  }]]);
});
test("native captures HTTP(S) anchors, including plain clicks, but leaves attachment links alone", () => {
  const requests = [];
  nativeFetch(requests);
  const anchor = {
    closest: (selector) => selector === "a[href]" ? anchor : null,
    getAttribute: (name) => name === "href" ? "https://example.com/sign-in" : null,
  };
  const click = { target: anchor, ...mouseEvent() };
  documentListeners.click(click);
  expect(click.prevented).toBe(true);
  expect(click.stopped).toBe(true);
  expect(requests).toEqual([["/api/open-target", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target: "https://example.com/sign-in", workspaceId: undefined }),
  }]]);

  const attachment = {
    closest: () => attachment,
    getAttribute: () => "/api/attachments/a.png",
  };
  const attachmentClick = { target: attachment, ...mouseEvent("meta") };
  documentListeners.click(attachmentClick);
  expect(attachmentClick.prevented).toBe(false);
  expect(requests).toHaveLength(1);
});
