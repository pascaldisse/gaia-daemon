import test from "node:test";
import assert from "node:assert/strict";
import { hasExplicitMention, parseCommand, planMentionRoute } from "../src/services/commands.js";

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
  assert.deepEqual(parseCommand("/refresh"), { type: "refresh" });
  assert.deepEqual(parseCommand("/fork"), { type: "fork" });
  assert.deepEqual(parseCommand("/setup"), { type: "setup", sub: "list" });
  assert.deepEqual(parseCommand("/setup activate monad room2"), { type: "setup", sub: "activate", id: "monad", room: "room2" });
  assert.deepEqual(parseCommand("/setup off"), { type: "setup", sub: "off" });
  assert.deepEqual(parseCommand("/cancel"), { type: "cancel" });
  assert.deepEqual(parseCommand("/stop"), { type: "cancel" }); // alias
  assert.deepEqual(parseCommand("/compact"), { type: "compact", agent: undefined });
  assert.deepEqual(parseCommand("/compact @nyari"), { type: "compact", agent: "nyari" });
  assert.deepEqual(parseCommand("/model opus"), { type: "model", spec: "opus" });
  assert.deepEqual(parseCommand("/model @nyari anthropic/opus"), { type: "model", agent: "nyari", spec: "anthropic/opus" });
  assert.deepEqual(parseCommand("/pet @nyari nari"), { type: "pet", action: "set", agent: "nyari", package: "nari" });
  assert.deepEqual(parseCommand("/pet gaia"), { type: "pet", action: "set", agent: undefined, package: "gaia" });
  assert.deepEqual(parseCommand("/pet off @nyari"), { type: "pet", action: "off", agent: "nyari" });
  assert.deepEqual(parseCommand("/pet off"), { type: "pet", action: "off", agent: undefined });
  assert.deepEqual(parseCommand("/pet list"), { type: "pet", action: "list" });
  assert.deepEqual(parseCommand("/thanks-dario"), { type: "thanks-dario", sub: "run" });
  assert.deepEqual(parseCommand("/thanks-dario on"), { type: "thanks-dario", sub: "on" });
  assert.deepEqual(parseCommand("/thanks-dario off"), { type: "thanks-dario", sub: "off" });
  assert.deepEqual(parseCommand("/dario run"), { type: "thanks-dario", sub: "run" }); // alias
  assert.deepEqual(parseCommand("/recall the deploy incident"), { type: "recall", agent: undefined, query: "the deploy incident" });
  assert.deepEqual(parseCommand("/recall @terry lessons learned"), { type: "recall", agent: "terry", query: "lessons learned" });
  assert.deepEqual(parseCommand("/recall"), { type: "recall", agent: undefined, query: undefined });
  // A harness-native passthrough command (claude builtin) is "unknown" to the
  // parser — room-service forwards it only if the target agent CHECKED that
  // command name in its skills (no separate /native toggle anymore).
  assert.deepEqual(parseCommand("/deep-research the topic"), { type: "unknown", command: "deep-research" });
  assert.deepEqual(parseCommand("/wat"), { type: "unknown", command: "wat" });
});

test("parseCommand: a leading '/' that isn't command-shaped is a message, never a swallowed 'unknown'", () => {
  // The regression that ate a real message: a pasted absolute path starts with
  // "/" but is content, not a command. It MUST come back as a message.
  const path = "/Users/pascaldisse/Downloads/nyari-maid/nyari-maid-var01.png";
  assert.deepEqual(parseCommand(path), { type: "message", text: path });
  assert.deepEqual(parseCommand(`${path} here is your portrait`), { type: "message", text: `${path} here is your portrait` });
  // Code / regex / paths with spaces — all content, all delivered.
  assert.deepEqual(parseCommand("/^[A-Za-z]+$/ matches names"), { type: "message", text: "/^[A-Za-z]+$/ matches names" });
  assert.deepEqual(parseCommand("/etc/hosts needs editing"), { type: "message", text: "/etc/hosts needs editing" });
  assert.deepEqual(parseCommand("/usr/local/bin"), { type: "message", text: "/usr/local/bin" });
  // A bare command-shaped typo stays "unknown" so the user gets a corrective
  // hint (nothing is lost — one word, clearly a command attempt).
  assert.deepEqual(parseCommand("/halp"), { type: "unknown", command: "halp" });
});

test("planMentionRoute: leading mentions route (deduped, in order), else the default", () => {
  const agents = ["gaia", "terry", "sidia"];
  assert.deepEqual(planMentionRoute("hello", agents, "gaia"), { ok: true, targets: ["gaia"] });
  assert.deepEqual(planMentionRoute("@terry @sidia @terry compare", agents, "gaia"), { ok: true, targets: ["terry", "sidia"] });
  assert.deepEqual(planMentionRoute("@nope hello", agents, "gaia"), { ok: false, unknown: ["nope"] });
  // Case-insensitive matching; trailing , or : allowed on an address.
  assert.deepEqual(planMentionRoute("@Terry hi", agents, "gaia"), { ok: true, targets: ["terry"] });
  assert.deepEqual(planMentionRoute("@terry, look at this", agents, "gaia"), { ok: true, targets: ["terry"] });
  assert.deepEqual(planMentionRoute("  @terry: go", agents, "gaia"), { ok: true, targets: ["terry"] });
});

test("planMentionRoute: @ past the message head is prose — pastes never reroute or reject", () => {
  const agents = ["gaia", "terry"];
  // A mid-text KNOWN mention is a reference, not an address.
  assert.deepEqual(planMentionRoute("I think @terry said so", agents, "gaia"), { ok: true, targets: ["gaia"] });
  // Pasted content full of @: emails, npm scopes, decorators, handles.
  assert.deepEqual(planMentionRoute("mail pascal@icloud.com about it", agents, "gaia"), { ok: true, targets: ["gaia"] });
  assert.deepEqual(planMentionRoute("run npm i @earendil-works/pi-coding-agent", agents, "gaia"), { ok: true, targets: ["gaia"] });
  assert.deepEqual(planMentionRoute("code has @Override and @nope everywhere", agents, "gaia"), { ok: true, targets: ["gaia"] });
  // Even at the head, a token GLUED to more than [,:] is prose, not an address.
  assert.deepEqual(planMentionRoute("@earendil-works/pi is the sdk", agents, "gaia"), { ok: true, targets: ["gaia"] });
  assert.deepEqual(planMentionRoute("@terry.txt is the file", agents, "gaia"), { ok: true, targets: ["gaia"] });
  // The address run stops at the first prose token — no rejection after it.
  assert.deepEqual(planMentionRoute("@terry see @nope above", agents, "gaia"), { ok: true, targets: ["terry"] });
});

test("hasExplicitMention: leading known addresses only", () => {
  const agents = new Set(["gaia"]);
  assert.equal(hasExplicitMention("@gaia ping", agents), true);
  assert.equal(hasExplicitMention("ping @gaia", agents), false); // reference, not address
  assert.equal(hasExplicitMention("email bob@gaia.dev", agents), false); // pasted email must not count
  assert.equal(hasExplicitMention("@unknown ping", agents), false);
  assert.equal(hasExplicitMention("no mentions", agents), false);
});
