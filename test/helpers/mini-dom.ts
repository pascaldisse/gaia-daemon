// Minimal real DOM-node graph for exercising the ACTUAL web render path in bun
// (no jsdom/happy-dom in the repo). Implements exactly what web/src/dom.js's h(),
// reconcile.js and the sidebar render touch: createElement/createTextNode,
// className, textContent, get/has/set/removeAttribute, addEventListener +
// dispatch, childNodes/firstChild/nextSibling, append/insertBefore/removeChild/
// replaceChildren, dataset, classList, querySelector(All) for #id/.class/tag.
// insertBefore RELOCATES (never clones) a node, so carried-over instances keep
// identity — the property the sidebar fix rests on.

// Base class exposed as the global `Node` so h()'s `child instanceof Node` works.
export class MiniNode {
  parentNode: MElement | null = null;
}

export class MText extends MiniNode {
  nodeType = 3;
  data: string;
  constructor(data: string) { super(); this.data = data; }
  get textContent(): string { return this.data; }
}

export type MNode = MElement | MText;

export class MElement extends MiniNode {
  nodeType = 1;
  tag: string;
  parentNode: MElement | null = null;
  childNodes: MNode[] = [];
  private _class = "";
  private attrs = new Map<string, string>();
  listeners = new Map<string, ((event: any) => void)[]>();
  dataset: Record<string, string> = {};
  scrollTop = 0;
  constructor(tag: string) { super(); this.tag = tag; }

  get className(): string { return this._class; }
  set className(v: string) { this._class = String(v); }
  get id(): string { return this.attrs.get("id") ?? ""; }

  get classList() {
    const tokens = () => this._class.split(/\s+/).filter(Boolean);
    return {
      add: (c: string) => { const t = tokens(); if (!t.includes(c)) { t.push(c); this._class = t.join(" "); } },
      remove: (c: string) => { this._class = tokens().filter(x => x !== c).join(" "); },
      contains: (c: string) => tokens().includes(c),
      toggle: (c: string, on?: boolean) => { const has = tokens().includes(c); const want = on ?? !has; if (want) this.classList.add(c); else this.classList.remove(c); return want; },
    };
  }

  setAttribute(k: string, v: string): void { if (k === "class") { this._class = String(v); return; } this.attrs.set(k, String(v)); }
  getAttribute(k: string): string | null { if (k === "class") return this._class === "" ? null : this._class; return this.attrs.has(k) ? this.attrs.get(k)! : null; }
  hasAttribute(k: string): boolean { if (k === "class") return this._class !== ""; return this.attrs.has(k); }
  removeAttribute(k: string): void { if (k === "class") { this._class = ""; return; } this.attrs.delete(k); }

  addEventListener(type: string, fn: (event: any) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  removeEventListener(type: string, fn: (event: any) => void): void { this.listeners.set(type, (this.listeners.get(type) ?? []).filter(f => f !== fn)); }
  setPointerCapture(): void {}
  releasePointerCapture(): void {}

  get firstChild(): MNode | null { return this.childNodes[0] ?? null; }
  get nextSibling(): MNode | null {
    if (!this.parentNode) return null;
    const i = this.parentNode.childNodes.indexOf(this);
    return this.parentNode.childNodes[i + 1] ?? null;
  }

  insertBefore(node: MNode, ref: MNode | null): MNode {
    if (node.parentNode) node.parentNode.removeChild(node);
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i >= 0) this.childNodes.splice(i, 0, node); else this.childNodes.push(node);
    node.parentNode = this;
    return node;
  }
  appendChild(node: MNode): MNode { return this.insertBefore(node, null); }
  append(...nodes: (MNode | string)[]): void { for (const n of nodes) this.appendChild(typeof n === "string" ? new MText(n) : n); }
  removeChild(node: MNode): MNode {
    const i = this.childNodes.indexOf(node);
    if (i >= 0) { this.childNodes.splice(i, 1); node.parentNode = null; }
    return node;
  }
  replaceChildren(...nodes: (MNode | string)[]): void {
    for (const c of this.childNodes) c.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }

  get textContent(): string { return this.childNodes.map(c => c.textContent).join(""); }
  set textContent(v: string) { for (const c of this.childNodes) c.parentNode = null; this.childNodes = []; if (v !== "") this.appendChild(new MText(String(v))); }

  querySelector(sel: string): MElement | null { return matchAll(this, sel)[0] ?? null; }
  querySelectorAll(sel: string): MElement[] { return matchAll(this, sel); }
  getBoundingClientRect() { return { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 }; }

  /** Fire a bound listener (test-only helper; not a DOM API). */
  dispatch(type: string, event: Record<string, unknown> = {}): void {
    const ev = { type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, button: 0, ...event };
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(ev);
  }
}

function matches(el: MElement, sel: string): boolean {
  if (sel.startsWith("#")) return el.id === sel.slice(1);
  if (sel.startsWith(".")) return el.className.split(/\s+/).includes(sel.slice(1));
  return el.tag === sel;
}
function matchAll(root: MElement, sel: string): MElement[] {
  const out: MElement[] = [];
  const walk = (el: MElement) => {
    for (const child of el.childNodes) {
      if (child instanceof MElement) { if (matches(child, sel)) out.push(child); walk(child); }
    }
  };
  walk(root);
  return out;
}

export class StorageStub {
  values = new Map<string, string>();
  get length(): number { return this.values.size; }
  key(i: number): string | null { return [...this.values.keys()][i] ?? null; }
  getItem(k: string): string | null { return this.values.get(k) ?? null; }
  setItem(k: string, v: string): void { this.values.set(k, v); }
  removeItem(k: string): void { this.values.delete(k); }
  clear(): void { this.values.clear(); }
}

/**
 * Install a MiniDOM into globalThis and return the document root + #sidebar nav.
 * requestAnimationFrame runs its callback SYNCHRONOUSLY so markDirty() flushes
 * the real registered region renderers inline within a test.
 */
export function installMiniDom(): { root: MElement; nav: MElement; storage: StorageStub } {
  const storage = new StorageStub();
  const root = new MElement("body");
  const nav = new MElement("nav");
  nav.setAttribute("id", "sidebar");
  root.appendChild(nav);
  const document = {
    createElement: (tag: string) => new MElement(tag),
    createTextNode: (text: string) => new MText(text),
    querySelector: (sel: string) => (matches(root, sel) ? root : root.querySelector(sel)),
    querySelectorAll: (sel: string) => root.querySelectorAll(sel),
    addEventListener() {},
    documentElement: { style: { setProperty() {}, getPropertyValue: () => "" } },
    body: root,
    visibilityState: "visible",
    hasFocus: () => true,
  };
  Object.assign(globalThis, {
    Node: MiniNode,
    localStorage: storage,
    sessionStorage: storage,
    window: { localStorage: storage, sessionStorage: storage, setInterval, clearInterval, setTimeout, clearTimeout, addEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) },
    document,
    navigator: { platform: "MacIntel", userAgent: "test" },
    requestAnimationFrame: (cb: (t: number) => void) => { cb(0); return 0; },
    cancelAnimationFrame: () => {},
  });
  return { root, nav, storage };
}
