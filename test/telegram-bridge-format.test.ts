import test from "node:test";
import assert from "node:assert/strict";
import {
  TELEGRAM_MAX_MESSAGE_LEN,
  formatOutgoingForTelegram,
  nextOffset,
  parseTelegramUpdate,
  splitForTelegram,
} from "../src/services/telegram-bridge-format.js";

test("parseTelegramUpdate: a real text message parses", () => {
  const update = {
    update_id: 42,
    message: { chat: { id: -1001 }, text: "hello gaia", from: { username: "pascal", id: 7 } },
  };
  assert.deepEqual(parseTelegramUpdate(update), { chatId: -1001, text: "hello gaia", fromLabel: "pascal", updateId: 42 });
});

test("parseTelegramUpdate: falls back to first+last name, then numeric id", () => {
  const noUsername = {
    update_id: 1,
    message: { chat: { id: 5 }, text: "hi", from: { first_name: "Ada", last_name: "L.", id: 9 } },
  };
  assert.equal(parseTelegramUpdate(noUsername)?.fromLabel, "Ada L.");

  const anonymous = { update_id: 2, message: { chat: { id: 5 }, text: "hi", from: { id: 99 } } };
  assert.equal(parseTelegramUpdate(anonymous)?.fromLabel, "99");
});

test("parseTelegramUpdate: non-text / malformed updates are skipped, never throw", () => {
  assert.equal(parseTelegramUpdate(null), null);
  assert.equal(parseTelegramUpdate({}), null);
  assert.equal(parseTelegramUpdate({ update_id: 1 }), null); // no message (e.g. edited_message)
  assert.equal(parseTelegramUpdate({ update_id: 1, message: { chat: { id: 1 } } }), null); // no text (photo, sticker)
  assert.equal(parseTelegramUpdate({ update_id: 1, message: { chat: { id: 1 }, text: "   " } }), null); // whitespace-only
  assert.equal(parseTelegramUpdate({ update_id: "not-a-number", message: {} }), null);
});

test("nextOffset: one past the highest update_id seen", () => {
  assert.equal(nextOffset([{ update_id: 5 }, { update_id: 9 }, { update_id: 7 }], 1), 10);
});

test("nextOffset: no updates leaves the offset unchanged", () => {
  assert.equal(nextOffset([], 12), 12);
});

test("formatOutgoingForTelegram: agent reply formats with an @author prefix", () => {
  assert.equal(formatOutgoingForTelegram({ author: "gaia", text: "hi there" }, "u_bridge"), "[@gaia] hi there");
});

test("formatOutgoingForTelegram: human/system/redacted/empty/self-loop all skip", () => {
  assert.equal(formatOutgoingForTelegram({ author: "user", text: "hello" }, "u_bridge"), null);
  assert.equal(formatOutgoingForTelegram({ author: "system", text: "compacted" }, "u_bridge"), null);
  assert.equal(formatOutgoingForTelegram({ author: "gaia", text: "hi", redacted: true }, "u_bridge"), null);
  assert.equal(formatOutgoingForTelegram({ author: "gaia", text: "   " }, "u_bridge"), null);
  assert.equal(formatOutgoingForTelegram({ author: "gaia", text: "hi", humanId: "u_bridge" }, "u_bridge"), null);
});

test("splitForTelegram: short text passes through as one chunk", () => {
  assert.deepEqual(splitForTelegram("hello"), ["hello"]);
});

test("splitForTelegram: long text splits on a line boundary, never exceeds the cap, and reassembles losslessly", () => {
  const line = "x".repeat(100);
  const text = Array.from({ length: 100 }, () => line).join("\n"); // ~10100 chars, well over the cap
  const chunks = splitForTelegram(text, TELEGRAM_MAX_MESSAGE_LEN);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= TELEGRAM_MAX_MESSAGE_LEN);
  assert.equal(chunks.join("\n"), text);
});

test("splitForTelegram: no line breaks at all still hard-cuts at the cap (never returns an oversized chunk)", () => {
  const text = "x".repeat(9000);
  const chunks = splitForTelegram(text, TELEGRAM_MAX_MESSAGE_LEN);
  for (const chunk of chunks) assert.ok(chunk.length <= TELEGRAM_MAX_MESSAGE_LEN);
  assert.equal(chunks.join(""), text);
});
