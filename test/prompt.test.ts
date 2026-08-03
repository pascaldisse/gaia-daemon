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
  type SystemPromptInput,
} from "../src/harness/prompt.js";
import type { AgentDef } from "../src/core/types.js";

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
