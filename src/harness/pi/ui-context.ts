// pi ExtensionUIContext adapter (LANE D, chat-mto9n58s-bjr1) — the actual
// call-site pi.ts/runtime.ts binds to a session (see runtime.ts's LANE-D
// marker). Bridges every ExtensionUIContext method (pi's
// dist/core/extensions/types.d.ts) onto a Lane B UiBridge (ui-bridge.ts),
// or no-ops with pi's OWN documented headless default (dist/core/
// extensions/runner.js's noOpUIContext) when there is no room analogue.
// Kept separate from ui-bridge.ts on purpose: ui-bridge.ts is pi-agnostic
// and independently testable (test/ext-ui-events.test.ts); everything here
// is allowed to import pi's own (public) types.

import type {
  ExtensionRunner,
  ExtensionUIContext,
  ExtensionUIDialogOptions,
  ExtensionWidgetOptions,
  LoadExtensionsResult,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { newId } from "../../core/ids.js";
import type { UiPromptField, UiPromptReplyValue } from "../../core/types.js";
import type { UiBridge } from "./ui-bridge.js";

// pi's own interactive-mode default (dialog.signal-cancel aside) never blocks
// forever; ours can't rely on a human at a terminal, so an unanswered dialog
// falls back to pi's noOp value after this long rather than hang the turn.
const DEFAULT_UI_TIMEOUT_MS = 10 * 60 * 1000;

/** Race `promise` against `timeoutMs` and `signal` abort, whichever comes
 * first; the loser's outcome is discarded (a late bridge reply still calls
 * resolvePrompt() successfully — it just has nothing left awaiting it). */
function withTimeout<T>(
  promise: Promise<T>,
  fallback: T,
  timeoutMs = DEFAULT_UI_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve) => {
    let settled = false;
    const finish = (value: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish(fallback);
    const timer = setTimeout(() => finish(fallback), timeoutMs);
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(finish, () => finish(fallback));
  });
}

/** Normalize a `ui.reply` value into text for select/input/editor prompts —
 * a plain string is the direct answer; a single-field form reply carries it
 * under `value` (see the `fields: [{name:"value", ...}]` convention below). */
function toText(value: UiPromptReplyValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  return value.value ?? Object.values(value)[0];
}

/** Same convention for confirm()'s boolean answer. */
function toBool(value: UiPromptReplyValue): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value === "true";
  const first = value.value ?? Object.values(value)[0];
  return first === "true";
}

/** Build a full ExtensionUIContext bound to one session's UiBridge. Every
 * method in pi's dist/core/extensions/types.d.ts is implemented — see the
 * behaviour table in the Lane D summon return for bridged/no-op/unreachable
 * per method. */
