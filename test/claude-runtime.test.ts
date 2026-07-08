// v2 port of test/claude-runtime.test.ts — every v1 scenario, driven through
// the injectable process factory (scriptable NDJSON message sequences).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentEvent } from "../src/core/types.js";
import { MemoryStore } from "../src/domain/memory.js";
import { findHarness } from "../src/harness/spec.js";
import {
  buildClaudeToolGrant,
  claudeModelArg,
  ClaudeRuntime,
  type ClaudeProcessFactory,
  type ClaudeProcessOptions,
} from "../src/harness/claude.js";
import { collect, harnessFixture } from "./helpers/fixture.js";
import { createTempDir } from "./helpers/temp.js";

// ---------------------------------------------------------------------------
// Fake process factory – scriptable NDJSON message sequences (one per turn)
// ---------------------------------------------------------------------------

interface Script {
  messages: unknown[];
  exit?: { code: number | null; signal: string | null };
  spawnError?: Error;
  /** When false, the fake emits messages but does not exit (drive it manually). */
  autoExit?: boolean;
}

class FakeClaude {
  readonly factory: ClaudeProcessFactory;
  readonly calls: ClaudeProcessOptions[] = [];
  killCount = 0;
  endInputCount = 0;
  /** Messages injected via the handle's steer() during a running turn. */
  readonly steers: string[] = [];
  lastOptions: ClaudeProcessOptions | null = null;
  private readonly scripts: Script[] = [];

  constructor() {
    this.factory = (options) => {
      this.calls.push(options);
      this.lastOptions = options;
      const script = this.scripts.shift() ?? { messages: [], exit: { code: 0, signal: null } };
      setTimeout(() => {
        if (script.spawnError) {
          options.onError(script.spawnError);
          return;
        }
        for (const m of script.messages) options.onMessage(m);
        if (script.autoExit !== false) {
          options.onExit({ code: script.exit?.code ?? 0, signal: script.exit?.signal ?? null, stderr: "" });
        }
      }, 0);
      return {
        kill: () => {
          this.killCount++;
        },
        steer: (text: string) => {
          this.steers.push(text);
          return true;
        },
        endInput: () => {
          this.endInputCount++;
        },
      };
    };
  }

  script(messages: unknown[], exit?: { code: number | null; signal: string | null }): void {
    this.scripts.push({ messages, exit });
  }

  scriptOpen(messages: unknown[]): void {
    this.scripts.push({ messages, autoExit: false });
  }

  scriptSpawnError(error: Error): void {
    this.scripts.push({ messages: [], spawnError: error });
  }
}

const initMsg = (model = "claude-opus-4-8", apiKeySource = "none") => ({
  type: "system",
  subtype: "init",
  model,
  apiKeySource,
  session_id: "sess-x",
});

const textDelta = (text: string) => ({
  type: "stream_event",
  event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
});

const resultSuccess = (result = "ok") => ({ type: "result", subtype: "success", is_error: false, result });

const fixture = () => harnessFixture({ tools: ["read", "write", "edit", "memory", "recall"], harness: "claude", model: { provider: "anthropic", name: "claude-opus-4-8" } });

// ---------------------------------------------------------------------------
// buildClaudeToolGrant – the config-driven translator
// ---------------------------------------------------------------------------

test("buildClaudeToolGrant: read maps to read-only tools with no allow rules", () => {
  const grant = buildClaudeToolGrant(["read"]);
  assert.deepEqual(grant.tools, ["Read", "Grep", "Glob"]);
  assert.deepEqual(grant.allowedTools, []);
});

test("buildClaudeToolGrant: write/edit expose and auto-approve their tools", () => {
  const grant = buildClaudeToolGrant(["read", "write", "edit"]);
  assert.deepEqual(grant.tools, ["Read", "Grep", "Glob", "Write", "Edit"]);
  assert.deepEqual(grant.allowedTools, ["Write", "Edit"]);
});

test("buildClaudeToolGrant: memory/recall grant the narrow gaia CLI, not a general shell", () => {
  const grant = buildClaudeToolGrant(["read", "write", "edit", "memory", "recall"]);
  // Bash is present (to invoke gaia) but general Bash is NOT auto-approved.
  assert.ok(grant.tools.includes("Bash"));
  assert.ok(!grant.allowedTools.includes("Bash"));
  assert.ok(grant.allowedTools.includes("Bash(gaia mem:*)"));
  assert.ok(grant.allowedTools.includes("Bash(gaia recall:*)"));
});

test("buildClaudeToolGrant: web exposes and auto-approves Claude's native web tools", () => {
  const grant = buildClaudeToolGrant(["read", "web"]);
  assert.ok(grant.tools.includes("WebSearch"));
  assert.ok(grant.tools.includes("WebFetch"));
  // Read-only but allow-listed so non-bypass agents can still call them.
  assert.ok(grant.allowedTools.includes("WebSearch"));
  assert.ok(grant.allowedTools.includes("WebFetch"));
});

test("buildClaudeToolGrant: no web tools without the web tool", () => {
  const grant = buildClaudeToolGrant(["read", "write", "edit"]);
  assert.ok(!grant.tools.includes("WebSearch"));
  assert.ok(!grant.tools.includes("WebFetch"));
});

