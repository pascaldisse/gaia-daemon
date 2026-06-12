import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CORE_MEMORY_FILE, MemoryStore, USER_MEMORY_FILE } from "../src/memory/memory-store.ts";
import { createTempDir } from "./helpers/temp.ts";

test("init seeds core and user memory files once", async () => {
  const temp = await createTempDir();
  try {
    const dir = join(temp.path, "memory");
    const store = new MemoryStore();
    await store.init(dir, "Gaia");

    assert.equal(await readFile(join(dir, CORE_MEMORY_FILE), "utf8"), "# Gaia Memory\n\n");
    assert.equal(await readFile(join(dir, USER_MEMORY_FILE), "utf8"), "# About the User\n\n");

    await store.mutate(dir, CORE_MEMORY_FILE, "add", { content: "custom note" });
    await store.init(dir, "Gaia");
    assert.match(await readFile(join(dir, CORE_MEMORY_FILE), "utf8"), /custom note/);
  } finally {
    await temp.cleanup();
  }
});

test("add, replace, and remove work per file", async () => {
  const temp = await createTempDir();
  try {
    const dir = join(temp.path, "memory");
    const store = new MemoryStore();
    await store.init(dir, "Gaia");

    const added = await store.mutate(dir, USER_MEMORY_FILE, "add", { content: "Prefers short answers" });
    assert.equal(added.ok, true);
    assert.match(added.state.content, /Prefers short answers/);
    assert.doesNotMatch((await store.readState(dir, CORE_MEMORY_FILE)).content, /Prefers short answers/);

    const replaced = await store.mutate(dir, USER_MEMORY_FILE, "replace", {
      oldText: "Prefers short answers",
      content: "Prefers detailed answers",
    });
    assert.equal(replaced.ok, true);
    assert.match(replaced.state.content, /Prefers detailed answers/);

    const removed = await store.mutate(dir, USER_MEMORY_FILE, "remove", { oldText: "Prefers detailed answers" });
    assert.equal(removed.ok, true);
    assert.doesNotMatch(removed.state.content, /Prefers detailed/);
  } finally {
    await temp.cleanup();
  }
});

test("add creates topic files on demand, including subdirectories", async () => {
  const temp = await createTempDir();
  try {
    const dir = join(temp.path, "memory");
    const store = new MemoryStore();
    await store.init(dir, "Gaia");

    const result = await store.mutate(dir, "agents/terry.md", "add", { content: "Terry tends to overengineer" });
    assert.equal(result.ok, true);
    assert.equal(existsSync(join(dir, "agents", "terry.md")), true);

    const files = await store.listFiles(dir);
    assert.deepEqual(
      files.map((info) => info.file),
      ["agents/terry.md", CORE_MEMORY_FILE, USER_MEMORY_FILE],
    );
  } finally {
    await temp.cleanup();
  }
});

test("memory file names cannot escape the memory dir", async () => {
  const temp = await createTempDir();
  try {
    const dir = join(temp.path, "memory");
    const store = new MemoryStore();
    await store.init(dir, "Gaia");

    await assert.rejects(() => store.readState(dir, "../SOUL.md"), /Invalid memory file name/);
    await assert.rejects(() => store.readState(dir, "/etc/notes.md"), /Invalid memory file name/);
    await assert.rejects(() => store.readState(dir, "notes.txt"), /Invalid memory file name/);
  } finally {
    await temp.cleanup();
  }
});

test("coding-topic words are storable but secret material is rejected", async () => {
  const temp = await createTempDir();
  try {
    const dir = join(temp.path, "memory");
    const store = new MemoryStore();
    await store.init(dir, "Gaia");

    const legit = await store.mutate(dir, CORE_MEMORY_FILE, "add", {
      content: "The auth flow uses a refresh token; print debugging via console.log is preferred; API keys live in .env",
    });
    assert.equal(legit.ok, true);

    for (const secret of [
      "remember this: sk-abcdefghijklmnopqrstuvwxyz123456",
      "aws key AKIAIOSFODNN7EXAMPLE",
      "-----BEGIN RSA PRIVATE KEY-----",
      "gh token ghp_abcdefghijklmnopqrstuvwxyz1234567890",
    ]) {
      const rejected = await store.mutate(dir, CORE_MEMORY_FILE, "add", { content: secret });
      assert.equal(rejected.ok, false, `should reject: ${secret}`);
      assert.match(rejected.message, /secret/);
    }
  } finally {
    await temp.cleanup();
  }
});

test("file limits reject oversized writes and nudge consolidation near capacity", async () => {
  const temp = await createTempDir();
  try {
    const dir = join(temp.path, "memory");
    const store = new MemoryStore();
    await store.init(dir, "Gaia");

    const oversized = await store.mutate(dir, USER_MEMORY_FILE, "add", { content: "x".repeat(3000) });
    assert.equal(oversized.ok, false);
    assert.match(oversized.message, /limit exceeded/);

    const nearCap = await store.mutate(dir, USER_MEMORY_FILE, "add", { content: "y".repeat(1700) });
    assert.equal(nearCap.ok, true);
    assert.match(nearCap.message, /capacity; consolidate/);
  } finally {
    await temp.cleanup();
  }
});

test("duplicate entries are skipped and replace requires a unique match", async () => {
  const temp = await createTempDir();
  try {
    const dir = join(temp.path, "memory");
    const store = new MemoryStore();
    await store.init(dir, "Gaia");

    await store.mutate(dir, CORE_MEMORY_FILE, "add", { content: "same note" });
    const duplicate = await store.mutate(dir, CORE_MEMORY_FILE, "add", { content: "same note" });
    assert.equal(duplicate.ok, true);
    assert.match(duplicate.message, /duplicate/);

    await store.mutate(dir, CORE_MEMORY_FILE, "add", { content: "same note twice" });
    const ambiguous = await store.mutate(dir, CORE_MEMORY_FILE, "replace", { oldText: "same note", content: "other" });
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.message, /matched 2/);
  } finally {
    await temp.cleanup();
  }
});

test("promptBlock renders core files with usage and lists topic files", async () => {
  const temp = await createTempDir();
  try {
    const dir = join(temp.path, "memory");
    const store = new MemoryStore();
    await store.init(dir, "Gaia");
    await store.mutate(dir, CORE_MEMORY_FILE, "add", { content: "core note" });
    await store.mutate(dir, "debugging.md", "add", { content: "topic note" });

    const block = await store.promptBlock(dir);
    assert.match(block, /## MEMORY\.md \(\d+% of 4000 chars\)/);
    assert.match(block, /core note/);
    assert.match(block, /## USER\.md \(\d+% of 2000 chars\)/);
    assert.match(block, /## Topic files \(read on demand with the memory tool\)\n\n- debugging\.md/);
    assert.doesNotMatch(block, /topic note/);
  } finally {
    await temp.cleanup();
  }
});
