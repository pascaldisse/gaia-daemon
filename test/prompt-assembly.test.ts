import test from "node:test";
import assert from "node:assert/strict";
import type { AgentDefinition } from "../src/agents/types.ts";
import { buildSystemPrompt, buildTurnPrompt } from "../src/runtime/prompt-assembly.ts";
import type { ResolvedRole } from "../src/roles/roles.ts";

const agent: AgentDefinition = {
  id: "gaia",
  displayName: "Gaia",
  icon: "☀️",
  runtime: "pi",
  dir: "agents/gaia",
  configPath: "agent.json",
  personaDir: "agents/gaia/persona",
  rolesDir: "agents/gaia/persona/roles",
  soulPath: "SOUL.md",
  memoryPath: "MEMORY.md",
  tools: [],
};

const role: ResolvedRole = {
  name: "brainstorm",
  globalPath: "brainstorm.md",
  projectPath: "project/brainstorm.md",
  globalBody: "Global role",
  projectBody: "Project role overlay",
  prompt: "Global role\n\nProject role overlay",
  skills: ["brainstorm"],
  diagnostics: ["tiny warning"],
};

test("system prompt assembles persona, role, project intent, and context in order", () => {
  const prompt = buildSystemPrompt({
    agent,
    soulText: "Soul text",
    role,
    intentText: "Project intent",
    contextFiles: [{ path: "AGENTS.md", content: "Project context" }],
  });

  assert.match(prompt, /# Agent Soul\n\nSoul text/);
  assert.match(prompt, /# Active Role: brainstorm\n\nGlobal role\n\nProject role overlay/);
  assert.match(prompt, /# Project Agent Intent\n\nProject intent/);
  assert.match(prompt, /# Project Context \(AGENTS\.md\)\n\n## AGENTS\.md\n\nProject context/);
  assert.match(prompt, /# Role Diagnostics\n\n- tiny warning/);
  assert.ok(prompt.indexOf("# Agent Soul") < prompt.indexOf("# Active Role: brainstorm"));
  assert.ok(prompt.indexOf("# Active Role: brainstorm") < prompt.indexOf("# Project Agent Intent"));
  assert.ok(prompt.indexOf("# Project Agent Intent") < prompt.indexOf("# Project Context"));
});

test("system prompt does not embed memory content", () => {
  const prompt = buildSystemPrompt({
    agent,
    soulText: "Soul text",
    contextFiles: [],
  });

  assert.doesNotMatch(prompt, /# Agent Memory/);
});

test("turn prompt uses new room events instead of whole transcript wording", () => {
  const prompt = buildTurnPrompt({
    roomId: "default",
    agentId: "gaia",
    message: "Newest question",
    events: [
      { id: "evt_1", timestamp: "2026-05-02T00:00:00.000Z", author: "user", targets: ["gaia"], text: "Newest question" },
    ],
  });

  assert.match(prompt, /New room events since your last turn:/);
  assert.doesNotMatch(prompt, /Recent room transcript/);
  assert.match(prompt, /Newest user message:\n\nNewest question/);
});

test("turn prompt includes memory only when provided", () => {
  const withMemory = buildTurnPrompt({
    roomId: "default",
    agentId: "gaia",
    message: "Hi",
    events: [],
    memory: "# Memory\n\nRemember stars.",
  });
  const withoutMemory = buildTurnPrompt({
    roomId: "default",
    agentId: "gaia",
    message: "Hi",
    events: [],
  });

  assert.match(withMemory, /Your persistent memory \(MEMORY\.md\):\n\n# Memory\n\nRemember stars\./);
  assert.doesNotMatch(withoutMemory, /persistent memory/);
});
