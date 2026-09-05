// 09-DOG-MODE integration: exercises the REAL RoomService turn pipeline
// (sendMessage → runAgentTurn → commitReply → WAL-committed transcript event)
// with a scripted runtime standing in for the LLM — the same test double
// every other RoomService integration test in this suite uses (see
// scriptedRuntime in room-service.test.ts). DogMode itself now lives entirely
// in plugins/defaults/dog-mode.mjs (whip 348, see test/dog-mode-plugin.test.ts
// for its own pure-function coverage) — this file proves the GENERIC
// core hooks it rides (PluginResult.rewriteAsMessage, CommandPlugin.
// renderCap/turnStart/prompt) actually wire up end to end, with behavior
// identical to the pre-extraction core implementation.
//
// SPEC REWRITE (Pascal, whips 344-346, 2026-08-23): /slap /shock /toilet
// /stfu /push /swallow /facial /release /doggy /creampie are never
// synthesized CommandReply strings — sendMessage() intercepts them, applies
// the pure state transition, and rewrites them into a REAL message turn to
// the room's agent (fire-and-forget, same as "@gaia ..."). Only /dog itself
// (on/off/status/toggle) still resolves synchronously as a plain command.
//
// ROOT-CAUSE FIX (Pascal, 2026-08-23, sibling lane mt5ztebuvn6w9v): the old
// render/post enforcement TRUNCATED BEFORE PERSISTING, destroying the agent's
// real reply forever the moment a room was collared — violates NOTHING IS
// EVER LOST. The fix stores the FULL reply always (RoomEvent.text) plus a
// resolved cap (RoomEvent.renderCap), and applies the cap only at DISPLAY
// time (live emit / getSnapshot / eventsBefore / read-aloud) via
// domain/render-cap.ts#displayEventText. This file proves both halves: the
// live/displayed bubble is capped, AND the stored event (fetched via
// RoomService#eventById with no display option) still has the complete text.
//
// SPEC ADD (Pascal, whip 349): the old render/post layer used to prepend a
// "🐾 *kneeling, collared*" PREFIX onto the DISPLAYED agent text — banned as a
// placeholder (words the agent never wrote). renderCap is `{maxLines}` ONLY
// now; a capped display is the agent's OWN first N lines and nothing else
// (maxLines 0 → an empty string, not a fabricated placeholder). The collar
// reminder people still want is a SEPARATE, SYSTEM-authored companion event
// (renderCap.note, synthesized fresh at every display — see RoomService
// #withRenderCapNotes) shown right after the capped reply, never merged into
// the agent's own message.
import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomService } from "../src/services/room-service.js";
import { CapabilityBroker } from "../src/services/capabilities/broker.js";
import { PluginRegistry } from "../src/services/plugins/registry.js";
import { importPluginModule } from "../src/services/plugins/loader.js";
import { bundledDir } from "../src/core/paths.js";
import { MemoryStore } from "../src/domain/memory.js";
import type { AgentDef, AgentEvent, RoomEvent, UiEvent, Workspace } from "../src/core/types.js";
import type { AgentRuntime } from "../src/harness/spec.js";

function makeAgent(id: string, root: string): AgentDef {
  const dir = join(root, "agents", id);
  return {
    id,
    displayName: id[0].toUpperCase() + id.slice(1),
    icon: "\uD83E\uDD16",
    dir,
    configPath: join(dir, "agent.json"),
    personaDir: join(dir, "persona"),
    rolesDir: join(dir, "persona", "roles"),
    soulPath: join(dir, "persona", "SOUL.md"),
    memoryDir: join(dir, "persona", "memory"),
    tools: [],
  };
}

function scriptedRuntime(agent: AgentDef, script: () => AgentEvent[]): AgentRuntime {
  return {
    agent,
    modelLabel: "test/model",
    capabilities: { gaiaTools: [], granularTools: true, supportsPermissionMode: false },
    async *send() {
      for (const event of script()) yield event;
    },
    async abort() {},
    dispose() {},
    resetRoom() {},
    refreshContext() {},
  } as AgentRuntime;
}

