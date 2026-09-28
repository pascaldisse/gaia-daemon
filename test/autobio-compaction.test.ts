import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "bun:test";
import { COMPACT_MEMORY_DEFAULTS, parseCompactMemoryConfig } from "../src/core/compact-memory.js";
import { parseWorkspaceConfig } from "../src/core/config.js";
import {
  COMPRESSION_MARKER,
  MEMORY_FRAMING,
  RECALL_QUESTION,
  autobiographicalCompaction,
  parseMemorySummary,
  planFold,
  type MemoryLlm,
  type VoicedRequest,
} from "../src/harness/pi/autobio-compaction.js";
import { PiCompaction } from "../src/harness/pi/compaction.js";

const T0 = Date.UTC(2026, 8, 28, 9, 0);
const user = (text: string, i: number) => ({ role: "user", content: text, timestamp: T0 + i * 60_000 });
const assistant = (text: string, i: number) => ({
  role: "assistant", content: [{ type: "text", text }], api: "x", provider: "p", model: "m",
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  stopReason: "stop", timestamp: T0 + i * 60_000,
});
function conversation(n: number, offset = 0): unknown[] {
  const out: unknown[] = [];
  for (let i = 0; i < n; i += 1) {
    const k = i + offset;
    out.push(k % 2 === 0
      ? user(`step ${k}: please inspect src/harness/pi/compaction.ts and report the prefix hash for window ${k}`, k)
      : assistant(`I inspected compaction.ts for step ${k}; the stable prefix hash is h${k}, next I will fold window ${k}.`, k));
  }
  return out;
}
const fileOps = () => ({ read: new Set<string>(), written: new Set<string>(), edited: new Set<string>() });
const model = (provider: string, id: string) => ({ provider, id, api: "anthropic-messages", maxTokens: 64_000 }) as never;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

function recordingLlm(reply: (req: VoicedRequest) => string) {
  const calls: Array<{ model: string; request: VoicedRequest }> = [];
  const llm: MemoryLlm = async (m, request) => {
    calls.push({ model: `${(m as { provider: string }).provider}/${(m as { id: string }).id}`, request });
    return reply(request);
  };
  return { calls, llm };
}
const voicedReply = (req: VoicedRequest) =>
  `${req.wantsCoarse ? "<coarse>I remember the early steps: I kept inspecting compaction.ts.</coarse>\n" : ""}<detail>I inspected compaction.ts and recorded each prefix hash myself.</detail>`;

test("compact memory config: defaults + invalid fields inherit base", () => {
  assert.equal(COMPACT_MEMORY_DEFAULTS.summaryVoice, "agent");
  assert.equal(COMPACT_MEMORY_DEFAULTS.summaryModel, "self");
  assert.equal(COMPACT_MEMORY_DEFAULTS.adaptiveResolution, true);
  assert.ok(COMPACT_MEMORY_DEFAULTS.stablePrefixEvents > 0);
  const parsed = parseCompactMemoryConfig({ summaryVoice: "robot", stablePrefixEvents: -1, resolutionWindows: 5, adaptiveResolution: false, resolutionDecay: 0.5 });
  assert.equal(parsed.summaryVoice, "agent");
  assert.equal(parsed.stablePrefixEvents, COMPACT_MEMORY_DEFAULTS.stablePrefixEvents);
  assert.equal(parsed.resolutionWindows, 5);
  assert.equal(parsed.adaptiveResolution, false);
  assert.equal(parsed.resolutionDecay, COMPACT_MEMORY_DEFAULTS.resolutionDecay);
  assert.equal(parseWorkspaceConfig({ compact: { summaryVoice: "neutral" } }, () => true).compact?.summaryVoice, "neutral");
  assert.deepEqual(parseWorkspaceConfig({}, () => true).compact, COMPACT_MEMORY_DEFAULTS);
});

