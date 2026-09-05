// Adapter translating pi's ExtensionUIContext-shaped calls (setWidget,
// select/confirm/input, registerShortcut, registerProvider's oauth.login)
// into the harness-uniform AgentEvent ui.* vocabulary (core/types/harness.ts)
// carried over the wire to the web client — headless, so extension code that
// only ever ran inside the pi TUI dialog stack works unchanged in a browser.
//
// This module is pure: it only knows AgentEvent + a caller-supplied `emit`.
// It has NO import of pi's own runtime types, so it is independently testable
// (test/ext-ui-events.test.ts) and safe for Lane A to wire without a circular
// dependency on src/harness/pi/runtime.ts.
//
// LANE A CALL SITE (src/harness/pi/runtime.ts — not touched here):
//   1. `const bridge = createUiBridge((event) => channel.push(event))` once per
//      turn's EventChannel (see events.ts), so ui.* events interleave with the
//      rest of the turn's AgentEvent stream at the exact position they fire.
//   2. Wrap the ExtensionUIContext passed into `pi.on(...)`/command handlers so
//      `ctx.ui.setWidget(key, lines, opts)` calls `bridge.widget(key, opts?.placement ?? "aboveEditor", lines ?? [])`
//      instead of (or in addition to, in TUI mode) the native pi widget.
//      `ctx.ui.select/confirm/input(...)` calls `bridge.prompt(...)` and
//      await its Promise instead of blocking on a terminal dialog.
//   3. `ExtensionAPI.registerShortcut(shortcut, {description, handler})`
//      additionally calls `bridge.registerShortcut(newId("shortcut"), shortcut, description, () => handler(ctx))`
//      so a client-fired commandId dispatches to the extension's REAL handler
//      (never re-implemented client-side — RULE #0).
//   4. `registerProvider(name, { oauth: { login(callbacks) { ... } } })`:
//      wrap `callbacks` so `onAuth(info)` → `bridge.authRequest(providerId, "oauth", { url: info.url, instructions: info.instructions })`,
//      `onDeviceCode(info)` → `bridge.authRequest(providerId, "device", { deviceCode: info })`,
//      `onPrompt(prompt)` / `onSelect(prompt)` → `bridge.authRequest(providerId, "apiKey", { instructions: prompt.message, fields: [...] })`
//      each awaited and resolved through the SAME `ui.reply` channel as prompt().
//   5. `AgentRuntime.uiReply(roomId, id, value)` → `bridge.resolvePrompt(id, value)`;
//      `AgentRuntime.uiShortcutFire(roomId, commandId)` → `bridge.fireShortcut(commandId)`.
//      Both are the ONLY two entry points host.ts/runner.ts drive back in —
//      see src/harness/runner.ts's "ui-reply"/"ui-shortcut-fire" cases.
//   6. Extension load/fail/dispose (wherever the pi loader reports these — see
//      docs/extensions.md) → `bridge.lifecycle(extensionId, state, reason)`.

import { newId } from "../../core/ids.js";
import type { AgentEvent, UiDeviceCodeInfo, UiPromptField, UiPromptReplyValue } from "../../core/types.js";

export interface UiBridge {
  /** ctx.ui.setWidget mirror. Pass `lines: []` to clear the row. */
  widget(id: string, placement: "aboveEditor" | "belowEditor", lines: string[]): void;
  /** ctx.ui.input/select/confirm mirror. Resolves when the client's `ui.reply`
   * lands (via resolvePrompt), or never if the client never answers — callers
   * that need a timeout race this against their own. */
  prompt(kind: "input" | "select" | "confirm" | "editor", title: string, opts?: { message?: string; fields?: UiPromptField[] }): Promise<UiPromptReplyValue>;
  /** registerProvider's oauth.login(callbacks) leg mirror — same reply channel
   * as prompt() (both are "one id-keyed dialog awaiting one answer"). */
  authRequest(providerId: string, method: "oauth" | "apiKey" | "device", opts?: { url?: string; instructions?: string; deviceCode?: UiDeviceCodeInfo; fields?: UiPromptField[] }): Promise<UiPromptReplyValue>;
  /** Resolve a pending prompt()/authRequest() by id (driven by AgentRuntime.uiReply).
   * Returns false when no such id is pending (already answered, timed out, or
   * never emitted — stale client reply). */
  resolvePrompt(id: string, value: UiPromptReplyValue): boolean;
  /** registerShortcut mirror: emits `ui.shortcut` and remembers the handler so
   * a later fireShortcut(commandId) can dispatch to it. */
  registerShortcut(commandId: string, key: string, description: string | undefined, handler: () => void | Promise<void>): void;
  /** Dispatch a client-fired commandId to its registered handler (driven by
   * AgentRuntime.uiShortcutFire). Returns false when commandId is unknown. */
  fireShortcut(commandId: string): boolean;
  /** Extension load/failure/dispose status chip. */
  lifecycle(id: string, state: "loaded" | "failed" | "disposed", reason?: string): void;
  /** registerCommand mirror (Lane E): this session's full registered-command
   * list, so a client/room can introspect what `/word`s now dispatch for
   * real (see runtime.ts's ext-command dispatch in send()). */
  commands(list: { name: string; description?: string }[]): void;
}

/** Build one UiBridge bound to a turn's event sink. `emit` is typically
 * `channel.push` (src/harness/events.ts EventChannel) so ui.* events land in
 * the same ordered AgentEvent stream as text/tool/thinking deltas. Pending
 * prompts/shortcuts are held IN this bridge instance — callers own its
 * lifetime (one per turn, or one per room session; never process-global, or
 * a reply from room A could resolve a prompt from room B). */
export function createUiBridge(emit: (event: AgentEvent) => void): UiBridge {
  const pending = new Map<string, (value: UiPromptReplyValue) => void>();
  const shortcuts = new Map<string, () => void | Promise<void>>();

  return {
    widget(id, placement, lines) {
      emit({ type: "ui.widget", id, placement, lines });
    },

    prompt(kind, title, opts) {
      const id = newId("uiprompt");
      return new Promise<UiPromptReplyValue>((resolve) => {
        pending.set(id, resolve);
        emit({ type: "ui.prompt", id, kind, title, ...(opts?.message ? { message: opts.message } : {}), ...(opts?.fields ? { fields: opts.fields } : {}) });
      });
    },

    authRequest(providerId, method, opts) {
      const id = newId("authreq");
      return new Promise<UiPromptReplyValue>((resolve) => {
        pending.set(id, resolve);
        emit({
          type: "auth.request",
          id,
          providerId,
          method,
          ...(opts?.url ? { url: opts.url } : {}),
          ...(opts?.instructions ? { instructions: opts.instructions } : {}),
          ...(opts?.deviceCode ? { deviceCode: opts.deviceCode } : {}),
          ...(opts?.fields ? { fields: opts.fields } : {}),
        });
      });
    },

    resolvePrompt(id, value) {
      const resolve = pending.get(id);
      if (!resolve) return false;
      pending.delete(id);
      resolve(value);
      return true;
    },

    registerShortcut(commandId, key, description, handler) {
      shortcuts.set(commandId, handler);
      emit({ type: "ui.shortcut", commandId, key, ...(description ? { description } : {}) });
    },

    fireShortcut(commandId) {
      const handler = shortcuts.get(commandId);
      if (!handler) return false;
      void handler();
      return true;
    },

    lifecycle(id, state, reason) {
      emit({ type: "ext.lifecycle", id, state, ...(reason ? { reason } : {}) });
    },

    commands(list) {
      emit({ type: "ext.commands", commands: list });
    },
  };
}
