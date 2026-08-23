// 09-DOG-MODE integration: exercises the REAL RoomService turn pipeline
// (sendMessage → runAgentTurn → commitReply → WAL-committed transcript event)
// with a scripted runtime standing in for the LLM — the same test double
// every other RoomService integration test in this suite uses (see
// scriptedRuntime in room-service.test.ts). Proves render/post-layer
// enforcement lands in the ACTUAL persisted+emitted transcript, not just the
// pure applyDogVerb/renderDogOutput unit level (dog-mode.test.ts).
//
// Message-type turns (@gaia ...) run via RoomService#startTask, which is
// fire-and-forget from sendMessage's point of view (drain() kicks the turn
// off and returns) — so every message-turn assertion below polls for the
// NEW room-event instead of assuming sendMessage's own await covers it.
// Slash-command turns (/dog, /stfu, ...) resolve synchronously inside
// sendMessage while idle, so those need no polling.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomService } from "../src/services/room-service.js";
import { MemoryStore } from "../src/domain/memory.js";
import type { AgentDef, AgentEvent, RoomEvent, UiEvent, Workspace } from "../src/core/types.js";
import type { AgentRuntime } from "../src/harness/spec.js";
import { DOG_PUSH_SOUNDS, DOG_SHOCK_YELPS, DOG_STFU_SOUNDS } from "../src/domain/dog-mode.js";

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

function roomEvents(events: UiEvent[]): RoomEventUi[] {
  return events.filter((event): event is RoomEventUi => event.type === "room-event");
}

/** Command turns (/dog, /stfu, ...) resolve synchronously inside sendMessage
 * while idle — the reply is already the newest room-event the moment
 * sendMessage's await returns. */
function lastEvent(events: UiEvent[]): RoomEvent {
  const list = roomEvents(events);
  const last = list[list.length - 1];
  assert.ok(last, "expected at least one committed room-event");
  return last.event;
}

/** Message turns (@gaia ...) run via RoomService#startTask — fire-and-forget
 * from sendMessage's perspective (drain() kicks the turn off and returns
 * immediately, and the FIRST new room-event past `baseline` is usually the
 * user message itself being committed, not the reply). Poll past `baseline`
 * for the agent's OWN reply event (author === agentId). */
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
    runtimeFactory: (a) => scriptedRuntime(a, script),
  });
  const events: UiEvent[] = [];
  service.subscribe((event) => events.push(event));
  return { service, events };
}

test("DogMode live: /dog on always works with ZERO config present — no gate anywhere", async () => {
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
    runtimeFactory: (a) => scriptedRuntime(a, () => [{ type: "text-delta", delta: "hi" } as AgentEvent]),
  });
  const events: UiEvent[] = [];
  service.subscribe((event) => events.push(event));

  await service.sendMessage("/dog on");
  assert.match(lastEvent(events).text, /collar/i);
  assert.doesNotMatch(lastEvent(events).text, /disabled/i);
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
    runtimeFactory: (a) => scriptedRuntime(a, () => [{ type: "text-delta", delta: "hi" } as AgentEvent]),
  });
  const events: UiEvent[] = [];
  service.subscribe((event) => events.push(event));

  await service.sendMessage("/dog on");
  assert.match(lastEvent(events).text, /collar/i);
});

test("DogMode live: collared room hard-caps a REAL agent turn's committed transcript event to MaxLines", async () => {
  const { service, events } = await makeArmedService(() => [
    { type: "text-delta", delta: "line1\nline2\nline3\nline4" } as AgentEvent,
  ]);

  await service.sendMessage("/dog on");
  assert.match(lastEvent(events).text, /collar/i);

  const baseline = roomEvents(events).length;
  await service.sendMessage("@gaia give me the whole essay");
  const reply = await waitForAgentReply(events, baseline, "gaia");
  // The REAL persisted+emitted transcript event, hard-capped to MaxLines=2 —
  // never the full 4-line scripted reply, and never fed back into any prompt.
  assert.ok(!reply.text.includes("line3"), `line3 leaked past MaxLines: ${JSON.stringify(reply.text)}`);
  assert.ok(!reply.text.includes("line4"), `line4 leaked past MaxLines: ${JSON.stringify(reply.text)}`);
  assert.ok(reply.text.includes("line1") && reply.text.includes("line2"), `body lines missing: ${JSON.stringify(reply.text)}`);
});

