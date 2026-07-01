import test from "node:test";
import assert from "node:assert/strict";
import { hasExplicitMention, parseCommand, planMentionRoute } from "../src2/services/commands.js";

test("parseCommand: plain text is a message", () => {
  assert.deepEqual(parseCommand("hello there"), { type: "message", text: "hello there" });
});

test("parseCommand: known commands and arguments", () => {
  assert.deepEqual(parseCommand("/help"), { type: "help" });
  assert.deepEqual(parseCommand("/agents"), { type: "agents" });
  assert.deepEqual(parseCommand("/roles @gaia"), { type: "roles", agent: "gaia" });
  assert.deepEqual(parseCommand("/role brainstorm"), { type: "role", role: "brainstorm" });
  assert.deepEqual(parseCommand("/role gaia brainstorm"), { type: "role", agent: "gaia", role: "brainstorm" });
  assert.deepEqual(parseCommand("/summon terry fix the tests"), { type: "summon", agent: "terry", task: "fix the tests" });
  assert.deepEqual(parseCommand("/thinking high"), { type: "thinking", level: "high" });
  assert.deepEqual(parseCommand("/thinking @gaia off"), { type: "thinking", agent: "gaia", level: "off" });
  assert.deepEqual(parseCommand("/clear"), { type: "clear" });
  assert.deepEqual(parseCommand("/fork"), { type: "fork" });
  assert.deepEqual(parseCommand("/setup"), { type: "setup", sub: "list" });
  assert.deepEqual(parseCommand("/setup activate monad room2"), { type: "setup", sub: "activate", id: "monad", room: "room2" });
  assert.deepEqual(parseCommand("/setup off"), { type: "setup", sub: "off" });
  assert.deepEqual(parseCommand("/wat"), { type: "unknown", command: "wat" });
});

test("planMentionRoute: dedupes mentions, keeps order, falls back to default", () => {
  const agents = ["gaia", "terry", "sidia"];
  assert.deepEqual(planMentionRoute("hello", agents, "gaia"), { ok: true, targets: ["gaia"] });
  assert.deepEqual(planMentionRoute("@terry then @sidia and @terry again", agents, "gaia"), { ok: true, targets: ["terry", "sidia"] });
  assert.deepEqual(planMentionRoute("@nope hello", agents, "gaia"), { ok: false, unknown: ["nope"] });
  // Case-insensitive matching.
  assert.deepEqual(planMentionRoute("@Terry hi", agents, "gaia"), { ok: true, targets: ["terry"] });
});

test("hasExplicitMention: only known agents count", () => {
  const agents = new Set(["gaia"]);
  assert.equal(hasExplicitMention("ping @gaia", agents), true);
  assert.equal(hasExplicitMention("email bob@gaia.dev", agents), true); // v1 parity: bare pattern match
  assert.equal(hasExplicitMention("ping @unknown", agents), false);
  assert.equal(hasExplicitMention("no mentions", agents), false);
});
