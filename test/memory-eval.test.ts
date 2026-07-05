// `gaia memory eval` (src/services/memory-eval.ts) must measure the DEPLOYED
// retrieval pipeline — probe queries embed through the same config resolution
// as live recall. The regression here was real: the eval once searched
// lexical-only while live recall ran hybrid, silently grading the wrong system.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.GAIA_HOME = await mkdtemp(join(tmpdir(), "gaia-home-"));

const { workspacePaths } = await import("../src/core/paths.js");
const { initWorkspace } = await import("../src/domain/workspace.js");
const { openWorkspaceIndex, pendingEmbeddings, storeEmbeddings, syncWorkspaceIndex, workspaceRoomRefs } = await import(
  "../src/domain/workspace-index.js"
);
const { runMemoryEval } = await import("../src/services/memory-eval.js");

const TS = "2026-06-10T00:00:00.000Z";

/** A workspace whose one closed chunk is only reachable via the dense arm. */
async function makeEvalWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gaia-eval-"));
  await initWorkspace(root);

  const roomDir = join(root, ".gaia", "rooms", "topic");
  await mkdir(roomDir, { recursive: true });
  const text = `the targeting system picked the wrong building. ${"the aftermath dominated every debrief that month. ".repeat(13)}`;
  await writeFile(join(roomDir, "transcript.jsonl"), `${JSON.stringify({ id: "e0", timestamp: TS, author: "user", text })}\n`, "utf8");

  await mkdir(join(root, ".gaia", "memory"), { recursive: true });
  await writeFile(
    workspacePaths.memoryEval(root),
    JSON.stringify({
      // Zero token overlap with the chunk — only a queryVec can find it.
      probes: [{ id: "paraphrase", agent: "gaia", query: "completely unrelated wording without common tokens", expectRooms: ["topic"], k: 5 }],
    }),
    "utf8",
  );

  // Pre-embed the chunk so the dense arm has stored vectors to scan.
  const db = openWorkspaceIndex(root);
  try {
    await syncWorkspaceIndex(db, { rooms: workspaceRoomRefs(root), agents: [] });
    const pending = pendingEmbeddings(db);
    assert.ok(pending.length >= 1, "the room chunk should be pending embedding");
    storeEmbeddings(db, pending.map((row) => ({ hash: row.hash, vec: Float32Array.from([0, 0, 1]) })));
  } finally {
    db.close();
  }
  return root;
}

/** OpenAI-shape embeddings endpoint: every input lands on the chunk's vector. */
const fakeEmbedFetch: typeof fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body ?? "{}")) as { input?: string[] };
  const data = (body.input ?? []).map(() => ({ embedding: [0, 0, 1] }));
  return new Response(JSON.stringify({ data }), { status: 200, headers: { "content-type": "application/json" } });
};

test("eval runs the deployed pipeline: a zero-overlap paraphrase probe passes through the dense arm", async () => {
  const root = await makeEvalWorkspace();
  const report = await runMemoryEval(root, undefined, { fetchImpl: fakeEmbedFetch });
  assert.ok(report.text.includes("dense arm: local/"), `arm line missing:\n${report.text}`);
  assert.ok(report.ok, `paraphrase probe should pass via the dense arm:\n${report.text}`);
});

test("eval is loud when the dense arm is down: 'dense arm: OFF' + the probe honestly fails", async () => {
  const root = await makeEvalWorkspace();
  const deadFetch: typeof fetch = async () => {
    throw new Error("connection refused");
  };
  const report = await runMemoryEval(root, undefined, { fetchImpl: deadFetch });
  assert.ok(report.text.includes("dense arm: OFF"), `expected loud OFF line:\n${report.text}`);
  assert.equal(report.ok, false, "a dense-only probe cannot pass lexical-only");
});
