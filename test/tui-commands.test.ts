import test from "node:test";
import assert from "node:assert/strict";
import { parseCommand } from "../src/tui/commands.ts";

test("parses plain input as a message", () => {
  assert.deepEqual(parseCommand("hello Gaia"), { type: "message", text: "hello Gaia" });
});

test("parses known slash commands", () => {
  assert.deepEqual(parseCommand("/help"), { type: "help" });
  assert.deepEqual(parseCommand("/agents"), { type: "agents" });
  assert.deepEqual(parseCommand("/quit"), { type: "quit" });
  assert.deepEqual(parseCommand("/exit"), { type: "quit" });
});

test("reports unknown slash commands", () => {
  assert.deepEqual(parseCommand("/dance now"), { type: "unknown", command: "dance" });
});