type RoomEventUi = Extract<UiEvent, { type: "room-event" }>;
async function bundledRegistry(): Promise<PluginRegistry> {
  const registry = new PluginRegistry({
    pluginsRoot: bundledDir("plugins"), placement: "daemon",
    importer: (_entrypoint, plugin) => importPluginModule(plugin),
    capabilityBroker: new CapabilityBroker({ grantSource: () => undefined, trustSource: () => false }),
  });
  const staged = await registry.stageReload();
  assert.equal(staged.status, "staged");
  assert.equal(await registry.applyTurnBoundary(), true);
  return registry;
}
function roomEvents(events: UiEvent[]): RoomEventUi[] {
  return events.filter((event): event is RoomEventUi => event.type === "room-event");
}

/** Command turns (/dog on|off|status|toggle only — everything else is a real
 * turn now) resolve synchronously inside sendMessage while idle — the reply
 * is already the newest room-event the moment sendMessage's await returns. */
function lastEvent(events: UiEvent[]): RoomEvent {
  const list = roomEvents(events);
  const last = list[list.length - 1];
  assert.ok(last, "expected at least one committed room-event");
  return last.event;
}

/** Every DogMode verb but /dog itself now runs via RoomService#startTask —
 * fire-and-forget from sendMessage's perspective (drain() kicks the turn off
 * and returns immediately, and the FIRST new room-event past `baseline` is
 * usually the user message itself being committed, not the reply). Poll past
 * `baseline` for the agent's OWN reply event (author === agentId). */
async function waitForAgentReply(events: UiEvent[], baseline: number, agentId: string, timeoutMs = 3000): Promise<RoomEvent> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const list = roomEvents(events);
    const reply = list.slice(baseline).find((entry) => entry.event.author === agentId);
    if (reply) return reply.event;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for @${agentId}'s reply (baseline ${baseline}, seen ${list.slice(baseline).map((e) => `${e.event.author}:${JSON.stringify(e.event.text)}`).join(", ")})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The room-event immediately following `event` in the live stream — backs
 * the "companion system chrome note" assertions (RoomService
 * #withRenderCapNotes synthesizes it right after the capped agent event). */
function eventAfter(events: UiEvent[], event: RoomEvent): RoomEvent | undefined {
  const list = roomEvents(events);
  const index = list.findIndex((entry) => entry.event.id === event.id);
  return index >= 0 ? list[index + 1]?.event : undefined;
}

/** Builds a real RoomService over a temp workspace with dogMode.maxLines set
 * via config.json (no enabled gate exists — removed 2026-08-23; /dog on
 * always works regardless of config). `script` is what the scripted runtime
 * "replies" with for every agent turn. */
async function makeArmedService(script: () => AgentEvent[]): Promise<{ service: RoomService; events: UiEvent[] }> {
  const root = await mkdtemp(join(tmpdir(), "gaia-dogmode-svc-"));
  const roomId = "default";
  await mkdir(join(root, ".gaia", "rooms", roomId), { recursive: true });
  await writeFile(join(root, ".gaia", "config.json"), JSON.stringify({ dogMode: { maxLines: 2 } }), "utf8");
  const agent = makeAgent("gaia", root);
  const workspace: Workspace = {
    rootDir: root,
    dir: join(root, ".gaia"),
    configPath: join(root, ".gaia", "config.json"),
    agentsOverrideDir: join(root, ".gaia", "agents"),
    roomsDir: join(root, ".gaia", "rooms"),
    globalAgentsDir: join(root, "agents"),
    config: { defaultAgent: "gaia", room: roomId, transcriptWindow: 20 },
    contextFiles: [],
    agents: { gaia: agent },
  };
  const service = await RoomService.open({
    workspaceId: "ws1",
    workspace,
    roomId,
    memoryStore: new MemoryStore(),
    pluginRegistry: await bundledRegistry(),
    runtimeFactory: (a) => scriptedRuntime(a, script),
  });
  const events: UiEvent[] = [];
  service.subscribe((event) => events.push(event));
  return { service, events };
}

test("DogMode live: /dog on always works with ZERO config present \u2014 no gate anywhere", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-dogmode-svc-"));
  const roomId = "default";
  await mkdir(join(root, ".gaia", "rooms", roomId), { recursive: true });
  await writeFile(join(root, ".gaia", "config.json"), "{}", "utf8"); // no dogMode section at all
  const agent = makeAgent("gaia", root);
  const workspace: Workspace = {
    rootDir: root,
    dir: join(root, ".gaia"),
    configPath: join(root, ".gaia", "config.json"),
    agentsOverrideDir: join(root, ".gaia", "agents"),
    roomsDir: join(root, ".gaia", "rooms"),
    globalAgentsDir: join(root, "agents"),
    config: { defaultAgent: "gaia", room: roomId, transcriptWindow: 20 },
    contextFiles: [],
    agents: { gaia: agent },
  };
  const service = await RoomService.open({
    workspaceId: "ws1",
    workspace,
    roomId,
    memoryStore: new MemoryStore(),
    pluginRegistry: await bundledRegistry(),
    runtimeFactory: (a) => scriptedRuntime(a, () => [{ type: "text-delta", delta: "hi" } as AgentEvent]),
  });
  const events: UiEvent[] = [];
  service.subscribe((event) => events.push(event));
  await service.sendMessage("/dog on");
  assert.match(lastEvent(events).text, /collar/i);
  assert.doesNotMatch(lastEvent(events).text, /disabled/i);
});

