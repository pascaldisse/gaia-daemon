// pi ExtensionAPI surface wire (RECON-B, 2026-09-05): round-trip encode/decode
// of the five new AgentEvent kinds (ui.widget/ui.prompt/ui.shortcut/
// auth.request/ext.lifecycle) through the daemon<->runner protocol frames,
// their SSE UiEvent projection (room/ui.ts toUiEvent), and the pi ui-bridge
// adapter's reply routing (prompt/authRequest <-> resolvePrompt,
// registerShortcut <-> fireShortcut). No harness subprocess is spawned here —
// RunnerHost's own "ui-reply"/"ui-shortcut-fire" round trip against a live stub
// runner is covered by the same pattern as test/runner-host.test.ts's /steer
// case; that integration is Lane A's to extend once the pi runtime wires
// createUiBridge (see src/harness/pi/ui-bridge.ts's call-site doc comment).

import test from "node:test";
import assert from "node:assert/strict";
import type { AgentEvent, UiPromptReplyValue } from "../src/core/types.js";
import { encodeFrame, parseRunnerMessage, type RunnerCommand, type RunnerMessage } from "../src/harness/protocol.js";
import { RoomUiMixin } from "../src/services/room/ui.js";
import { createUiBridge } from "../src/harness/pi/ui-bridge.js";

// --- 1. protocol frame round trip (RunnerCommand daemon->runner, RunnerMessage runner->daemon) ---

test("ui-reply / ui-shortcut-fire RunnerCommand frames survive encode + JSON.parse (the runner's own decode path)", () => {
  const replyCmd: RunnerCommand = { type: "ui-reply", roomId: "room-1", id: "uiprompt_1", value: { field: "answer" } };
  const shortcutCmd: RunnerCommand = { type: "ui-shortcut-fire", roomId: "room-1", commandId: "cmd_1" };
  const decodedReply = JSON.parse(encodeFrame(replyCmd)) as RunnerCommand;
  const decodedShortcut = JSON.parse(encodeFrame(shortcutCmd)) as RunnerCommand;
  assert.deepEqual(decodedReply, replyCmd);
  assert.deepEqual(decodedShortcut, shortcutCmd);
});

test("ui-reply-result / ui-shortcut-result RunnerMessage frames round-trip through parseRunnerMessage", () => {
  const replyMsg: RunnerMessage = { type: "ui-reply-result", id: "uiprompt_1", ok: true };
  const shortcutMsg: RunnerMessage = { type: "ui-shortcut-result", commandId: "cmd_1", ok: false };
  assert.deepEqual(parseRunnerMessage(JSON.parse(encodeFrame(replyMsg))), replyMsg);
  assert.deepEqual(parseRunnerMessage(JSON.parse(encodeFrame(shortcutMsg))), shortcutMsg);
});

test("parseRunnerMessage rejects a ui-reply-result frame missing its id (a corrupted wire frame, not a valid protocol message)", () => {
  assert.equal(parseRunnerMessage({ type: "ui-reply-result", ok: true }), undefined);
  assert.equal(parseRunnerMessage({ type: "ui-shortcut-result", ok: true }), undefined);
});

// --- 2. AgentEvent -> SSE UiEvent projection (room/ui.ts toUiEvent) ---