test("DogMode live: /stfu replaces a REAL agent turn's committed transcript event with a random muffled SFX ack only; /release restores normal output", async () => {
  const { service, events } = await makeArmedService(() => [
    { type: "text-delta", delta: "the whole confession, at length, many lines\nsecond line\nthird line" } as AgentEvent,
  ]);

  await service.sendMessage("/dog on");
  await service.sendMessage("/stfu");
  assert.ok((DOG_STFU_SOUNDS as readonly string[]).includes(lastEvent(events).text), `expected a DOG_STFU_SOUNDS variant, got ${JSON.stringify(lastEvent(events).text)}`);

  let baseline = roomEvents(events).length;
  await service.sendMessage("@gaia tell me everything");
  const suppressed = await waitForAgentReply(events, baseline, "gaia");
  // Full suppression: the REAL committed event is EXACTLY one of the muffled
  // SFX pool variants, nothing of the scripted reply leaked through, even
  // though the harness "produced" 3 lines — proof this is render/post-layer
  // enforcement, not the model choosing to comply.
  assert.ok((DOG_STFU_SOUNDS as readonly string[]).includes(suppressed.text), `expected a DOG_STFU_SOUNDS variant, got ${JSON.stringify(suppressed.text)}`);

  await service.sendMessage("/push");
  assert.ok((DOG_PUSH_SOUNDS as readonly string[]).includes(lastEvent(events).text), `expected a DOG_PUSH_SOUNDS variant, got ${JSON.stringify(lastEvent(events).text)}`);

  baseline = roomEvents(events).length;
  await service.sendMessage("@gaia tell me everything");
  const stillSuppressed = await waitForAgentReply(events, baseline, "gaia");
  assert.ok((DOG_PUSH_SOUNDS as readonly string[]).includes(stillSuppressed.text), `expected a DOG_PUSH_SOUNDS variant, got ${JSON.stringify(stillSuppressed.text)}`);

  await service.sendMessage("/release");
  assert.match(lastEvent(events).text, /released/i);

  baseline = roomEvents(events).length;
  await service.sendMessage("@gaia tell me everything");
  const restored = await waitForAgentReply(events, baseline, "gaia");
  // Collar off: the FULL scripted reply lands untouched — enforcement is a
  // property of the room's collar state, not a permanent mutation of output.
  assert.equal(restored.text, "the whole confession, at length, many lines\nsecond line\nthird line");
});

// SPEC CHANGE (Pascal, whip 338, 2026-08-23): /shock's re-delivery/echo of
// the last user order is BANNED (parrot behavior) — yelp SFX + discipline
// counter only. Supersedes the old "corrective repetition" test above it.
test("DogMode live: /shock acks with a yelp SFX + discipline counter and does NOT re-deliver the last user order", async () => {
  let calls = 0;
  const { service, events } = await makeArmedService(() => {
    calls += 1;
    return [{ type: "text-delta", delta: `reply #${calls}` } as AgentEvent];
  });

  await service.sendMessage("/dog on");

  let baseline = roomEvents(events).length;
  await service.sendMessage("@gaia do the thing"); // establishes the "last user order"
  const firstReply = await waitForAgentReply(events, baseline, "gaia");
  assert.match(firstReply.text, /reply #1$/); // MaxLines=2, one line body — untruncated (prefixed by the collar register)

  await service.sendMessage("/shock");
  const shockAck = lastEvent(events).text;
  assert.ok((DOG_SHOCK_YELPS as readonly string[]).includes(shockAck), `expected a DOG_SHOCK_YELPS variant, got ${JSON.stringify(shockAck)}`);

  // No corrective repetition fires: give the fire-and-forget pipeline a beat,
  // then prove the scripted runtime was never invoked a 2nd time by /shock.
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls, 1, "parrot mechanic must be gone — /shock must not re-run the agent");

  await service.sendMessage("/dog status");
  assert.match(lastEvent(events).text, /discipline: 1/); // counter still ticks
});