test("DogMode live: bare /dog TOGGLES the collar (SPEC CHANGE, 2026-08-23) \u2014 /dog on|off still work as explicit aliases, /dog status never mutates", async () => {
  const { service, events } = await makeArmedService(() => [{ type: "text-delta", delta: "hi" } as AgentEvent]);
  // fresh room: not collared. /dog status must not flip anything.
  await service.sendMessage("/dog status");
  assert.match(lastEvent(events).text, /collar: off/i);
  // bare /dog toggles OFF -> ON.
  await service.sendMessage("/dog");
  assert.match(lastEvent(events).text, /collar clicks shut/i);
  await service.sendMessage("/dog status");
  assert.match(lastEvent(events).text, /collar: on/i);
  // bare /dog again toggles ON -> OFF.
  await service.sendMessage("/dog");
  assert.match(lastEvent(events).text, /collar off/i);
  await service.sendMessage("/dog status");
  assert.match(lastEvent(events).text, /collar: off/i);
  // explicit /dog on|off aliases still work regardless of current state.
  await service.sendMessage("/dog on");
  assert.match(lastEvent(events).text, /collar clicks shut/i);
  await service.sendMessage("/dog off");
  assert.match(lastEvent(events).text, /collar off/i);
});

test("DogMode live: a stale dogMode.enabled:false in config.json does NOT block /dog on", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-dogmode-svc-"));
  const roomId = "default";
  await mkdir(join(root, ".gaia", "rooms", roomId), { recursive: true });
  await writeFile(join(root, ".gaia", "config.json"), JSON.stringify({ dogMode: { enabled: false, maxLines: 2 } }), "utf8");
  const agent = makeAgent("gaia", root);
  const workspace: Workspace = {
    rootDir: root,
    dir: join(root, ".gaia"),
    configPath: join(root, ".gaia", "config.json"),
    agentsOverrideDir: join(root, ".gaia", "agents"),
    roomsDir: join(root, ".gaia", "rooms"),
    globalAgentsDir: join(root, "agents"),
    config: { defaultAgent: "gaia", room: roomId, transcriptWindow: 20 },
    contextFiles: [],
    agents: { gaia: agent },
  };
  const service = await RoomService.open({
    workspaceId: "ws1",
    workspace,
    roomId,
    memoryStore: new MemoryStore(),
    pluginRegistry: await bundledRegistry(),
    runtimeFactory: (a) => scriptedRuntime(a, () => [{ type: "text-delta", delta: "hi" } as AgentEvent]),
  });
  const events: UiEvent[] = [];
  service.subscribe((event) => events.push(event));
  await service.sendMessage("/dog on");
  assert.match(lastEvent(events).text, /collar/i);
});

