import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildProtocolsSection,
  buildSystemPrompt,
  buildTurnPrompt,
  promptCacheKey,
  readProtocolsText,
  renderRoomTranscript,
  type SystemPromptInput,
} from "../src/harness/prompt.js";
import type { AgentDef, AgentRoomEvent, ToolDetail } from "../src/core/types.js";
import { toolSummaryText } from "../web/shared/tool-summary.js";
import { splitLeadingGaiaThink } from "../web/shared/gaia-think.js";
import { DEFAULT_CONTEXT_DIET_POLICY, type ContextDietPolicy } from "../src/domain/context-diet.js";

const AGENT = { id: "tester" } as unknown as AgentDef;

function baseInput(overrides: Partial<SystemPromptInput> = {}): SystemPromptInput {
  return {
    agent: AGENT,
    soulText: "I am a soul.",
    contextFiles: [],
    ...overrides,
  };
}

test("buildProtocolsSection: no text = empty section (zero change)", () => {
  assert.equal(buildProtocolsSection(undefined, 5), "");
  assert.equal(buildProtocolsSection("", 5), "");
  assert.equal(buildProtocolsSection("   ", 5), "");
});

test("buildProtocolsSection: level 0 (and unset) disables thought blocks", () => {
  const zero = buildProtocolsSection("PROTOCOL BODY", 0);
  assert.match(zero, /^# Protocols\n\nPROTOCOL BODY\n\n/);
  assert.match(zero, /Thinking disabled — do not emit <gaia:think> blocks\.$/);
  // unset level behaves as 0
  assert.equal(buildProtocolsSection("PROTOCOL BODY"), zero);
});

test("buildProtocolsSection: level N announces N/10", () => {
  const seven = buildProtocolsSection("PROTOCOL BODY", 7);
  assert.match(seven, /^# Protocols\n\nPROTOCOL BODY\n\n/);
  assert.match(seven, /Current thinking level: 7\/10$/);
  assert.doesNotMatch(seven, /Thinking disabled/);
});

test("buildSystemPrompt: without protocolsText there is NO # Protocols section", () => {
  const prompt = buildSystemPrompt(baseInput());
  assert.doesNotMatch(prompt, /# Protocols/);
  assert.match(prompt, /# Agent Soul/);
});

test("buildSystemPrompt: protocols section sits right after Agent Soul", () => {
  const prompt = buildSystemPrompt(baseInput({ protocolsText: "GAIA-THINK BODY", thinkingLevel: 3 }));
  const soulIdx = prompt.indexOf("# Agent Soul");
  const protoIdx = prompt.indexOf("# Protocols");
  const ctxIdx = prompt.indexOf("# Project Context");
  assert.ok(soulIdx >= 0 && protoIdx > soulIdx && ctxIdx > protoIdx, "order: soul < protocols < context");
  assert.match(prompt, /Current thinking level: 3\/10/);
});

test("promptCacheKey: level is part of the cache key so a change invalidates it", () => {
  assert.equal(promptCacheKey(undefined, 0), "#t0");
  assert.equal(promptCacheKey("matriarch", 5), "matriarch#t5");
  assert.notEqual(promptCacheKey("matriarch", 5), promptCacheKey("matriarch", 6));
});

test("readProtocolsText: missing dir = empty; *.md sorted + concatenated verbatim", async () => {
  const missing = await readProtocolsText(join(tmpdir(), "gaia-no-such-protocols-dir-xyz"));
  assert.equal(missing, "");

  const dir = await mkdtemp(join(tmpdir(), "gaia-protocols-"));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "b-second.md"), "SECOND");
  await writeFile(join(dir, "a-first.md"), "FIRST");
  await writeFile(join(dir, "ignore.txt"), "NOPE");
  const text = await readProtocolsText(dir);
  assert.equal(text, "FIRST\n\nSECOND"); // filename sort, .txt ignored
});

test("buildSystemPrompt: promptLaw is the very first tokens; absent when unset", () => {
  const withLaw = buildSystemPrompt(baseInput({ agent: { id: "tester", promptLaw: "TOP LAW" } as unknown as AgentDef }));
  assert.equal(withLaw.indexOf("TOP LAW"), 0);
  assert.match(withLaw, /^TOP LAW\n\n---\n\n# Agent Soul/);
  const without = buildSystemPrompt(baseInput());
  assert.equal(without.includes("TOP LAW"), false);
  assert.match(without, /^# Agent Soul/);
});

test("buildTurnPrompt: turnLaw lands as the very last tokens", () => {
  const prompt = buildTurnPrompt({
    roomId: "room-1",
    agentId: "tester",
    message: "hello",
    events: [],
    turnLaw: "LAW LINE",
  });
  assert.ok(prompt.endsWith("\n\nLAW LINE"), `prompt must end with law, got: ...${prompt.slice(-40)}`);
  // without turnLaw nothing is appended
  const bare = buildTurnPrompt({ roomId: "room-1", agentId: "tester", message: "hello", events: [] });
  assert.doesNotMatch(bare, /LAW LINE/);
});

// --- context-diet render-time decay (09-MEMORY-CONTEXT, ported from v2) -----

const LONG_PREVIEW = ["line one", "line two", "line three", "line four", "line five (newest)"].join("\n");

function toolResult(text: string): unknown {
  return { content: [{ type: "text", text }] };
}

function toolCall(id: string, text = LONG_PREVIEW): ToolDetail {
  return { id, toolName: "bash", status: "complete", args: { command: "x" }, result: toolResult(text) };
}

function agentEvent(id: string, author: string, timestamp: string, tools: ToolDetail[]): AgentRoomEvent {
  return { id, timestamp, author, text: `${author}'s turn`, details: { tools } };
}

const DIET_POLICY: ContextDietPolicy = { preset: true, keepAllToolCalls: false, fullTurnWindow: 1, toolTailLines: 2 };

test("renderRoomTranscript: diet absent/off renders IDENTICALLY to no [gaia.activity] block (default OFF, IRON)", () => {
  const events = [agentEvent("e1", "gaia", "2026-07-20T00:00:00.000Z", [toolCall("tool_1")])];
  const withoutDiet = renderRoomTranscript(events, undefined);
  const withOffPolicy = renderRoomTranscript(events, undefined, { policy: { ...DEFAULT_CONTEXT_DIET_POLICY, preset: false }, currentAgentId: "gaia" });
  assert.doesNotMatch(withoutDiet, /gaia\.activity/);
  assert.equal(withOffPolicy, withoutDiet);
});

test("renderRoomTranscript diet projection: own tool calls stay full within fullTurnWindow, collapse when older; another agent's activity is always a bounded tail", () => {
  const ownOld = agentEvent("e_own_old", "gaia", "2026-07-20T00:00:00.000Z", [toolCall("tool_own_old")]);
  const otherRecent = agentEvent("e_other", "scribe", "2026-07-20T00:01:00.000Z", [toolCall("tool_other")]);
  const ownRecent = agentEvent("e_own_recent", "gaia", "2026-07-20T00:02:00.000Z", [toolCall("tool_own_recent")]);
  const rendered = renderRoomTranscript([ownOld, otherRecent, ownRecent], undefined, { policy: DIET_POLICY, currentAgentId: "gaia" });
  // Each event's rendering starts with its own "[<timestamp>]" header — split there for a clean per-event block, in event order (ownOld, otherRecent, ownRecent).
  const [oldBlock, otherBlock, ownRecentBlock] = rendered.split(/(?=\[2026)/);

  // own + recent (last event, within fullTurnWindow=1): full preview, every line present verbatim.
  assert.match(ownRecentBlock, /owner=self/);
  assert.ok(ownRecentBlock.includes(LONG_PREVIEW), "full longPreview must appear verbatim for the recent own turn");

  // Another agent is always seat-projected, independently of the diet tail policy.
  assert.match(otherBlock, /bash · x · ✓/);
  assert.doesNotMatch(otherBlock, /line one|line four|line five/);

  // own + older than the window: collapsed to a one-line stub carrying (eventId, toolId) for tool_result_fetch — never silently deleted.
  assert.match(oldBlock, /collapsed — page the original with tool_result_fetch\(sessionId="e_own_old", entryId="tool_own_old"\)/);
  assert.doesNotMatch(oldBlock, /line two/);
  assert.ok(!oldBlock.includes(LONG_PREVIEW));
});

test("renderRoomTranscript diet: keepAllToolCalls keeps own activity full regardless of recency", () => {
  const ownOld = agentEvent("e_own_old", "gaia", "2026-07-20T00:00:00.000Z", [toolCall("tool_own_old")]);
  const rendered = renderRoomTranscript([ownOld], undefined, { policy: { ...DIET_POLICY, fullTurnWindow: 0, keepAllToolCalls: true }, currentAgentId: "gaia" });
  assert.doesNotMatch(rendered, /collapsed — page the original/);
  assert.ok(rendered.includes(LONG_PREVIEW));
});
test("buildTurnPrompt: another agent's thought and payload never enter the recipient context", () => {
  const event = agentEvent("e-seat", "author", "2026-07-20T00:00:00.000Z", [{
    id: "tool-seat", toolName: "bash", status: "complete", args: { command: "secret-command" }, result: toolResult("SECRET RESULT PAYLOAD"),
  }]);
  event.text = "before <gaia:think>SECRET THOUGHT</gaia:think> after";
  const prompt = buildTurnPrompt({ roomId: "room", agentId: "recipient", message: "go", events: [event] });
  assert.match(prompt, /before\s+after/);
  assert.match(prompt, /bash · secret-command · ✓/);
  assert.doesNotMatch(prompt, /SECRET THOUGHT|SECRET RESULT PAYLOAD/);
});
test("buildTurnPrompt: an unclosed thought hides its entire unfinished tail", () => {
  const event = agentEvent("e-seat", "author", "2026-07-20T00:00:00.000Z", []);
  event.text = "visible <gaia:think>unfinished secret";
  const prompt = buildTurnPrompt({ roomId: "room", agentId: "recipient", message: "go", events: [event] });
  assert.match(prompt, /visible/);
  assert.doesNotMatch(prompt, /unfinished secret/);
});
test("buildTurnPrompt: a recipient retains its own complete tool payload", () => {
  const event = agentEvent("e-own", "recipient", "2026-07-20T00:00:00.000Z", [toolCall("tool-own", "OWN PAYLOAD")]);
  const prompt = buildTurnPrompt({ roomId: "room", agentId: "recipient", message: "go", events: [event], dietPolicy: { ...DIET_POLICY, keepAllToolCalls: true } });
  assert.match(prompt, /OWN PAYLOAD/);
});

test("buildTurnPrompt: other-agent tool summaries never derive from result payloads", () => {
  const event = agentEvent("e-result", "author", "2026-07-20T00:00:00.000Z", [{ id: "tool-result", toolName: "read_secret", status: "complete", args: {}, result: toolResult("RAW_RESULT_PAYLOAD_MARKER") }]);
  const prompt = buildTurnPrompt({ roomId: "room", agentId: "recipient", message: "go", events: [event] });
  assert.match(prompt, /read_secret · ✓/);
  assert.doesNotMatch(prompt, /RAW_RESULT_PAYLOAD_MARKER/);
});

test("seat projection is a subset of the same UI renderer fixture", () => {
  const tool = { id: "tool-seat", toolName: "read_secret", status: "complete", args: { path: "/safe/target" }, result: toolResult("RAW_RESULT_PAYLOAD_MARKER") };
  const event = agentEvent("event-seat", "author", "2026-08-22T00:00:00.000Z", [tool]);
  event.text = "<gaia:think>SECRET_THOUGHT_MARKER</gaia:think>answer";
  const context = buildTurnPrompt({ roomId: "room", agentId: "recipient", message: "go", events: [event] });
  // These are precisely the shared functions used by web/src/transcript.js.
  expect(splitLeadingGaiaThink(event.text)?.thought).toBe("SECRET_THOUGHT_MARKER");
  expect(toolSummaryText(tool)).toBe("/safe/target");
  assert.match(context, /read_secret · \/safe\/target · ✓/);
  assert.doesNotMatch(context, /SECRET_THOUGHT_MARKER|RAW_RESULT_PAYLOAD_MARKER/);
});