export function buildPiUiContext(bridge: UiBridge): ExtensionUIContext {
  return {
    async select(title, options, opts?: ExtensionUIDialogOptions) {
      const value = await withTimeout(
        bridge.prompt("select", title, { fields: [{ name: "value", kind: "select", options }] }),
        undefined as unknown as UiPromptReplyValue,
        opts?.timeout,
        opts?.signal,
      );
      return toText(value);
    },
    async confirm(title, message, opts?: ExtensionUIDialogOptions) {
      const value = await withTimeout(bridge.prompt("confirm", title, { message }), false, opts?.timeout, opts?.signal);
      return toBool(value);
    },
    async input(title, placeholder, opts?: ExtensionUIDialogOptions) {
      const fields: UiPromptField[] | undefined =
        placeholder !== undefined ? [{ name: "value", kind: "text", placeholder }] : undefined;
      const value = await withTimeout(
        bridge.prompt("input", title, fields ? { fields } : undefined),
        undefined as unknown as UiPromptReplyValue,
        opts?.timeout,
        opts?.signal,
      );
      return toText(value);
    },
    // No ui.notify AgentEvent exists (ui-bridge.ts's vocabulary is widget/
    // prompt/authRequest/shortcut/lifecycle only) — per Lane D's task spec,
    // notify/setStatus route through the SAME bridge.widget() ui-bridge
    // already exposes rather than growing a sixth event kind for one-shot
    // toasts. Each call gets a fresh widget id so repeated notifications
    // stack as distinct rows; a client is free to auto-dismiss them.
    notify(message, type) {
      bridge.widget(newId("notify"), "aboveEditor", [type && type !== "info" ? `[${type}] ${message}` : message]);
    },
    // Raw terminal keystrokes have no meaning over a room transport — matches
    // pi's own noOpUIContext exactly (unsubscribe no-op).
    onTerminalInput() {
      return () => {};
    },
    setStatus(key, text) {
      bridge.widget(`status:${key}`, "belowEditor", text !== undefined ? [text] : []);
    },
    // Streaming-loader chrome (spinner frames/visibility/label) is rendered by
    // the CLIENT from its own turn-streaming state, not driven by the agent —
    // no room analogue; matches pi's own no-op defaults.
    setWorkingMessage() {},
    setWorkingVisible() {},
    setWorkingIndicator() {},
    setHiddenThinkingLabel() {},
    setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions) {
      if (content === undefined) {
        bridge.widget(key, options?.placement ?? "aboveEditor", []);
        return;
      }
      if (Array.isArray(content)) {
        bridge.widget(key, options?.placement ?? "aboveEditor", content as string[]);
        return;
      }
      // Component-factory form (TUI-only render function) isn't serializable
      // over the wire — no-op, matches pi's own headless default.
    },
    // Footer/header/title are terminal-chrome component factories — no room
    // analogue; matches pi's own no-op defaults.
    setFooter() {},
    setHeader() {},
    setTitle() {},
    // Arbitrary TUI Component factory with keyboard focus — fundamentally not
    // representable over the wire; pi's own default resolves undefined.
    async custom() {
      return undefined as never;
    },
    // Composer-editor manipulation (paste/set/get raw text) has no room
    // transport equivalent that wouldn't fight the human's own composer —
    // matches pi's own no-op/empty-string defaults.
    pasteToEditor() {},
    setEditorText() {},
    getEditorText() {
      return "";
    },
    // `editor` IS one of ui.prompt's documented kinds (see harness.ts) — bridged.
    async editor(title, prefill) {
      const value = await withTimeout(
        bridge.prompt("editor", title, prefill !== undefined ? { message: prefill } : undefined),
        undefined as unknown as UiPromptReplyValue,
      );
      return toText(value);
    },
    addAutocompleteProvider() {},
    setEditorComponent() {},
    getEditorComponent() {
      return undefined;
    },
    // Never exercised headless (no rendering pipeline reads it); pi's own
    // `theme` singleton isn't part of the package's public export surface
    // (only the `Theme` class/type is — see dist/index.d.ts), so a real
    // instance can't be constructed without importing pi's private module
    // path. Stubbed to satisfy the interface; UNREACHABLE in practice.
    get theme(): Theme {
      return {} as Theme;
    },
    getAllThemes() {
      return [];
    },
    getTheme() {
      return undefined;
    },
    setTheme() {
      return { success: false, error: "UI not available" };
    },
    getToolsExpanded() {
      return false;
    },
    setToolsExpanded() {},
  };
}

/** Extension-registered keyboard shortcuts have no interactive keybinding
 * loop to fire them headless — `runner.getShortcuts()` (the same accessor
 * the TUI's own dispatcher calls) is the SDK's one enumeration point
 * (dist/core/extensions/runner.d.ts). Called once per session right after
 * `bindExtensions()`; `{}` as the "resolved keybindings" argument means no
 * built-in keybinding claims a key first — harmless headless, since nothing
 * else here dispatches by key at all. */
export function bindPiShortcuts(runner: ExtensionRunner, bridge: UiBridge): void {
  type ResolvedKeybindings = Parameters<ExtensionRunner["getShortcuts"]>[0];
  const shortcuts = runner.getShortcuts({} as ResolvedKeybindings);
  for (const [key, shortcut] of shortcuts) {
    const commandId = newId("shortcut");
    bridge.registerShortcut(commandId, key, shortcut.description, () => shortcut.handler(runner.createContext()));
  }
}

/** Extension load/failure lifecycle: `loader.getExtensions()` (already
 * computed at session construction) gives load-time state; `runner.onError`
 * additionally catches RUNTIME handler failures for the rest of the session.
 * pi has no extension "dispose" event (no unload/reload-teardown hook exists
 * in dist/core/extensions/*) — `disposed` is UNREACHABLE, never emitted. */
export function bindPiLifecycle(
  loader: { getExtensions(): LoadExtensionsResult },
  runner: ExtensionRunner,
  bridge: UiBridge,
): void {
  const { extensions, errors } = loader.getExtensions();
  for (const ext of extensions) bridge.lifecycle(ext.path, "loaded");
  for (const err of errors) bridge.lifecycle(err.path, "failed", err.error);
  runner.onError((err) => bridge.lifecycle(err.extensionPath, "failed", `${err.event}: ${err.error}`));
}

