// The uniform per-room session store (claude sessionId / codex threadId). The
// key is (agent, harness), not just harness, so two agents of the SAME harness
// in one room never share a conversation — with a one-time legacy fallback so
// rooms written before agent-scoping keep their session instead of losing
// pre-cursor history on upgrade.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileSessionStore, SessionMap } from "../src/harness/sessions.js";
import { workspacePaths } from "../src/core/paths.js";

test("SessionMap.systemPrompt assembles once and returns the cached snapshot", async () => {
  const sessions = new SessionMap<string>();
  let assemblies = 0;
  const assemble = async () => `prompt-${++assemblies}`;

  assert.equal(await sessions.systemPrompt("room", "role", assemble), "prompt-1");
  assert.equal(await sessions.systemPrompt("room", "role", assemble), "prompt-1");
  assert.equal(assemblies, 1);
});

test("SessionMap.refreshPrompt forces system-prompt re-assembly", async () => {
  const sessions = new SessionMap<string>();
  let assemblies = 0;
  const assemble = async () => `prompt-${++assemblies}`;

  await sessions.systemPrompt("room", "role", assemble);
  sessions.refreshPrompt("room");
  assert.equal(await sessions.systemPrompt("room", "role", assemble), "prompt-2");
  assert.equal(assemblies, 2);
});

test("SessionMap.reset forces system-prompt re-assembly", async () => {
  const sessions = new SessionMap<string>();
  let assemblies = 0;
  const assemble = async () => `prompt-${++assemblies}`;

  await sessions.systemPrompt("room", "role", assemble);
  sessions.reset("room");
  assert.equal(await sessions.systemPrompt("room", "role", assemble), "prompt-2");
  assert.equal(assemblies, 2);
});

test("SessionMap.systemPrompt re-assembles for a different role key", async () => {
  const sessions = new SessionMap<string>();
  let assemblies = 0;
  const assemble = async () => `prompt-${++assemblies}`;

  assert.equal(await sessions.systemPrompt("room", "role-a", assemble), "prompt-1");
  assert.equal(await sessions.systemPrompt("room", "role-b", assemble), "prompt-2");
  assert.equal(assemblies, 2);
});

test("fileSessionStore: two same-harness agents in one room keep separate sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-sess-"));
  const ari = fileSessionStore<string>(root, "claude", "ari");
  const nyari = fileSessionStore<string>(root, "claude", "nyari");

  ari.save("room1", "session-ari");
  nyari.save("room1", "session-nyari"); // same room, same harness — must NOT clobber

  assert.equal(ari.load("room1"), "session-ari");
  assert.equal(nyari.load("room1"), "session-nyari");
  // A codex agent in the same room is independent too (different harness key).
  const codexAri = fileSessionStore<string>(root, "codex", "ari");
  assert.equal(codexAri.load("room1"), undefined);
  // And a different room shares nothing.
  assert.equal(ari.load("room2"), undefined);
});

test("fileSessionStore: legacy bare-harness entry is recovered once, then migrated", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-sess-"));
  const roomDir = workspacePaths.roomDir(root, "old");
  const file = join(roomDir, "harness-sessions.json");
  await mkdir(roomDir, { recursive: true });
  await writeFile(file, JSON.stringify({ claude: "legacy-session" })); // pre-agent-scoping shape

  const ari = fileSessionStore<string>(root, "claude", "ari");
  // First load recovers the legacy session — no history lost across the upgrade.
  assert.equal(ari.load("old"), "legacy-session");

  // Saving migrates it to the agent-scoped key and drops the ambiguous bare key.
  ari.save("old", "legacy-session");
  const after = JSON.parse(await readFile(file, "utf8")) as Record<string, string>;
  assert.equal(after["claude:ari"], "legacy-session");
  assert.equal("claude" in after, false);

  // A second same-harness agent added later does NOT inherit the (now-gone)
  // legacy key — it starts its own fresh conversation.
  const nyari = fileSessionStore<string>(root, "claude", "nyari");
  assert.equal(nyari.load("old"), undefined);
});

test("fileSessionStore: clear removes the agent-scoped and legacy keys, leaves other agents", async () => {
  const root = await mkdtemp(join(tmpdir(), "gaia-sess-"));
  const ari = fileSessionStore<string>(root, "claude", "ari");
  const nyari = fileSessionStore<string>(root, "claude", "nyari");
  ari.save("room1", "session-ari");
  nyari.save("room1", "session-nyari");

  ari.clear("room1");
  assert.equal(ari.load("room1"), undefined);
  assert.equal(nyari.load("room1"), "session-nyari"); // untouched
});
