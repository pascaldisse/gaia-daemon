import test from "node:test";
import assert from "node:assert/strict";
import { parseCommand } from "../src/app/commands.ts";

test("parses plain input as a message", () => {
  assert.deepEqual(parseCommand("hello Gaia"), { type: "message", text: "hello Gaia" });
});

test("parses known slash commands", () => {
  assert.deepEqual(parseCommand("/help"), { type: "help" });
  assert.deepEqual(parseCommand("/agents"), { type: "agents" });
});

test("parses role slash commands with arguments", () => {
  assert.deepEqual(parseCommand("/roles gaia"), { type: "roles", agent: "gaia" });
  assert.deepEqual(parseCommand("/role gaia brainstorm"), { type: "role", agent: "gaia", role: "brainstorm" });
  assert.deepEqual(parseCommand("/role gaia none"), { type: "role", agent: "gaia", role: "none" });
});

test("reports unknown slash commands", () => {
  assert.deepEqual(parseCommand("/dance now"), { type: "unknown", command: "dance" });
});
