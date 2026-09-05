import { test } from "bun:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { installMacTitlebar, isMacNativeShell } from "../web/src/native.js";

const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("native titlebar spans panes; height and fullscreen inset remain parameters", () => {
  const css = source("web/src/styles.css");
  assert.match(css, /--macos-titlebar-height: 38px/);
  assert.match(css, /body\.macos-titlebar-overlay \.tabbar \{ grid-column: 1 \/ -1; height: var\(--macos-titlebar-height\); padding-left: var\(--titlebar-inset\); \}/);
  assert.match(css, /body\.macos-titlebar-overlay :is\(\.sidebar, \.right, \.col-resizer\) \{ grid-row: 2; \}/);
  assert.match(css, /grid-template-rows: var\(--macos-titlebar-height\) minmax\(0, 1fr\)/);
  assert.doesNotMatch(css, /padding-top: 38px/);
});

test("stock Tauri direct-target markers cover bar, brand descendants and empty space, not tabs/buttons", () => {
  const tabs = source("web/src/tabsbar.js");
  assert.doesNotMatch(tabs, /"data-tauri-drag-region": "(?:deep|false)"/);
  assert.equal((tabs.match(/"data-tauri-drag-region": true/g) ?? []).length, 5);
  assert.match(source("web/src/render.js"), /id: "tabbar", "data-tauri-drag-region": true/);
  assert.doesNotMatch(tabs.slice(tabs.indexOf("function Tab(")), /data-tauri-drag-region/);
  for (const button of tabs.matchAll(/h\("button", \{([^}]+)\}/g)) {
    assert.doesNotMatch(button[1], /data-tauri-drag-region/);
  }
});

test("main and spawned windows share configurable centred traffic-light coordinates", () => {
  const rust = source("src-tauri/src/lib.rs");
  assert.equal((rust.match(/\.traffic_light_position\(traffic_light_position\(\)\)/g) ?? []).length, 2);
  assert.match(rust, /coordinate\("GAIA_TITLEBAR_TRAFFIC_LIGHT_X", 12\.0\)/);
  assert.match(rust, /coordinate\("GAIA_TITLEBAR_TRAFFIC_LIGHT_Y", 21\.0\)/);
});

test("native inset follows OS + DOM fullscreen, restores custom/default inset, browser untouched", async () => {
  const saved = new Map(["window", "document", "navigator"].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const properties = new Map<string, string>();
  const classes = new Set<string>();
  const listeners = new Map<string, () => void>();
  let fullscreen = false;
  let bridgeFails = false;
  let resized = () => {};
  const current = {
    isFullscreen: async () => { if (bridgeFails) throw new Error("offline"); return fullscreen; },
    onResized: async (fn: () => void) => { resized = fn; return () => {}; },
  };
  const win = {
    __TAURI__: { window: { getCurrentWindow: () => current } } as unknown,
    addEventListener: (name: string, fn: () => void) => listeners.set(name, fn),
  };
  const doc = {
    fullscreenElement: null as unknown,
    documentElement: { style: { setProperty: (key: string, value: string) => properties.set(key, value) } },
    body: { classList: { add: (key: string) => classes.add(key), toggle: (key: string, on: boolean) => on ? classes.add(key) : classes.delete(key) } },
    addEventListener: win.addEventListener,
  };
  try {
    for (const [key, value] of Object.entries({ window: win, document: doc, navigator: { platform: "MacIntel" } })) {
      Object.defineProperty(globalThis, key, { value, configurable: true });
    }
    assert.equal(isMacNativeShell(), true);
    installMacTitlebar();
    await Promise.resolve();
    assert.equal(properties.get("--titlebar-inset"), "76px");
    assert.ok(classes.has("macos-titlebar-overlay"));
    fullscreen = true;
    resized();
    await Promise.resolve();
    assert.equal(properties.get("--titlebar-inset"), "0px");
    assert.ok(classes.has("macos-titlebar-fullscreen"));
    fullscreen = false;
    listeners.get("resize")!();
    await Promise.resolve();
    assert.equal(properties.get("--titlebar-inset"), "76px");
    installMacTitlebar({ inset: "90px" });
    await Promise.resolve();
    assert.equal(properties.get("--titlebar-inset"), "90px");
    doc.fullscreenElement = {};
    listeners.get("fullscreenchange")!();
    await Promise.resolve();
    assert.equal(properties.get("--titlebar-inset"), "0px");
    doc.fullscreenElement = null;
    bridgeFails = true;
    resized();
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(properties.get("--titlebar-inset"), "90px");
    win.__TAURI__ = undefined;
    assert.equal(isMacNativeShell(), false);
    properties.clear();
    installMacTitlebar();
    assert.equal(properties.size, 0);
    win.__TAURI__ = { window: { getCurrentWindow: () => current } };
    Object.defineProperty(globalThis, "navigator", { value: { platform: "Linux x86_64" }, configurable: true });
    assert.equal(isMacNativeShell(), false);
    installMacTitlebar();
    assert.equal(properties.size, 0);
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

test("native pixel proof captures this process's window, not an external screen helper", () => {
  const rust = source("src-tauri/src/debug_server.rs");
  assert.match(rust, /\("GET", "\/screenshot\/window"\) => match native_window_png\(app, "main"\)/);
  assert.match(rust, /window\.ns_window\(\)/);
  assert.match(rust, /CGWindowListCreateImage\(Rect/);
  assert.match(rust, /CGImageRelease\(image\)/);
});
