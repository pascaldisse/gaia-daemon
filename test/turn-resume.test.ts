// No progress is ever lost: an agent turn interrupted mid-stream (daemon crash /
// abrupt teardown) leaves a durable pendingTurn carrying the partial reply, and a
// fresh controller for the same room resumes it — preserving the partial AND
// continuing the turn to completion. See memory: no-progress-lost.

import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { AgentDefinition } from "../src/agents/types.ts";
import { GaiaController } from "../src/app/gaia-controller.ts";
import type { AgentRuntime } from "../src/runtime/types.ts";
import { readRoomState, roomStatePath } from "../src/room/state.ts";
import { initWorkspace, loadWorkspace } from "../src/workspace/workspace-loader.ts";
import { createTempDir } from "./helpers/temp.ts";

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("waitFor timed out");
}

// Streams one partial delta, then hangs forever — stands in for a turn that the
// daemon was killed during (it never settles, never clears the pendingTurn).
class HangingRuntime implements AgentRuntime {
  readonly modelLabel = "fake/model";
  readonly capabilities = { gaiaTools: [], granularTools: true };
  constructor(readonly agent: AgentDefinition) {}
  resetRoom(): void {}
  async *send(): AsyncGenerator<never> {
    yield { type: "text-delta", delta: "partial progress so far" } as never;
    await new Promise(() => {}); // never resolves — interruption mid-turn
  }
  async abort(): Promise<void> {}
  dispose(): void {}
}

// Streams one partial delta, then waits — abort() ends the stream (as real
// harnesses do), so the turn settles as cancelled with the partial in hand.
class AbortableRuntime implements AgentRuntime {
  readonly modelLabel = "fake/model";
  readonly capabilities = { gaiaTools: [], granularTools: true };
  private end?: () => void;
  constructor(readonly agent: AgentDefinition) {}
  resetRoom(): void {}
  async *send(): AsyncGenerator<never> {
    yield { type: "text-delta", delta: "partial progress so far" } as never;
    await new Promise<void>((resolve) => (this.end = resolve));
  }
  async abort(): Promise<void> {
    this.end?.();
  }
  dispose(): void {
    this.end?.();
  }
}

// Streams a full reply — the fresh process that picks the interrupted turn back up.
class CompletingRuntime implements AgentRuntime {
  readonly modelLabel = "fake/model";
  readonly capabilities = { gaiaTools: [], granularTools: true };
  constructor(readonly agent: AgentDefinition) {}
  resetRoom(): void {}
  async *send(): AsyncGenerator<never> {
    yield { type: "text-delta", delta: "resumed and finished" } as never;
  }
  async abort(): Promise<void> {}
  dispose(): void {}
}

test("an interrupted turn persists its partial reply and resumes to completion — no progress lost", async () => {
  const temp = await createTempDir();
  const originalHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");
  try {
    await initWorkspace(temp.path);
    const workspace = await loadWorkspace(temp.path);

    // Phase 1 — a turn streams a partial, then the process is "killed" (dispose,
    // never settled). The partial must be durably on disk as a resumable pendingTurn.
    const c1 = new GaiaController({ cwd: temp.path, workspaceId: "workspace", workspace, runtimeFactory: (a) => new HangingRuntime(a) });
    const roomId = c1.roomId;
    const statePath = roomStatePath(workspace.roomsDir, roomId);
    await c1.sendMessage("do the thing", { targets: ["gaia"] });

    await waitFor(async () => {
      const s = await readRoomState(statePath);
      return Boolean(s.pendingTurn?.partialReply.includes("partial progress so far"));
    });
    const interrupted = await readRoomState(statePath);
    assert.equal(interrupted.pendingTurn?.agentId, "gaia");
    assert.ok(interrupted.pendingTurn?.targets.includes("gaia"), "the unfinished agent stays in targets for resume");
    assert.equal(interrupted.pendingTurn?.prompt, "do the thing");
    c1.dispose(); // abrupt teardown — no settle, like a crash

    // Phase 2 — a fresh controller for the SAME room. init() detects the pendingTurn
    // and resumes: the partial is preserved AND the turn runs to completion.
    const c2 = new GaiaController({ cwd: temp.path, workspaceId: "workspace", workspace, runtimeFactory: (a) => new CompletingRuntime(a) });
    await c2.init();

    await waitFor(async () => !(await readRoomState(statePath)).pendingTurn);
    const snap = await c2.getSnapshot();
    const texts = snap.room.events.map((e) => e.text ?? "");

    assert.ok(texts.some((t) => t.includes("partial progress so far")), "the partial reply was preserved, not discarded");
    assert.ok(texts.some((t) => t.includes("resumed and finished")), "the interrupted turn continued to completion");
    assert.equal((await readRoomState(statePath)).pendingTurn, undefined, "the pendingTurn marker is cleared once resumed");
    // The user prompt is on disk exactly once (resume must not re-record it).
    assert.equal(texts.filter((t) => t === "do the thing").length, 1, "the user prompt is not duplicated on resume");
    c2.dispose();
  } finally {
    if (originalHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = originalHome;
    await temp.cleanup();
  }
});

test("a cancelled turn preserves whatever streamed instead of discarding it", async () => {
  const temp = await createTempDir();
  const originalHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(temp.path, "home");
  try {
    await initWorkspace(temp.path);
    const workspace = await loadWorkspace(temp.path);

    const c = new GaiaController({ cwd: temp.path, workspaceId: "workspace", workspace, runtimeFactory: (a) => new AbortableRuntime(a) });
    const statePath = roomStatePath(workspace.roomsDir, c.roomId);
    await c.sendMessage("work on it", { targets: ["gaia"] });
    await waitFor(async () => Boolean((await readRoomState(statePath)).pendingTurn?.partialReply));

    await c.cancelActiveTask();

    // The streamed partial is appended to the transcript (preserved) and the
    // marker is cleared (a deliberate stop is not a resume).
    await waitFor(async () => !(await readRoomState(statePath)).pendingTurn);
    const snap = await c.getSnapshot();
    assert.ok(snap.room.events.some((e) => (e.text ?? "").includes("partial progress so far")), "cancel preserved the partial reply");
    c.dispose();
  } finally {
    if (originalHome === undefined) delete process.env.GAIA_HOME;
    else process.env.GAIA_HOME = originalHome;
    await temp.cleanup();
  }
});