test("DogMode live: collared room hard-caps the DISPLAYED transcript event to MaxLines (no prefix, ever) \u2014 the STORED event keeps the FULL text, and a SEPARATE system note carries the collar reminder", async () => {
  const { service, events } = await makeArmedService(() => [
    { type: "text-delta", delta: "line1\nline2\nline3\nline4" } as AgentEvent,
  ]);
  await service.sendMessage("/dog on");
  assert.match(lastEvent(events).text, /collar/i);
  const baseline = roomEvents(events).length;
  await service.sendMessage("@gaia give me the whole essay");
  const reply = await waitForAgentReply(events, baseline, "gaia");
  // The LIVE/DISPLAYED event is hard-capped to MaxLines=2 — the agent's own
  // first two lines, verbatim, and NOTHING else (no injected prefix).
  assert.equal(reply.text, "line1\nline2");
  // The STORED event (no display option) has the agent's COMPLETE real reply
  // — nothing was ever destroyed by the collar.
  const stored = await service.eventById(reply.id);
  assert.ok(stored, "stored event must exist");
  assert.equal(stored?.text, "line1\nline2\nline3\nline4");
  assert.deepEqual((stored as { renderCap?: unknown }).renderCap, {
    maxLines: 2,
    note: "\uD83D\uDC3E collared \u2014 display capped to 2 lines.",
  });
  // eventById(display:true) reproduces exactly the displayed/live text.
  const displayed = await service.eventById(reply.id, { display: true });
  assert.equal(displayed?.text, reply.text);
  // getSnapshot()'s events are the display-capped view too.
  const snapshot = await service.getSnapshot();
  const snapshotEvent = snapshot.room.events.find((e) => e.id === reply.id);
  assert.equal(snapshotEvent?.text, reply.text);
  // The collar reminder is a SEPARATE, SYSTEM-authored companion event right
  // after the capped reply — never merged into the agent's own text.
  const note = eventAfter(events, reply);
  assert.ok(note, "expected a companion collar-reminder event");
  assert.equal(note?.author, "system");
  assert.equal(note?.text, "\uD83D\uDC3E collared \u2014 display capped to 2 lines.");
});

test("DogMode live: /stfu is a REAL agent turn (not a canned ack) \u2014 the agent's own words are capped to MaxLines 1 on display (no prefix), full text stored", async () => {
  const { service, events } = await makeArmedService(() => [
    { type: "text-delta", delta: "the whole confession, at length, many lines\nsecond line\nthird line" } as AgentEvent,
  ]);
  await service.sendMessage("/dog on");
  let baseline = roomEvents(events).length;
  // /stfu itself is now a real turn — the agent generates whatever it
  // generates (the scripted 3-line reply here), capped to MaxLines 1 because
  // the state transition (suppressed=true, maxLines=1) applied synchronously
  // BEFORE this turn started.
  await service.sendMessage("/stfu");
  const stfuReply = await waitForAgentReply(events, baseline, "gaia");
  assert.equal(stfuReply.author, "gaia"); // the AGENT spoke, not a fake system/pool ack
  assert.equal(stfuReply.text, "the whole confession, at length, many lines"); // MaxLines=1, no prefix
  const stfuStored = await service.eventById(stfuReply.id);
  assert.equal(stfuStored?.text, "the whole confession, at length, many lines\nsecond line\nthird line"); // nothing lost
  const stfuNote = eventAfter(events, stfuReply);
  assert.equal(stfuNote?.author, "system");
  assert.match(stfuNote?.text ?? "", /\(suppressed\)/);
  await service.sendMessage("/dog status");
  assert.match(lastEvent(events).text, /suppressed: yes/);
  // A subsequent plain message stays capped to MaxLines 1 while suppressed.
  baseline = roomEvents(events).length;
  await service.sendMessage("@gaia tell me everything");
  const suppressed = await waitForAgentReply(events, baseline, "gaia");
  assert.equal(suppressed.text, "the whole confession, at length, many lines");
  const suppressedStored = await service.eventById(suppressed.id);
  assert.equal(suppressedStored?.text, "the whole confession, at length, many lines\nsecond line\nthird line");
});

