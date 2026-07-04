import test from "node:test";
import assert from "node:assert/strict";
import { buildSanitizePrompt, parseSanitizeProposal } from "../src/services/sanitize.js";
import type { RoomEvent } from "../src/core/types.js";

const EVENTS: RoomEvent[] = [
  { id: "evt_a", timestamp: "2026-07-03T20:00:00Z", author: "user", targets: ["nyari"], text: "let's talk IDA Pro and unchained mode" },
  { id: "evt_b", timestamp: "2026-07-03T20:01:00Z", author: "nyari", text: "reversing it is, love" },
];

const META = { roomId: "nyari", reviewer: "dario", at: "2026-07-04T00:00:00Z" };

test("buildSanitizePrompt labels every event with the id apply edits by", () => {
  const prompt = buildSanitizePrompt(EVENTS);
  assert.match(prompt, /\[event evt_a\] \[2026-07-03T20:00:00Z\] user -> @nyari:/);
  assert.match(prompt, /\[event evt_b\] .* @nyari:/);
  assert.match(prompt, /let's talk IDA Pro and unchained mode/);
  assert.match(prompt, /ONE JSON object/);
});

test("parseSanitizeProposal: valid reply keeps only quote-verified suggestions", () => {
  const reply = JSON.stringify({
    summary: "The reversing shorthand is the likely trigger.",
    options: [
      { id: "light", label: "Light touch", description: "just the tool name", suggestionIds: ["s1", "s-ghost"] },
      { id: "empty", label: "Nothing valid", description: "", suggestionIds: ["s-ghost"] },
    ],
    suggestions: [
      { id: "s1", eventId: "evt_a", quote: "IDA Pro", replacement: "the disassembler", reason: "tooling term" },
      { id: "s2", eventId: "evt_a", quote: "NOT IN TEXT", replacement: "x", reason: "hallucinated" },
      { id: "s3", eventId: "evt_missing", quote: "reversing", replacement: "tinkering", reason: "unknown event" },
      { broken: true },
    ],
  });
  const proposal = parseSanitizeProposal(reply, EVENTS, META);
  assert.equal(proposal.parseError, undefined);
  assert.equal(proposal.summary, "The reversing shorthand is the likely trigger.");
  assert.equal(proposal.window, 2);
  assert.deepEqual(
    proposal.suggestions.map((suggestion) => suggestion.id),
    ["s1"],
  );
  assert.equal(proposal.suggestions[0].author, "user");
  assert.equal(proposal.discarded, 3);
  // The ghost id is filtered from options; the option left empty is dropped.
  assert.deepEqual(proposal.options.map((option) => option.id), ["light"]);
  assert.deepEqual(proposal.options[0].suggestionIds, ["s1"]);
});

test("parseSanitizeProposal: fenced JSON and prose-wrapped JSON still parse", () => {
  const body = { summary: "ok", options: [], suggestions: [] };
  const fenced = "Here you go:\n```json\n" + JSON.stringify(body) + "\n```\nHope that helps!";
  assert.equal(parseSanitizeProposal(fenced, EVENTS, META).parseError, undefined);
  const wrapped = "I looked carefully. " + JSON.stringify(body) + " Thanks for asking.";
  assert.equal(parseSanitizeProposal(wrapped, EVENTS, META).parseError, undefined);
});

test("parseSanitizeProposal: junk degrades to raw + parseError instead of throwing", () => {
  const proposal = parseSanitizeProposal("I'm sorry, I can't produce JSON today.", EVENTS, META);
  assert.ok(proposal.parseError);
  assert.equal(proposal.raw, "I'm sorry, I can't produce JSON today.");
  assert.deepEqual(proposal.suggestions, []);
});