test("toUiEvent projects every new AgentEvent kind into its scoped UiEvent, verbatim payload", () => {
  const mixin = new RoomUiMixin() as unknown as { toUiEvent: RoomUiMixin["toUiEvent"] } & Record<string, unknown>;
  (mixin as Record<string, unknown>).workspaceId = "ws-1";
  (mixin as Record<string, unknown>).roomId = "room-1";
  const scope = { workspaceId: "ws-1", roomId: "room-1", taskId: "task-1", agentId: "agent-1", eventId: "evt-1" };

  const widget: AgentEvent = { type: "ui.widget", id: "w1", placement: "aboveEditor", lines: ["line one"] };
  assert.deepEqual(mixin.toUiEvent("task-1", "agent-1", "evt-1", widget), { ...scope, ...widget });

  const prompt: AgentEvent = { type: "ui.prompt", id: "p1", kind: "select", title: "Pick one", fields: [{ name: "choice", kind: "select", options: ["a", "b"] }] };
  // toUiEvent mirrors every optional field verbatim (the codebase's own
  // convention — see tool-end's toolCallId/result) rather than omitting an
  // absent one, so `message` appears explicit-undefined on the projected side.
  assert.deepEqual(mixin.toUiEvent("task-1", "agent-1", "evt-1", prompt), { ...scope, ...prompt, message: undefined });

  const shortcut: AgentEvent = { type: "ui.shortcut", commandId: "cmd_1", key: "ctrl+k", description: "Do the thing" };
  assert.deepEqual(mixin.toUiEvent("task-1", "agent-1", "evt-1", shortcut), { ...scope, ...shortcut });

  const auth: AgentEvent = { type: "auth.request", id: "a1", providerId: "corp-ai", method: "oauth", url: "https://example.com/auth" };
  assert.deepEqual(mixin.toUiEvent("task-1", "agent-1", "evt-1", auth), { ...scope, ...auth, instructions: undefined, deviceCode: undefined, fields: undefined });

  const lifecycle: AgentEvent = { type: "ext.lifecycle", id: "ext-1", state: "failed", reason: "boom" };
  assert.deepEqual(mixin.toUiEvent("task-1", "agent-1", "evt-1", lifecycle), { ...scope, ...lifecycle });

  // Lane E (chat-mto9n58s-bjr1, docs/PLUGIN-ADVERSARY-0905.md §1/§3): the two
  // reachability-fix event kinds must project the same way, never silently drop.
  const commands: AgentEvent = { type: "ext.commands", commands: [{ name: "fugu-ping", description: "ping" }] };
  assert.deepEqual(mixin.toUiEvent("task-1", "agent-1", "evt-1", commands), { ...scope, ...commands });

  const harnessEvent: AgentEvent = { type: "harness.event", kind: "turn_start", payload: { turnId: "t1" } };
  assert.deepEqual(mixin.toUiEvent("task-1", "agent-1", "evt-1", harnessEvent), { ...scope, ...harnessEvent });
});

// --- 3. pi ui-bridge adapter: emit shape + reply routing (prompt/authRequest <-> resolvePrompt, shortcut fire) ---

test("ui-bridge widget()/lifecycle() emit the exact AgentEvent shape", () => {
  const events: AgentEvent[] = [];
  const bridge = createUiBridge((e) => events.push(e));
  bridge.widget("w1", "belowEditor", ["a", "b"]);
  bridge.lifecycle("ext-1", "loaded");
  bridge.commands([{ name: "fugu-ping", description: "ping" }]);
  assert.deepEqual(events, [
    { type: "ui.widget", id: "w1", placement: "belowEditor", lines: ["a", "b"] },
    { type: "ext.lifecycle", id: "ext-1", state: "loaded" },
    { type: "ext.commands", commands: [{ name: "fugu-ping", description: "ping" }] },
  ]);
});

test("ui-bridge prompt() emits ui.prompt then resolves ONLY on a matching resolvePrompt(id, value)", async () => {
  const events: AgentEvent[] = [];
  const bridge = createUiBridge((e) => events.push(e));
  const pending = bridge.prompt("confirm", "Proceed?");
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "ui.prompt");
  const id = (events[0] as Extract<AgentEvent, { type: "ui.prompt" }>).id;

  // A reply to a DIFFERENT id must not resolve this prompt (and reports unresolved).
  assert.equal(bridge.resolvePrompt("not-the-id", true), false);

  assert.equal(bridge.resolvePrompt(id, true), true);
  const value: UiPromptReplyValue = await pending;
  assert.equal(value, true);

  // Once resolved, the id is consumed — a stale second reply is rejected.
  assert.equal(bridge.resolvePrompt(id, false), false);
});

test("ui-bridge authRequest() shares the SAME resolvePrompt reply channel as prompt()", async () => {
  const events: AgentEvent[] = [];
  const bridge = createUiBridge((e) => events.push(e));
  const pending = bridge.authRequest("corp-ai", "apiKey", { fields: [{ name: "key", kind: "text", secret: true }] });
  const authEvent = events[0] as Extract<AgentEvent, { type: "auth.request" }>;
  assert.equal(authEvent.type, "auth.request");
  assert.equal(authEvent.providerId, "corp-ai");
  assert.equal(bridge.resolvePrompt(authEvent.id, { key: "sk-live-..." }), true);
  assert.deepEqual(await pending, { key: "sk-live-..." });
});

test("ui-bridge registerShortcut() emits ui.shortcut; fireShortcut() dispatches the ORIGINAL handler by commandId", async () => {
  const events: AgentEvent[] = [];
  const bridge = createUiBridge((e) => events.push(e));
  let fired = 0;
  bridge.registerShortcut("cmd_1", "ctrl+k", "Do the thing", () => {
    fired += 1;
  });
  assert.deepEqual(events, [{ type: "ui.shortcut", commandId: "cmd_1", key: "ctrl+k", description: "Do the thing" }]);
  assert.equal(bridge.fireShortcut("cmd_1"), true);
  assert.equal(fired, 1);
  assert.equal(bridge.fireShortcut("unknown-command"), false);
  assert.equal(fired, 1);
});