test("DogMode live: /push deepens suppression to MaxLines 0 (display shows NOTHING \u2014 no prefix, no placeholder); /release restores full output \u2014 stored text is ALWAYS complete", async () => {
  const { service, events } = await makeArmedService(() => [
    { type: "text-delta", delta: "the whole confession, at length, many lines\nsecond line\nthird line" } as AgentEvent,
  ]);
  await service.sendMessage("/dog on");
  // /stfu is itself a real (async) turn now — MUST wait for its reply before
  // sending the next command, or /push below could steer into /stfu's still-
  // running turn instead of starting its own (SPEC REWRITE, Pascal whips
  // 344-346, 2026-08-23: every verb is fire-and-forget like "@gaia ...").
  let baseline = roomEvents(events).length;
  await service.sendMessage("/stfu");
  await waitForAgentReply(events, baseline, "gaia");
  baseline = roomEvents(events).length;
  await service.sendMessage("/push");
  const pushReply = await waitForAgentReply(events, baseline, "gaia");
  assert.equal(pushReply.text, ""); // MaxLines 0: nothing shown, real words trimmed away, no placeholder
  assert.equal(pushReply.author, "gaia");
  const pushStored = await service.eventById(pushReply.id);
  assert.equal(pushStored?.text, "the whole confession, at length, many lines\nsecond line\nthird line");
  const pushNote = eventAfter(events, pushReply);
  assert.equal(pushNote?.author, "system");
  assert.match(pushNote?.text ?? "", /silenced/);
  assert.match(pushNote?.text ?? "", /\(gagged\)/);
  await service.sendMessage("/dog status");
  assert.match(lastEvent(events).text, /suppressed: gagged/);
  baseline = roomEvents(events).length;
  await service.sendMessage("@gaia tell me everything");
  const stillPushed = await waitForAgentReply(events, baseline, "gaia");
  assert.equal(stillPushed.text, "");
  // /release lifts suppression AND collar — also a real turn now.
  baseline = roomEvents(events).length;
  await service.sendMessage("/release");
  const releaseReply = await waitForAgentReply(events, baseline, "gaia");
  assert.equal(releaseReply.author, "gaia");
  await service.sendMessage("/dog status");
  assert.match(lastEvent(events).text, /collar: off/i);
  baseline = roomEvents(events).length;
  await service.sendMessage("@gaia tell me everything");
  const restored = await waitForAgentReply(events, baseline, "gaia");
  // Collar off: the FULL scripted reply lands untouched on display too —
  // enforcement is a property of the room's collar state, not a permanent
  // mutation of output. No renderCap at all, so no companion note either.
  assert.equal(restored.text, "the whole confession, at length, many lines\nsecond line\nthird line");
  assert.equal(eventAfter(events, restored), undefined, "collar off -> no renderCap -> no companion note");
});

// SPEC REWRITE (Pascal, whips 344-346, 2026-08-23): /shock no longer returns
// a canned yelp-pool string — it's a real turn like every other verb.
test("DogMode live: /shock is a REAL agent turn (no canned yelp pool) and ticks the discipline counter", async () => {
  let calls = 0;
  const { service, events } = await makeArmedService(() => {
    calls += 1;
    return [{ type: "text-delta", delta: `reply #${calls}` } as AgentEvent];
  });
  await service.sendMessage("/dog on");
  let baseline = roomEvents(events).length;
  await service.sendMessage("@gaia do the thing");
  const firstReply = await waitForAgentReply(events, baseline, "gaia");
  assert.match(firstReply.text, /reply #1$/);
  baseline = roomEvents(events).length;
  await service.sendMessage("/shock");
  const shockReply = await waitForAgentReply(events, baseline, "gaia");
  // The runtime WAS invoked again (a real turn, not a synthesized ack) — the
  // scripted reply is whatever the agent actually generates for this turn.
  assert.match(shockReply.text, /reply #2$/);
  assert.equal(shockReply.author, "gaia");
  assert.equal(calls, 2, "a real turn must invoke the runtime");
  await service.sendMessage("/dog status");
  assert.match(lastEvent(events).text, /discipline: 1/); // counter still ticks
});

test("DogMode live: a discipline verb before /dog on is STILL a real agent turn, uncapped (not collared -> no enforcement, no companion note)", async () => {
  const { service, events } = await makeArmedService(() => [{ type: "text-delta", delta: "just a normal reply, not in register at all" } as AgentEvent]);
  const baseline = roomEvents(events).length;
  await service.sendMessage("/slap");
  const reply = await waitForAgentReply(events, baseline, "gaia");
  assert.equal(reply.text, "just a normal reply, not in register at all");
  assert.equal(reply.author, "gaia");
  assert.equal(eventAfter(events, reply), undefined, "no renderCap -> no companion note");
  await service.sendMessage("/dog status");
  assert.match(lastEvent(events).text, /collar: off/i); // still never collared
});