test("buildClaudeToolGrant: bash grants the general shell", () => {
  const grant = buildClaudeToolGrant(["read", "write", "edit", "bash", "memory", "recall"]);
  assert.ok(grant.tools.includes("Bash"));
  assert.ok(grant.allowedTools.includes("Bash"));
  // memory/recall grants coexist with the general shell.
  assert.ok(grant.allowedTools.includes("Bash(gaia mem:*)"));
});

test("claudeModelArg: forces the 1M window on 1M-capable models, leaves haiku and pinned windows alone", () => {
  // 1M-capable tiers (aliases + full names) get the [1m] suffix — Claude Code
  // otherwise drops to 200k behind our proxy.
  assert.equal(claudeModelArg("opus"), "opus[1m]");
  assert.equal(claudeModelArg("sonnet"), "sonnet[1m]");
  assert.equal(claudeModelArg("fable"), "fable[1m]");
  assert.equal(claudeModelArg("claude-opus-4-8"), "claude-opus-4-8[1m]");
  // haiku has no 1M window ([1m] errors) — left bare.
  assert.equal(claudeModelArg("haiku"), "haiku");
  assert.equal(claudeModelArg("claude-haiku-4-5"), "claude-haiku-4-5");
  // An explicit suffix in config is the opt-out — passed through untouched.
  assert.equal(claudeModelArg("claude-opus-4-8[1m]"), "claude-opus-4-8[1m]");
  assert.equal(claudeModelArg("opus[200k]"), "opus[200k]");
});

test("buildClaudeToolGrant: web maps to Claude's built-in WebSearch/WebFetch (exposed and allowed)", () => {
  const grant = buildClaudeToolGrant(["read", "web"]);
  assert.ok(grant.tools.includes("WebSearch"));
  assert.ok(grant.tools.includes("WebFetch"));
  assert.ok(grant.allowedTools.includes("WebSearch"));
  assert.ok(grant.allowedTools.includes("WebFetch"));
  // No web in tools → no web grant.
  const none = buildClaudeToolGrant(["read"]);
  assert.ok(!none.tools.includes("WebSearch") && !none.tools.includes("WebFetch"));
});

test("buildClaudeToolGrant: an empty tools list yields no tools", () => {
  const grant = buildClaudeToolGrant([]);
  assert.deepEqual(grant.tools, []);
  assert.deepEqual(grant.allowedTools, []);
});

test("buildClaudeToolGrant: summon maps to the narrow gaia summon grant", () => {
  const grant = buildClaudeToolGrant(["read", "summon"]);
  assert.ok(grant.tools.includes("Bash"));
  assert.ok(grant.allowedTools.includes("Bash(gaia summon:*)"));
  assert.ok(!grant.allowedTools.includes("Bash"));
});

// ---------------------------------------------------------------------------
// ClaudeRuntime
// ---------------------------------------------------------------------------

test("ClaudeRuntime yields model-info from init and text-delta from stream_event", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeClaude();
    fake.script([initMsg(), textDelta("Hello"), resultSuccess()]);

    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), processFactory: fake.factory });
    const events = await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    assert.equal(events.length, 2);
    assert.deepEqual(events[0], { type: "model-info", provider: "anthropic", modelId: "claude-opus-4-8", subscription: true });
    assert.deepEqual(events[1], { type: "text-delta", delta: "Hello" });
    assert.equal(runtime.modelLabel, "anthropic/claude-opus-4-8");
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

// A claude agent that granted the web tool, for native-command turns.
const webFixture = () =>
  harnessFixture({ tools: ["read", "web"], harness: "claude", model: { provider: "anthropic", name: "claude-opus-4-8" } });

