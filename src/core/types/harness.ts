import type { SkillInvocation } from "./events.js";

// ---------------------------------------------------------------------------
// Harness stream events (what a runtime yields during a turn)

export interface BackgroundTaskInfo {
  taskId: string;
  command?: string;
  description?: string;
  outputPath?: string;
}

export interface BackgroundTask extends BackgroundTaskInfo {
  toolName: string;
  startedAt: string;
  agentId: string;
  /** The room this process was launched from. Snapshots today only carry the
   * viewing room's own tasks, but the tray labels and jumps by this id
   * regardless — the one durable place a background task remembers its
   * origin, ready the moment a future snapshot ever merges other rooms' in. */
  roomId: string;
}

// ---------------------------------------------------------------------------
// pi ExtensionAPI surface carried over the wire, harness-agnostic (RULE #0):
// any harness that gains an equivalent UI/auth/shortcut surface emits the SAME
// vocabulary — no `harness === "pi"` branch anywhere shared code touches this.

/** One form field inside a ui.prompt (or auth.request `fields`). `kind:"audio"`
 * is the composer mic-capture slot (reuses the existing dictation upload path;
 * `value` on reply is the resulting clip's transcript/id, never raw audio). */
export interface UiPromptField {
  name: string;
  kind: "text" | "select" | "confirm" | "audio";
  label?: string;
  placeholder?: string;
  options?: string[];
  defaultValue?: string;
  secret?: boolean;
}

/** What a client's `ui.reply` carries back for a given prompt/auth id: a
 * single field's answer (input/select/confirm) or a multi-field form. */
export type UiPromptReplyValue = string | boolean | Record<string, string>;

/** OAuth device-code leg (pi's OAuthLoginCallbacks.onDeviceCode mirror). */
export interface UiDeviceCodeInfo {
  userCode: string;
  verificationUri: string;
  intervalSeconds?: number;
  expiresInSeconds?: number;
}

export type AgentEvent =
  | { type: "model-info"; provider: string; modelId: string; subscription: boolean }
  | { type: "model-fallback"; fromModel: string; toModel: string; reason: string }
  | { type: "context-usage"; usedTokens: number; maxTokens?: number }
  | { type: "text-delta"; delta: string }
  | { type: "thinking-start" }
  | { type: "thinking-delta"; delta: string }
  | { type: "thinking-end"; content?: string }
  /** Pi emitted an expanded `/skill:name` user message for this turn. */
  | { type: "skill-invocation"; skill: SkillInvocation }
  | { type: "tool-start"; toolName: string; toolCallId?: string; args?: unknown }
  | { type: "tool-update"; toolName: string; toolCallId?: string; partialResult?: unknown }
  | { type: "tool-end"; toolName: string; toolCallId?: string; result?: unknown; isError: boolean }
  | { type: "background-task"; taskId: string; toolName: string; command?: string; description?: string; outputPath?: string }
  /** Synthesized DAEMON-side (RunnerHost.injectEvent) the moment a mid-turn
   * steer is accepted, so the marker lands in the stream — and therefore in
   * `details.blocks` — at the exact position the steer took effect. Uniform for
   * every harness by construction; no harness ever emits it. `eventId` is the
   * steer's user RoomEvent. */
  | { type: "steered"; eventId: string }
  /** Structured surfacing of an out-of-band condition worth telling the
   * consumer about without treating it as reply text — e.g. an upstream
   * stall the claude thinking-proxy detected. Never rendered as reply text. */
  | { type: "notice"; kind: "upstream-stall"; text: string }
  /** pi ctx.ui.setWidget mirror: a persistent row above/below the composer.
   * `lines: undefined`-equivalent clear is `lines: []`; a client removes the
   * row when it sees an empty array. */
  | { type: "ui.widget"; id: string; placement: "aboveEditor" | "belowEditor"; lines: string[] }
  /** pi ctx.ui.input/select/confirm mirror: a dialog needing a reply. `kind`
   * is the dialog shape; `fields` carries a multi-field form (e.g. the
   * composer's audio capture slot) when the dialog is more than one answer.
   * Reply travels back as `ui.reply` {id, value} (RunnerCommand, daemon→runner). */
  | { type: "ui.prompt"; id: string; kind: "input" | "select" | "confirm" | "editor"; title: string; message?: string; fields?: UiPromptField[] }
  /** pi ctx.registerShortcut mirror: a hotkey the client should bind: firing
   * it posts `ui.shortcut.fire` {commandId} (RunnerCommand, daemon→runner) —
   * the runner dispatches to the extension's OWN handler, never re-implemented
   * client-side. */
  | { type: "ui.shortcut"; commandId: string; key: string; description?: string }
  /** pi registerProvider's oauth.login(callbacks) mirror — one event per
   * OAuthLoginCallbacks leg (onAuth→url, onDeviceCode→deviceCode,
   * onPrompt/onSelect→fields). Reply travels back as `ui.reply` {id, value},
   * same channel as ui.prompt (uniform: both are "a dialog awaiting one id-keyed
   * answer", never two reply vocabularies). */
  | { type: "auth.request"; id: string; providerId: string; method: "oauth" | "apiKey" | "device"; url?: string; instructions?: string; deviceCode?: UiDeviceCodeInfo; fields?: UiPromptField[] }
  /** pi extension load/failure/dispose mirror — status chips in the transcript. */
  | { type: "ext.lifecycle"; id: string; state: "loaded" | "failed" | "disposed"; reason?: string }
  /** pi registerCommand mirror (Lane E, chat-mto9n58s-bjr1): every command an
   * extension has registered on THIS session, discovered once at first-turn
   * bind (same timing as ext.lifecycle/ui.shortcut — see ui-context.ts's
   * bindPiCommands). Lets a client/other harness introspect what `/word`s a
   * pi session can now dispatch for real (PiRuntime.send's ext-command
   * dispatch — see docs/PLUGIN-ADVERSARY-0905.md §1/§top-fix-4). */
  | { type: "ext.commands"; commands: { name: string; description?: string }[] }
  /** Any pi ExtensionEvent kind with no dedicated AgentEvent mapping above —
   * generic passthrough (Lane E) so nothing a pi extension/lifecycle event
   * emits is silently dropped (see src/harness/pi/events.ts forwardPiEvent's
   * former closed 9-case allowlist, docs/PLUGIN-ADVERSARY-0905.md §top-fix-3).
   * `payload` is depth/size-capped wire-safe JSON, never the raw SDK event
   * object. A client renders unknown kinds as a collapsed debug row. */
  | { type: "harness.event"; kind: string; payload: unknown };

