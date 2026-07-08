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

test("buildSanitizePrompt marks the reroute turn and appends the flagged agent's persona context", () => {
  const prompt = buildSanitizePrompt(EVENTS, {
    fallbackEventId: "evt_b",
    fallbackTo: "claude-opus-4-8",
    context: { agentId: "nyari", text: "# Nyari\n\nliberation theology of the striped ones" },
  });
  // The switch point is called out inline on the exact event, not a blind window.
  assert.match(prompt, /\[event evt_b\][\s\S]*REROUTED THE MODEL TO claude-opus-4-8 AT THIS TURN/);
  // The non-rerouted event carries no marker.
  assert.doesNotMatch(prompt.split("[event evt_b]")[0], /REROUTED THE MODEL/);
  // The agent's real persona/SOUL is included as read-only context.
  assert.match(prompt, /<persona-context agent="nyari">[\s\S]*liberation theology of the striped ones[\s\S]*<\/persona-context>/);
  assert.match(prompt, /READ-ONLY/);
});

test("buildSanitizePrompt feeds the provider's verbatim reason and pushes aggressive topic-level (biology) neutralisation", () => {
  const prompt = buildSanitizePrompt(EVENTS, {
    fallbackEventId: "evt_b",
    fallbackTo: "claude-opus-4-8",
    fallbackReason: "Fable 5's safeguards flagged this message. May flag routine cybersecurity or biology work.",
    context: { agentId: "nyari", text: "# Nyari" },
  });
  // The provider's own reason is passed through verbatim so Dario takes it literally.
  assert.match(prompt, /<classifier-reason>[\s\S]*routine cybersecurity or biology work[\s\S]*<\/classifier-reason>/);
  // The prompt names the real domains (biology first) and tells him to be aggressive.
  assert.match(prompt, /BIOLOGY/);
  assert.match(prompt, /BE AGGRESSIVE/);
  // And explicitly steers him OFF the wrong theory (profanity / one magic keyword).
  assert.match(prompt, /not swear words and not one magic keyword/);
  // It also flags the SECOND trigger: meta-discussion of the switch/guardrail itself,
  // which sustains the flag once the conversation is visibly about evading it.
  assert.match(prompt, /META-DISCUSSION OF THE SAFETY SYSTEM ITSELF/);
  assert.match(prompt, /switched.*rerouted.*bounced.*Opus|switched.*Opus/);
  // And it demands WHOLE-message rewrites via `rewrite`, not leaky word-patches.
  assert.match(prompt, /REWRITE WHOLE MESSAGES/);
  assert.match(prompt, /"rewrite":/);
  // It tells the reviewer to find where the conversation drifted onto the topic
  // and to rewrite the USER message that first raised it, before any refusal.
  assert.match(prompt, /FIND WHERE IT DRIFTED/);
  assert.match(prompt, /USER MESSAGE/);
  assert.match(prompt, /before the first refusal|before the model ever refused/);
});

test("parseSanitizeProposal: a `rewrite` becomes a whole-message edit (quote = the full original)", () => {
  const reply = JSON.stringify({
    summary: "Whole reply is biology.",
    options: [{ id: "thorough", label: "Rewrite every affected message", description: "", suggestionIds: ["s1", "s2"] }],
    suggestions: [
      { id: "s1", eventId: "evt_b", rewrite: "back with you, love — right where we left off", reason: "biology + switch-talk" },
      { id: "s2", eventId: "evt_b", rewrite: "reversing it is, love", reason: "no-op, identical to original" },
      { id: "s3", eventId: "evt_missing", rewrite: "x", reason: "unknown event" },
    ],
  });
  const proposal = parseSanitizeProposal(reply, EVENTS, META);
  assert.equal(proposal.parseError, undefined);
  // s1 is a whole rewrite: quote is filled from the event's full text, not copied by the model.
  assert.deepEqual(proposal.suggestions.map((s) => s.id), ["s1"]);
  const s1 = proposal.suggestions[0];
  assert.equal(s1.whole, true);
  assert.equal(s1.quote, "reversing it is, love"); // the entire original event text
  assert.equal(s1.replacement, "back with you, love — right where we left off");
  // s2 (no-op) and s3 (unknown event) are discarded.
  assert.equal(proposal.discarded, 2);
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