test("native command: raw stdin + skills-enabled flag profile (no --safe-mode)", async () => {
  const fx = await webFixture();
  try {
    const fake = new FakeClaude();
    fake.script([initMsg(), textDelta("researching"), resultSuccess()]);
    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), processFactory: fake.factory });
    await collect(runtime.send({ roomId: "default", message: "/deep-research when was the transistor invented", transcript: [], nativeCommand: true }));

    const { args, prompt } = fake.lastOptions!;
    // The command is handed to the CLI verbatim — NOT wrapped in the usual
    // "Room:/Newest user message" prompt, or the slash command wouldn't resolve.
    assert.equal(prompt, "/deep-research when was the transistor invented");
    assert.ok(!prompt.includes("Newest user message"));
    // Skills need the surface --safe-mode kills; isolate the other way instead.
    assert.ok(!args.includes("--safe-mode"));
    assert.ok(args.includes("--setting-sources") && args.includes("--strict-mcp-config"));
    // Broad tool exposure so a skill reaches its toolset...
    assert.equal(args[args.indexOf("--tools") + 1], "default");
    // ...but execution stays gated by the agent's grant, plus ToolSearch.
    const allowed = args[args.indexOf("--allowedTools") + 1];
    assert.ok(allowed.includes("ToolSearch"));
    assert.ok(allowed.includes("WebSearch"), "granted web tool auto-approves for the skill");
    // The harness's own fan-out (Task/Agent/Workflow) is suppressed even on the
    // "default" toolset: all fan-out routes through gaia summons — visible
    // sub-rooms with result callback, never opaque in-CLI workers.
    assert.equal(args[args.indexOf("--disallowedTools") + 1], "Task,Agent,Workflow");
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("normal turn is unchanged: --safe-mode + wrapped prompt (native-command regression guard)", async () => {
  const fx = await webFixture();
  try {
    const fake = new FakeClaude();
    fake.script([initMsg(), textDelta("hi"), resultSuccess()]);
    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), processFactory: fake.factory });
    await collect(runtime.send({ roomId: "default", message: "hello", transcript: [] }));

    const { args, prompt } = fake.lastOptions!;
    assert.ok(args.includes("--safe-mode"));
    assert.ok(!args.includes("--setting-sources"));
    assert.notEqual(args[args.indexOf("--tools") + 1], "default");
    assert.ok(prompt.includes("Newest user message"));
    // Fan-out suppression applies on EVERY turn, not just native ones.
    assert.equal(args[args.indexOf("--disallowedTools") + 1], "Task,Agent,Workflow");
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("ClaudeRuntime reports subscription:false when an API key is the source", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeClaude();
    fake.script([initMsg("claude-opus-4-8", "ANTHROPIC_API_KEY"), textDelta("hi"), resultSuccess()]);

    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), processFactory: fake.factory });
    const events = await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    const info = events.find((e) => e.type === "model-info");
    assert.deepEqual(info, { type: "model-info", provider: "anthropic", modelId: "claude-opus-4-8", subscription: false });
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("ClaudeRuntime maps a model_fallback system message to model-info + model-fallback", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeClaude();
    fake.script([
      initMsg("claude-fable-5"),
      {
        type: "system",
        subtype: "model_fallback",
        trigger: "overloaded",
        original_model: "claude-fable-5",
        fallback_model: "claude-opus-4-8",
        content: "Switched to Opus 4.8 (Fable is overloaded)",
      },
      textDelta("hi"),
      resultSuccess(),
    ]);

    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), processFactory: fake.factory });
    const events = await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    const infos = events.filter((e) => e.type === "model-info");
    assert.equal(infos.length, 2);
    assert.deepEqual(infos[1], { type: "model-info", provider: "anthropic", modelId: "claude-opus-4-8", subscription: true });
    assert.deepEqual(events.find((e) => e.type === "model-fallback"), {
      type: "model-fallback",
      fromModel: "claude-fable-5",
      toModel: "claude-opus-4-8",
      reason: "Switched to Opus 4.8 (Fable is overloaded)",
    });
    // The runtime's own label follows the switch.
    assert.equal(runtime.modelLabel, "anthropic/claude-opus-4-8");
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("ClaudeRuntime maps model_refusal_fallback (safety reroute) and builds a reason when content is absent", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeClaude();
    fake.script([
      initMsg("claude-fable-5"),
      {
        type: "system",
        subtype: "model_refusal_fallback",
        trigger: "refusal",
        original_model: "claude-fable-5",
        fallback_model: "claude-opus-4-8",
      },
      textDelta("hi"),
      resultSuccess(),
    ]);

    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), processFactory: fake.factory });
    const events = await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    assert.deepEqual(events.find((e) => e.type === "model-fallback"), {
      type: "model-fallback",
      fromModel: "claude-fable-5",
      toModel: "claude-opus-4-8",
      reason: "switched to claude-opus-4-8 (refusal)",
    });
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("ClaudeRuntime reports context usage live per assistant round-trip + result.modelUsage window", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeClaude();
    fake.script([
      initMsg("claude-fable-5"),
      {
        type: "assistant",
        message: {
          usage: { input_tokens: 1_000, cache_creation_input_tokens: 200, cache_read_input_tokens: 5_000, output_tokens: 50 },
          content: [],
        },
      },
      textDelta("hi"),
      { ...resultSuccess(), modelUsage: { "claude-fable-5": { contextWindow: 200_000 } } },
    ]);

    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), processFactory: fake.factory });
    const events = await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    // input + both cache fields, output excluded — the CLI's own formula.
    const contextEvents = events.filter((e) => e.type === "context-usage");
    // Live: the assistant round-trip emits ctx immediately (window not yet known)…
    assert.deepEqual(contextEvents[0], { type: "context-usage", usedTokens: 6_200 });
    // …and the turn-end event carries the window so the chip can show a %.
    assert.deepEqual(contextEvents.at(-1), { type: "context-usage", usedTokens: 6_200, maxTokens: 200_000 });
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("ClaudeRuntime.compact runs a headless /compact turn and reports the boundary", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeClaude();
    fake.script([initMsg(), textDelta("hello"), resultSuccess()]); // establishes the session
    fake.script([
      { type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "manual", pre_tokens: 12_345 } },
      resultSuccess(),
    ]);

    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), processFactory: fake.factory });
    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    const result = await runtime.compact("default");
    // The structured `compacted` flag (not the message wording) drives the marker.
    assert.deepEqual(result, { compacted: true, message: "session compacted (12345 tokens before)." });
    const compactCall = fake.calls[1];
    assert.equal(compactCall.prompt, "/compact");
    assert.ok(compactCall.args.includes("--resume"));
    assert.ok(!compactCall.args.includes("--session-id"));
    // A room with no started session never spawns a process — a clean no-op.
    assert.deepEqual(await runtime.compact("other-room"), { compacted: false, message: "nothing to compact — no active session for this room." });
    assert.equal(fake.calls.length, 2);
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("ClaudeRuntime maps thinking blocks to thinking-start/delta/end", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeClaude();
    fake.script([
      initMsg(),
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "Let me think" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: " about it." } } },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "text" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Done." } } },
      resultSuccess(),
    ]);

    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), processFactory: fake.factory });
    const events = await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));
    const relevant = events.filter((e) => e.type !== "model-info");

    assert.deepEqual(relevant, [
      { type: "thinking-start" },
      { type: "thinking-delta", delta: "Let me think" },
      { type: "thinking-delta", delta: " about it." },
      { type: "thinking-end" },
      { type: "text-delta", delta: "Done." },
    ]);
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("ClaudeRuntime ignores signature_delta (no event emitted mid-thinking-block)", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeClaude();
    fake.script([
      initMsg(),
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "thinking" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "reasoning" } } },
      // Trailing cryptographic signature on the plaintext block — no user-facing event.
      { type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "sig-abc" } } },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "text" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Done." } } },
      resultSuccess(),
    ]);

    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), processFactory: fake.factory });
    const events = await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));
    const relevant = events.filter((e) => e.type !== "model-info");

    assert.deepEqual(relevant, [
      { type: "thinking-start" },
      { type: "thinking-delta", delta: "reasoning" },
      { type: "thinking-end" },
      { type: "text-delta", delta: "Done." },
    ]);
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("ClaudeRuntime surfaces a redacted_thinking block as thinking-start/end with a fallback note (no deltas ever arrive)", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeClaude();
    fake.script([
      initMsg(),
      // Safety-redacted block: arrives already-opaque in content_block_start, no deltas at all.
      { type: "stream_event", event: { type: "content_block_start", index: 0, content_block: { type: "redacted_thinking", data: "opaque-blob" } } },
      { type: "stream_event", event: { type: "content_block_stop", index: 0 } },
      { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "text" } } },
      { type: "stream_event", event: { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: "Done." } } },
      resultSuccess(),
    ]);

    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), processFactory: fake.factory });
    const events = await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));
    const relevant = events.filter((e) => e.type !== "model-info");

    assert.deepEqual(relevant[0], { type: "thinking-start" });
    assert.equal(relevant[1].type, "thinking-end");
    // No plaintext ever streamed for a redacted block, so the disclosure falls
    // back to thinkingNote()'s token-estimate note instead of being empty.
    assert.ok((relevant[1] as { content?: string }).content, "redacted block should fall back to a token-estimate note");
    assert.deepEqual(relevant[2], { type: "text-delta", delta: "Done." });
    assert.equal(relevant.length, 3);
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("ClaudeRuntime maps tool_use (assistant) and tool_result (user) to tool-start/tool-end", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeClaude();
    fake.script([
      initMsg(),
      {
        type: "assistant",
        message: { content: [{ type: "tool_use", id: "tu-1", name: "Read", input: { file_path: "/tmp/x" } }] },
      },
      {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "tu-1", content: "file body", is_error: false }] },
      },
      textDelta("Read it."),
      resultSuccess(),
    ]);

    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), processFactory: fake.factory });
    const events = await collect(runtime.send({ roomId: "default", message: "read", transcript: [] }));
    const relevant = events.filter((e) => e.type !== "model-info");

    assert.deepEqual(relevant[0], { type: "tool-start", toolName: "Read", toolCallId: "tu-1", args: { file_path: "/tmp/x" } });
    assert.deepEqual(relevant[1], { type: "tool-end", toolName: "Read", toolCallId: "tu-1", result: "file body", isError: false });
    assert.deepEqual(relevant[2], { type: "text-delta", delta: "Read it." });
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("ClaudeRuntime rejects on an error result", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeClaude();
    fake.script([initMsg(), { type: "result", subtype: "error_during_execution", is_error: true, result: "rate limit exceeded" }]);

    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), processFactory: fake.factory });
    await assert.rejects(
      () => collect(runtime.send({ roomId: "default", message: "hi", transcript: [] })),
      /rate limit exceeded/,
    );
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("ClaudeRuntime reports a clear error when the claude CLI is missing", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeClaude();
    const enoent = new Error("spawn claude ENOENT") as Error & { code: string };
    enoent.code = "ENOENT";
    fake.scriptSpawnError(enoent);

    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), processFactory: fake.factory });
    await assert.rejects(
      () => collect(runtime.send({ roomId: "default", message: "hi", transcript: [] })),
      /Claude Code is unavailable: the `claude` CLI was not found in PATH\./,
    );
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("ClaudeRuntime uses --session-id on the first turn and --resume after, with the same id", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeClaude();
    fake.script([initMsg(), textDelta("one"), resultSuccess()]);
    fake.script([initMsg(), textDelta("two"), resultSuccess()]);

    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), processFactory: fake.factory });
    await collect(runtime.send({ roomId: "default", message: "one", transcript: [] }));
    await collect(runtime.send({ roomId: "default", message: "two", transcript: [] }));

    const sessionFlagValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

    const first = fake.calls[0].args;
    const second = fake.calls[1].args;
    assert.ok(first.includes("--session-id"), "first turn passes --session-id");
    assert.ok(!first.includes("--resume"), "first turn does not resume");
    assert.ok(second.includes("--resume"), "second turn passes --resume");
    assert.ok(!second.includes("--session-id"), "second turn does not pass --session-id");
    assert.equal(sessionFlagValue(first, "--session-id"), sessionFlagValue(second, "--resume"));

    // Invariants: safe-mode isolation, custom system prompt, config-derived
    // tools/permissions, model.
    assert.ok(first.includes("--safe-mode"));
    assert.ok(first.includes("--system-prompt"));
    assert.equal(sessionFlagValue(first, "--tools"), "Read,Grep,Glob,Write,Edit,Bash");
    assert.equal(sessionFlagValue(first, "--allowedTools"), "Write,Edit,Bash(gaia mem:*),Bash(gaia recall:*)");
    // The 1M-window suffix rides on the --model arg (Claude Code drops to 200k
    // behind our proxy without it); the reported model id stays unsuffixed.
    assert.equal(sessionFlagValue(first, "--model"), "claude-opus-4-8[1m]");

    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("ClaudeRuntime keeps the session when a first turn is stopped after init (next turn resumes, not blank)", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeClaude();
    fake.scriptOpen([initMsg()]); // first turn: init arrives, then it never completes (stopped mid-stream)
    fake.script([initMsg(), textDelta("two"), resultSuccess()]); // the message AFTER the stop

    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), processFactory: fake.factory });

    // Consume the first turn's init (model-info), then break — the exact early
    // exit runAgentTurn performs on a user /stop. The generator's cleanup runs
    // WITHOUT a clean finish. Before the fix this left started=false AND the
    // first-turn catch reset dropped the session, so the next message started a
    // brand-new blank session (the "it forgot" bug).
    for await (const ev of runtime.send({ roomId: "default", message: "one", transcript: [] })) {
      assert.equal(ev.type, "model-info");
      break;
    }

    await collect(runtime.send({ roomId: "default", message: "two", transcript: [] }));

    const first = fake.calls[0].args;
    const second = fake.calls[1].args;
    assert.ok(second.includes("--resume"), "next turn resumes the session the stopped turn established");
    assert.ok(!second.includes("--session-id"), "next turn does not start a fresh (blank) session");
    const startedId = first[first.indexOf("--session-id") + 1];
    assert.equal(second[second.indexOf("--resume") + 1], startedId, "same session id carries across the stop");

    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("ClaudeRuntime passes configured MCP servers as --mcp-config with mcp__ allow rules", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeClaude();
    fake.script([initMsg(), textDelta("ok"), resultSuccess()]);

    fx.workspace.config.mcpServers = { linear: { url: "https://mcp.linear.app/sse" } };
    const mcpAgent = { ...fx.agent, mcpServers: { fs: { command: "npx", args: ["-y", "server-filesystem"] } } };
    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: mcpAgent, memoryStore: new MemoryStore(), processFactory: fake.factory });
    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    const args = fake.calls[0].args;
    const mcpConfig = JSON.parse(args[args.indexOf("--mcp-config") + 1]);
    // Workspace + agent sets merge (agent wins per name).
    assert.deepEqual(Object.keys(mcpConfig.mcpServers).sort(), ["fs", "linear"]);
    assert.equal(mcpConfig.mcpServers.fs.command, "npx");
    assert.equal(mcpConfig.mcpServers.linear.url, "https://mcp.linear.app/sse");
    const allowed = args[args.indexOf("--allowedTools") + 1];
    assert.ok(allowed.includes("mcp__fs"));
    assert.ok(allowed.includes("mcp__linear"));
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("ClaudeRuntime passes --permission-mode from the agent config (plan mode as data)", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeClaude();
    fake.script([initMsg(), textDelta("ok"), resultSuccess()]);

    const planAgent = { ...fx.agent, permissionMode: "plan" as const };
    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: planAgent, memoryStore: new MemoryStore(), processFactory: fake.factory });
    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    const args = fake.calls[0].args;
    assert.equal(args[args.indexOf("--permission-mode") + 1], "plan");
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("ClaudeRuntime omits --permission-mode when unset and passes empty --tools for a no-tool agent", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeClaude();
    fake.script([initMsg(), textDelta("ok"), resultSuccess()]);

    const bareAgent = { ...fx.agent, tools: [] };
    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: bareAgent, memoryStore: new MemoryStore(), processFactory: fake.factory });
    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    const args = fake.calls[0].args;
    assert.ok(!args.includes("--permission-mode"), "no permission-mode flag when unset");
    assert.equal(args[args.indexOf("--tools") + 1], "", "empty tools disables all tools");
    assert.ok(!args.includes("--allowedTools"), "no allow rules when there are no tools");
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("ClaudeRuntime keeps a separate session per room and restarts after a failed first turn", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeClaude();
    // room A ok, room B ok, then a first turn for room C that fails BEFORE init
    // (no session ever created), then a retry for C. A failure before init is
    // the only first-turn failure that still drops the session — an error AFTER
    // init leaves a resumable session and is kept (see the "stopped after init"
    // test), so this fails without ever emitting init.
    fake.script([initMsg(), textDelta("A"), resultSuccess()]);
    fake.script([initMsg(), textDelta("B"), resultSuccess()]);
    fake.script([{ type: "result", subtype: "error_during_execution", is_error: true, result: "boom" }]);
    fake.script([initMsg(), textDelta("C"), resultSuccess()]);

    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), processFactory: fake.factory });
    await collect(runtime.send({ roomId: "a", message: "x", transcript: [] }));
    await collect(runtime.send({ roomId: "b", message: "x", transcript: [] }));
    await assert.rejects(() => collect(runtime.send({ roomId: "c", message: "x", transcript: [] })), /boom/);
    await collect(runtime.send({ roomId: "c", message: "x", transcript: [] }));

    const flagValue = (args: string[], flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
    const idA = flagValue(fake.calls[0].args, "--session-id");
    const idB = flagValue(fake.calls[1].args, "--session-id");
    assert.notEqual(idA, idB, "rooms get distinct session ids");

    // C failed before init established a session, so nothing resumable exists —
    // the retry is a fresh --session-id, not a --resume of a session that was
    // never created.
    assert.ok(fake.calls[3].args.includes("--session-id"), "retry after a pre-init failure starts fresh");
    assert.ok(!fake.calls[3].args.includes("--resume"), "retry does not resume a session that was never created");
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("ClaudeRuntime injects memory/room env for the gaia CLI and a daemon token when a host is present", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeClaude();
    fake.script([initMsg(), textDelta("ok"), resultSuccess()]);

    const host = {
      baseUrl: "http://127.0.0.1:9999",
      llmProxyUrl: "http://127.0.0.1:9999/llm",
      mintToken: ({ agentId, roomId }: { agentId: string; roomId: string }) => `tok:${agentId}:${roomId}`,
    };
    const runtime = new ClaudeRuntime({
      workspace: fx.workspace,
      agent: fx.agent,
      memoryStore: new MemoryStore(),
      processFactory: fake.factory,
      harnessHost: host,
    });
    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    const env = fake.calls[0].env;
    assert.equal(env.GAIA_MEMORY_DIR, fx.agent.memoryDir);
    assert.equal(env.GAIA_ROOM_DIR, join(fx.workspace.roomsDir, "default"));
    assert.equal(env.GAIA_ROOM_ID, "default");
    assert.equal(env.GAIA_AGENT_ID, "gaia");
    assert.equal(env.GAIA_DAEMON_URL, "http://127.0.0.1:9999");
    assert.equal(env.GAIA_DAEMON_TOKEN, "tok:gaia:default");
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("ClaudeRuntime omits daemon env when no host is present but still sets read env", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeClaude();
    fake.script([initMsg(), textDelta("ok"), resultSuccess()]);

    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), processFactory: fake.factory });
    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    const env = fake.calls[0].env;
    assert.equal(env.GAIA_MEMORY_DIR, fx.agent.memoryDir);
    assert.equal(env.GAIA_DAEMON_URL, undefined);
    assert.equal(env.GAIA_DAEMON_TOKEN, undefined);
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("ClaudeRuntime routes egress through the thinking shim only when revealThinking is set", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeClaude();
    fake.script([initMsg(), textDelta("ok"), resultSuccess()]);
    const agent = { ...fx.agent, revealThinking: true };
    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent, memoryStore: new MemoryStore(), processFactory: fake.factory });
    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    // ANTHROPIC_BASE_URL is redirected to a fresh loopback proxy.
    const base = fake.calls[0].env.ANTHROPIC_BASE_URL;
    assert.match(String(base), /^http:\/\/127\.0\.0\.1:\d+$/);
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("ClaudeRuntime leaves ANTHROPIC_BASE_URL untouched without revealThinking", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeClaude();
    fake.script([initMsg(), textDelta("ok"), resultSuccess()]);
    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), processFactory: fake.factory });
    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    // Passthrough: whatever the ambient env had (usually nothing), never a shim.
    assert.equal(fake.calls[0].env.ANTHROPIC_BASE_URL, process.env.ANTHROPIC_BASE_URL);
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("ClaudeRuntime appends a gaia CLI pointer to the system prompt for memory/recall agents", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeClaude();
    fake.script([initMsg(), textDelta("ok"), resultSuccess()]);

    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), processFactory: fake.factory });
    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    const args = fake.calls[0].args;
    const systemPrompt = args[args.indexOf("--system-prompt") + 1];
    assert.match(systemPrompt, /gaia mem/);
    assert.match(systemPrompt, /gaia recall/);
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("ClaudeRuntime adds no gaia pointer when the agent has no gaia tools", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeClaude();
    fake.script([initMsg(), textDelta("ok"), resultSuccess()]);

    const bareAgent = { ...fx.agent, tools: ["read"] };
    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: bareAgent, memoryStore: new MemoryStore(), processFactory: fake.factory });
    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    const args = fake.calls[0].args;
    const systemPrompt = args[args.indexOf("--system-prompt") + 1];
    assert.ok(!/gaia mem/.test(systemPrompt), "no gaia pointer without gaia tools");
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("ClaudeRuntime abort kills the active process", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeClaude();
    // Open turn: emits init but never sends a result, so send() hangs.
    fake.scriptOpen([initMsg()]);

    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), processFactory: fake.factory });
    const sendPromise = collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));

    await new Promise((r) => setTimeout(r, 20));
    await runtime.abort();
    assert.equal(fake.killCount, 1);

    // Unwind the iterator by completing the process.
    fake.lastOptions?.onExit({ code: 0, signal: null, stderr: "" });
    await sendPromise;
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("ClaudeRuntime modelLabel reports the configured model before the first turn", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeClaude();
    fake.script([initMsg(), textDelta("ok"), resultSuccess()]);

    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), processFactory: fake.factory });
    assert.equal(runtime.modelLabel, "anthropic/claude-opus-4-8");
    await collect(runtime.send({ roomId: "default", message: "hi", transcript: [] }));
    assert.equal(runtime.modelLabel, "anthropic/claude-opus-4-8");
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("ClaudeRuntime sends memory in the turn prompt only when it changed", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeClaude();
    fake.script([initMsg(), textDelta("one"), resultSuccess()]);
    fake.script([initMsg(), textDelta("two"), resultSuccess()]);
    fake.script([initMsg(), textDelta("three"), resultSuccess()]);

    const store = new MemoryStore();
    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: store, processFactory: fake.factory });

    await collect(runtime.send({ roomId: "default", message: "one", transcript: [] }));
    await collect(runtime.send({ roomId: "default", message: "two", transcript: [] }));
    assert.match(fake.calls[0].prompt, /# Your persistent memory/);
    assert.doesNotMatch(fake.calls[1].prompt, /# Your persistent memory/);

    // A memory write flows into the NEXT turn prompt.
    await store.mutate(fx.agent.memoryDir, "MEMORY.md", "add", { content: "user prefers tabs" });
    await collect(runtime.send({ roomId: "default", message: "three", transcript: [] }));
    assert.match(fake.calls[2].prompt, /user prefers tabs/);
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("ClaudeRuntime sends pasted images as stream-json input with base64 blocks", async () => {
  const fx = await fixture();
  try {
    const imagePath = join(fx.project, "shot.png");
    const bytes = Buffer.from("fake-png-bytes");
    await writeFile(imagePath, bytes);

    const fake = new FakeClaude();
    fake.script([initMsg(), textDelta("I see it"), resultSuccess()]);
    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), processFactory: fake.factory });
    await collect(
      runtime.send({
        roomId: "default",
        message: "look",
        transcript: [],
        attachments: [{ name: "shot.png", mime: "image/png", size: bytes.length, path: imagePath }],
      }),
    );

    const options = fake.lastOptions!;
    assert.ok(options.args.join(" ").includes("--input-format stream-json"));
    // stdin carries ONE stream-json user message: turn prompt + image block.
    const line = JSON.parse(options.prompt) as {
      type: string;
      message: { role: string; content: Array<Record<string, unknown>> };
    };
    assert.equal(line.type, "user");
    assert.equal(line.message.role, "user");
    assert.equal(line.message.content[0].type, "text");
    assert.match(String(line.message.content[0].text), /\[attached file: shot\.png \(image\/png, 14 B\) at /);
    assert.deepEqual(line.message.content[1], {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: bytes.toString("base64") },
    });
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("ClaudeRuntime references a non-image attachment by breadcrumb in the stream-json prompt", async () => {
  const fx = await fixture();
  try {
    const csvPath = join(fx.project, "data.csv");
    await writeFile(csvPath, "a,b\n");

    const fake = new FakeClaude();
    fake.script([initMsg(), textDelta("ok"), resultSuccess()]);
    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), processFactory: fake.factory });
    await collect(
      runtime.send({
        roomId: "default",
        message: "read it",
        transcript: [],
        attachments: [{ name: "data.csv", mime: "text/csv; charset=utf-8", size: 4, path: csvPath }],
      }),
    );

    const options = fake.lastOptions!;
    // Every non-native turn now rides stream-json input with stdin kept open —
    // that's the channel steering injects into.
    assert.ok(options.args.includes("--input-format"));
    assert.equal(options.keepStdinOpen, true);
    // A non-image file is a TEXT breadcrumb, not an image block: the user
    // message content is a plain string carrying the uniform path breadcrumb.
    const payload = JSON.parse(options.prompt) as { message: { content: unknown } };
    assert.equal(typeof payload.message.content, "string");
    assert.match(payload.message.content as string, /\[attached file: data\.csv \(text\/csv; charset=utf-8, 4 B\) at /);
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("ClaudeRuntime.steer injects into the running turn's open stdin", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeClaude();
    // scriptOpen leaves the turn live (no result/exit) so this.active stays set.
    fake.scriptOpen([initMsg(), textDelta("working")]);
    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), processFactory: fake.factory });
    assert.equal(runtime.capabilities.supportsSteer, true);

    // Nothing running yet: there's nothing to steer.
    assert.equal(await runtime.steer("default", "too early"), false);

    const iter = runtime.send({ roomId: "default", message: "go", transcript: [] })[Symbol.asyncIterator]();
    await iter.next(); // drive send() until the process is spawned and streaming

    assert.equal(await runtime.steer("default", "actually stop"), true);
    assert.deepEqual(fake.steers, ["actually stop"]);
    // A steer aimed at a different room never injects into this turn.
    assert.equal(await runtime.steer("other-room", "nope"), false);
    assert.deepEqual(fake.steers, ["actually stop"]);

    await iter.return?.(); // close the generator → finally closes stdin (endInput)
    assert.equal(fake.endInputCount, 1);
    // The turn ended: steering is a no-op again.
    assert.equal(await runtime.steer("default", "late"), false);
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("ClaudeRuntime folds a steer's continuation turn into the reply instead of dropping it on the first result", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeClaude();
    // A live turn: init + first text, no result yet (we feed the rest by hand
    // so a steer can land BEFORE the first result, as it does at a turn's tail).
    fake.scriptOpen([initMsg(), textDelta("part1 ")]);
    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), processFactory: fake.factory });

    const collected: AgentEvent[] = [];
    let done = false;
    const drained = (async () => {
      for await (const ev of runtime.send({ roomId: "default", message: "go", transcript: [] })) collected.push(ev);
      done = true;
    })();
    const tick = () => new Promise((resolve) => setTimeout(resolve, 15));
    await tick(); // factory's setTimeout(0) feeds init + part1; this.active is set

    // Steer while the turn is live — this is what defers the close on result.
    assert.equal(await runtime.steer("default", "also do X"), true);

    // First result arrives. WITHOUT the fix this closes the turn and the steer's
    // continuation is lost. WITH it, the turn stays open awaiting the continuation.
    fake.lastOptions!.onMessage(resultSuccess("part1 "));
    await tick();
    assert.equal(done, false, "turn must NOT end on the first result while a steer is pending");

    // The CLI runs the injected message as its own continuation turn; its events
    // fold into this same reply. The continuation's init cancels the grace wait.
    fake.lastOptions!.onMessage(initMsg());
    fake.lastOptions!.onMessage(textDelta("part2"));
    fake.lastOptions!.onMessage(resultSuccess("part2"));
    await drained; // second result (no steer pending) closes the turn

    const text = collected
      .filter((ev): ev is Extract<AgentEvent, { type: "text-delta" }> => ev.type === "text-delta")
      .map((ev) => ev.delta)
      .join("");
    assert.equal(text, "part1 part2", "the continuation's text folds into the reply, not dropped");
    assert.equal(done, true);
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

