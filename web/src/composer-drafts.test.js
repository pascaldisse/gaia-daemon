// @ts-nocheck — in-memory Storage double; Bun supplies the test runtime.
import { expect, test } from "bun:test";
import { clearComposerDraft, composerDraftKey, composerDraftStatus, loadComposerDraft, saveComposerDraft } from "./composer-drafts.js";

function memoryStorage() {
  const values = new Map();
  return /** @type {Storage} */ ({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  });
}

test("composer drafts save and restore independently per room", () => {
  const storage = memoryStorage();
  const first = composerDraftKey("workspace", "room-a");
  const second = composerDraftKey("workspace", "room-b");

  saveComposerDraft(storage, first, "first draft");
  saveComposerDraft(storage, second, "second draft");

  expect(loadComposerDraft(storage, first)).toBe("first draft");
  expect(loadComposerDraft(storage, second)).toBe("second draft");
  expect(composerDraftStatus(storage, first, "first draft")).toBe("draft saved");

  clearComposerDraft(storage, first);
  expect(loadComposerDraft(storage, first)).toBe("");
  expect(loadComposerDraft(storage, second)).toBe("second draft");
});

test("blank input removes the persisted draft", () => {
  const storage = memoryStorage();
  const key = composerDraftKey("workspace", "room");
  saveComposerDraft(storage, key, "draft");
  saveComposerDraft(storage, key, "   ");
  expect(loadComposerDraft(storage, key)).toBe("");
});
