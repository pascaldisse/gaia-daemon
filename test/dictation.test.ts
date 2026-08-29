import { test, expect } from "bun:test";
import { DEFAULT_TRANSCRIBE_TIMEOUT_MS, transcriptionTimeoutMs } from "../web/src/dictation-timeout.js";

test("dictation client budget outlives the daemon STT deadline", () => {
  expect(DEFAULT_TRANSCRIBE_TIMEOUT_MS).toBeGreaterThan(120_000);
  expect(transcriptionTimeoutMs()).toBe(DEFAULT_TRANSCRIBE_TIMEOUT_MS);
});

test("dictation timeout accepts a caller override and rejects invalid values", () => {
  expect(transcriptionTimeoutMs(130_000)).toBe(130_000);
  expect(transcriptionTimeoutMs(0)).toBe(DEFAULT_TRANSCRIBE_TIMEOUT_MS);
  expect(transcriptionTimeoutMs(Number.NaN)).toBe(DEFAULT_TRANSCRIBE_TIMEOUT_MS);
});