/** Extension-registered slash commands (Lane E, chat-mto9n58s-bjr1): the ONE
 * enumeration point (`runner.getRegisteredCommands()`, same accessor family
 * as getShortcuts) mirrors every registered `pi.registerCommand(name, …)`
 * into `ext.commands` so a client/room can see what real dispatch now exists
 * (see runtime.ts's send()'s ext-command branch — the actual invocation site,
 * via `runner.getCommand(name)!.handler(args, runner.createCommandContext())`,
 * never re-implemented here). Called once per session right after
 * bindPiShortcuts/bindPiLifecycle (same first-turn timing — see `uiBound`). */
export function bindPiCommands(runner: ExtensionRunner, bridge: UiBridge): void {
  const commands = runner.getRegisteredCommands().map((command) => ({
    name: command.invocationName,
    ...(command.description ? { description: command.description } : {}),
  }));
  bridge.commands(commands);
}

// ---------------------------------------------------------------------------
// Provider OAuth login wrap (Lane D task item 3). `ModelRuntime.login(
// providerId, type, interaction)` (dist/core/model-runtime.d.ts:74, public —
// `ModelRuntime` is exported from the package index) is the ONE reachable
// entry point for ANY provider login, extension-registered or built-in: an
// extension's own `pi.registerProvider(name, {oauth:{login(callbacks)}})` is
// adapted internally (dist/core/provider-composer.js's adaptOAuth) into this
// SAME shape, so wrapping here covers every provider uniformly (RULE #0) —
// no per-provider/per-extension wrapping needed. `AuthInteraction`/`AuthType`/
// `AuthPrompt`/`AuthEvent`/`Credential` aren't re-exported from pi-ai's public
// index.d.ts, so the shapes are reproduced here (structural typing — no
// private import) verbatim from node_modules/@earendil-works/pi-ai/dist/
// auth/types.d.ts. UNVERIFIED-reachable: nothing in this harness calls
// `modelRuntime.login()` today (no `uiLogin` capability exists on
// AgentRuntime/HarnessSpec — only uiReply/uiShortcutFire do); the wrap itself
// is directly unit-tested (test/pi-runtime.test.ts) against a bridge, proving
// the mapping is correct independent of that missing trigger.

export type PiAuthPrompt = { signal?: AbortSignal } & (
  | { type: "text"; message: string; placeholder?: string }
  | { type: "secret"; message: string; placeholder?: string }
  | { type: "select"; message: string; options: readonly { id: string; label: string; description?: string }[] }
  | { type: "manual_code"; message: string; placeholder?: string }
);

export type PiAuthEvent =
  | { type: "info"; message: string; links?: readonly { url: string; label?: string }[] }
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number }
  | { type: "progress"; message: string };

export interface PiAuthInteraction {
  signal?: AbortSignal;
  prompt(prompt: PiAuthPrompt): Promise<string>;
  notify(event: PiAuthEvent): void;
}

/** Build the `interaction` argument `ModelRuntime.login(providerId, type,
 * interaction)` expects, routed through the same auth.request/ui.reply
 * channel as everything else in this file. */
export function wrapAuthInteraction(bridge: UiBridge, providerId: string): PiAuthInteraction {
  return {
    notify(event) {
      switch (event.type) {
        case "auth_url":
          void bridge.authRequest(providerId, "oauth", {
            url: event.url,
            ...(event.instructions ? { instructions: event.instructions } : {}),
          });
          return;
        case "device_code":
          void bridge.authRequest(providerId, "device", {
            deviceCode: {
              userCode: event.userCode,
              verificationUri: event.verificationUri,
              ...(event.intervalSeconds !== undefined ? { intervalSeconds: event.intervalSeconds } : {}),
              ...(event.expiresInSeconds !== undefined ? { expiresInSeconds: event.expiresInSeconds } : {}),
            },
          });
          return;
        case "info":
        case "progress":
          // No ack leg even in pi's own interactive dialog (showInfo/
          // showProgress never await a reply) — nothing to bridge.
          return;
      }
    },
    async prompt(prompt) {
      const method = prompt.type === "secret" ? "apiKey" : "oauth";
      const field: UiPromptField =
        prompt.type === "select"
          ? { name: "value", kind: "select", label: prompt.message, options: prompt.options.map((o) => o.id) }
          : {
              name: "value",
              kind: "text",
              label: prompt.message,
              secret: prompt.type === "secret",
              ...("placeholder" in prompt && prompt.placeholder ? { placeholder: prompt.placeholder } : {}),
            };
      const value = await bridge.authRequest(providerId, method, { instructions: prompt.message, fields: [field] });
      return toText(value) ?? "";
    },
  };
}