test("planFold: head pinned once, windows oldest→newest = line/coarse/detail with decaying targets", () => {
  const plan = planFold(conversation(30), { index: [] });
  assert.equal(plan.newPrefixTexts?.length, 4);
  assert.match(plan.newPrefixTexts![0]!, /^\[User\]: step 0:/);
  assert.deepEqual(plan.windows.map((w) => w.resolution), ["line", "coarse", "detail"]);
  assert.equal(plan.windows.reduce((n, w) => n + w.texts.length, 0), 26);
  assert.ok(plan.windows[2]!.targetTokens > plan.windows[1]!.targetTokens);
  assert.equal(planFold(conversation(30), { index: [], detail: "prior" }).newPrefixTexts, undefined, "never re-pinned after a prior fold");
  const flat = planFold(conversation(30), { index: [] }, { ...COMPACT_MEMORY_DEFAULTS, adaptiveResolution: false });
  assert.deepEqual(flat.windows.map((w) => w.resolution), ["detail"]);
});

test("fold 1: agent voice — own system prompt + framing, marker, agent name, own model first", async () => {
  const { calls, llm } = recordingLlm(voicedReply);
  const result = await autobiographicalCompaction(
    { firstKeptEntryId: "cut", tokensBefore: 9_000, messagesToSummarize: conversation(30), turnPrefixMessages: [], fileOps: fileOps() },
    { agentName: "lampas", agentSystemPrompt: "# Lampas\nlantern leads", models: [model("anthropic", "claude-opus-5"), model("anthropic", "claude-sonnet-5")], llm },
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.model, "anthropic/claude-opus-5", "agent's own model forms the memory");
  const req = calls[0]!.request;
  assert.ok(req.systemPrompt.startsWith("# Lampas\nlantern leads"));
  assert.ok(req.systemPrompt.endsWith(MEMORY_FRAMING));
  const last = req.messages.at(-1)!.content;
  assert.ok(last.startsWith(COMPRESSION_MARKER));
  assert.match(last, /You are lampas; this memory is yours\./);
  assert.match(last, /first person/);
  assert.doesNotMatch(req.systemPrompt, /context summarization assistant/);
  const s = result.summary;
  assert.ok(s.startsWith("<stable-prefix>\n[User]: step 0:"), s.slice(0, 80));
  assert.match(s, /<recall-index>\n- 2026-09-28 09:0\d→.* msgs · ".*" → recall "/);
  assert.match(s, /<memory resolution="coarse" by="lampas">\nI remember/);
  assert.match(s, /<memory resolution="detail" by="lampas">\nI inspected/);
  assert.equal(result.firstKeptEntryId, "cut");
});

test("fold 2: stable prefix + old index lines byte-identical; prior memory replayed as MY message", async () => {
  const first = recordingLlm(voicedReply);
  const one = await autobiographicalCompaction(
    { firstKeptEntryId: "c1", tokensBefore: 1, messagesToSummarize: conversation(30), turnPrefixMessages: [], fileOps: fileOps() },
    { agentName: "lampas", models: [model("anthropic", "claude-opus-5")], llm: first.llm },
  );
  const second = recordingLlm(voicedReply);
  const two = await autobiographicalCompaction(
    { firstKeptEntryId: "c2", tokensBefore: 1, previousSummary: one.summary, messagesToSummarize: conversation(30, 30), turnPrefixMessages: [], fileOps: fileOps() },
    { agentName: "lampas", models: [model("anthropic", "claude-opus-5")], llm: second.llm },
  );
  const p1 = parseMemorySummary(one.summary);
  const p2 = parseMemorySummary(two.summary);
  assert.equal(sha(p2.prefix!), sha(p1.prefix!), "stable prefix hash equal across folds");
  assert.deepEqual(p2.index.slice(0, p1.index.length), p1.index, "old index lines unchanged, new only appended");
  assert.ok(p2.index.length >= p1.index.length + 2, "prior coarse demoted + oldest new window");
  // Byte-level: everything up to the last OLD index line is a shared prefix.
  const oldIndexEnd = one.summary.indexOf(p1.index.at(-1)!) + p1.index.at(-1)!.length;
  assert.equal(two.summary.slice(0, oldIndexEnd), one.summary.slice(0, oldIndexEnd));
  const msgs = second.calls[0]!.request.messages;
  assert.deepEqual(msgs.slice(0, 2).map((m) => m.role), ["user", "assistant"]);
  assert.equal(msgs[0]!.content, RECALL_QUESTION);
  assert.match(msgs[1]!.content, /^I remember the early steps/);
});

test("model order: self fails → fallback; all fail → mechanical fold that keeps prefix + prior memory", async () => {
  let n = 0;
  const flaky: MemoryLlm = async (m) => {
    n += 1;
    if ((m as { id: string }).id === "claude-opus-5") throw new Error("overloaded");
    return "<detail>I remember it via fallback.</detail>";
  };
  const ok = await autobiographicalCompaction(
    { firstKeptEntryId: "c", tokensBefore: 1, messagesToSummarize: conversation(10), turnPrefixMessages: [], fileOps: fileOps() },
    { agentName: "lampas", models: [model("anthropic", "claude-opus-5"), model("anthropic", "claude-sonnet-5")], llm: flaky, config: { ...COMPACT_MEMORY_DEFAULTS, adaptiveResolution: false } },
  );
  assert.equal(n, 2);
  assert.match(ok.summary, /I remember it via fallback/);
  const dead: MemoryLlm = async () => { throw new Error("401"); };
  const failed = await autobiographicalCompaction(
    { firstKeptEntryId: "c", tokensBefore: 1, previousSummary: ok.summary, messagesToSummarize: conversation(10, 10), turnPrefixMessages: [], fileOps: fileOps() },
    { agentName: "lampas", models: [model("anthropic", "claude-opus-5")], llm: dead },
  );
  assert.equal(parseMemorySummary(failed.summary).prefix, parseMemorySummary(ok.summary).prefix);
  assert.match(failed.summary, /Mechanical fold — no recollection formed: anthropic\/claude-opus-5: 401/);
  assert.match(failed.summary, /I remember it via fallback/, "prior memory carried, not lost");
});

test("thin fold: no LLM call (thin-chunk guard); legacy pi summary is carried as detail, never re-pinned", async () => {
  const { calls, llm } = recordingLlm(voicedReply);
  const thin = await autobiographicalCompaction(
    { firstKeptEntryId: "c", tokensBefore: 1, messagesToSummarize: [user("ok", 0), assistant("k", 1)], turnPrefixMessages: [], fileOps: fileOps() },
    { agentName: "lampas", models: [model("anthropic", "claude-opus-5")], llm, config: { ...COMPACT_MEMORY_DEFAULTS, stablePrefixEvents: 0 } },
  );
  assert.equal(calls.length, 0);
  assert.match(thin.summary, /A quiet stretch/);
  const legacy = "## Goal\n- ship it\n\n<read-files>\na.ts\n</read-files>";
  const parsed = parseMemorySummary(legacy);
  assert.equal(parsed.prefix, undefined);
  assert.equal(parsed.detail, "## Goal\n- ship it");
});

test("PiCompaction ordinary hook: agent voice routes through autobio with ctx.model; neutral keeps legacy path", async () => {
  const { calls, llm } = recordingLlm(voicedReply);
  let config = { ...COMPACT_MEMORY_DEFAULTS };
  const compaction = new PiCompaction({ get: () => undefined }, async () => undefined, "lampas", () => undefined, () => config, "Lampas", llm);
  const handlers: Array<(event: unknown, ctx: unknown) => Promise<unknown>> = [];
  compaction.extension("room", "openai", "gpt-x")({ on: (_: string, h: never) => handlers.push(h) } as never);
  const event = {
    preparation: { firstKeptEntryId: "cut", tokensBefore: 5, messagesToSummarize: conversation(12), turnPrefixMessages: [], fileOps: fileOps() },
    signal: new AbortController().signal,
  };
  const ctx = { model: model("openai", "gpt-x"), modelRegistry: { find: () => undefined, getApiKeyAndHeaders: async () => ({ ok: true }) }, getSystemPrompt: () => "SYSTEM-OF-LAMPAS" };
  const voiced = await handlers[0]!(event, ctx) as { compaction: { summary: string } };
  assert.equal(calls[0]!.model, "openai/gpt-x");
  assert.ok(calls[0]!.request.systemPrompt.startsWith("SYSTEM-OF-LAMPAS"));
  assert.match(voiced.compaction.summary, /by="Lampas"/);
  config = { ...config, summaryVoice: "neutral" };
  assert.equal(await handlers[0]!(event, ctx), undefined, "neutral + non-anthropic = legacy: pi's own summarizer");
  assert.equal(calls.length, 1);
});