test("ClaudeRuntime closes normally on the first result when no steer is pending (no added latency)", async () => {
  const fx = await fixture();
  try {
    const fake = new FakeClaude();
    fake.script([initMsg(), textDelta("hi"), resultSuccess()]);
    const runtime = new ClaudeRuntime({ workspace: fx.workspace, agent: fx.agent, memoryStore: new MemoryStore(), processFactory: fake.factory });
    const collected: AgentEvent[] = [];
    const start = Date.now();
    for await (const ev of runtime.send({ roomId: "default", message: "go", transcript: [] })) collected.push(ev);
    // No grace delay: a plain turn ends promptly on its single result.
    assert.ok(Date.now() - start < 500, "an unsteered turn must not wait the steer-continuation grace");
    assert.ok(collected.some((ev) => ev.type === "text-delta"));
    runtime.dispose();
  } finally {
    await fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// hasDurableSession — the on-disk descriptor the shared turn loop reads before
// trusting a deep cursor (a lost session must replay history, never skip it)
// ---------------------------------------------------------------------------

test("hasDurableSession: only an ESTABLISHED handle counts; legacy bare key honored", async () => {
  const temp = await createTempDir();
  try {
    const spec = findHarness("claude")!;
    const roomDir = join(temp.path, ".gaia", "rooms", "default");
    await mkdir(roomDir, { recursive: true });

    // No sessions file at all → nothing to resume.
    assert.equal(spec.hasDurableSession!(temp.path, "default", "ari"), false);

    // Agent-scoped handle, established → resumable.
    await writeFile(join(roomDir, "harness-sessions.json"), JSON.stringify({ "claude:ari": { sessionId: "s1", started: true } }), "utf8");
    assert.equal(spec.hasDurableSession!(temp.path, "default", "ari"), true);
    // Another agent's handle is NOT this agent's session.
    assert.equal(spec.hasDurableSession!(temp.path, "default", "nyari"), false);

    // Generated-but-never-run id resumes nothing.
    await writeFile(join(roomDir, "harness-sessions.json"), JSON.stringify({ "claude:ari": { sessionId: "s1", started: false } }), "utf8");
    assert.equal(spec.hasDurableSession!(temp.path, "default", "ari"), false);

    // Legacy bare-harness key (rooms written before agent-scoping) still counts.
    await writeFile(join(roomDir, "harness-sessions.json"), JSON.stringify({ claude: { sessionId: "s2", started: true } }), "utf8");
    assert.equal(spec.hasDurableSession!(temp.path, "default", "ari"), true);
  } finally {
    await temp.cleanup();
  }
});
