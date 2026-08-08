import test from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import type { GaiaController } from "../src/app/gaia-controller.ts";
import { GaiaController as GaiaControllerClass } from "../src/app/gaia-controller.ts";
import { SummonCoordinator } from "../src/app/summon-coordinator.ts";
import { defaultRoomState } from "../src/room/state.ts";
import type { RoomStore } from "../src/room/store.ts";
import type { RoomLifecycle, RoomRecord } from "../src/workspace/room-lifecycle.ts";
import { initWorkspace, loadWorkspace } from "../src/workspace/workspace-loader.ts";
import { createTempDir } from "./helpers/temp.ts";

class FakeLifecycle implements RoomLifecycle {
  readonly roomsDir = "fake://rooms";
  readonly ensured: string[] = [];
  readonly opened: string[] = [];
  readonly listed: Array<string | undefined> = [];
  private readonly stores = new Map<string, RoomStore>();

  roomPath(roomId: string): string {
    return `fake://rooms/${roomId}`;
  }

  exists(): boolean {
    return false;
  }

  async list(currentRoomId?: string): Promise<RoomRecord[]> {
    this.listed.push(currentRoomId);
    return [{ id: "fake-room", path: this.roomPath("fake-room") }];
  }

  open(roomId: string): RoomStore {
    this.opened.push(roomId);
    let store = this.stores.get(roomId);
    if (!store) {
      let state = defaultRoomState();
      store = {
        dir: this.roomPath(roomId),
        transcriptPath: `${this.roomPath(roomId)}/transcript.jsonl`,
        statePath: `${this.roomPath(roomId)}/state.json`,
        async initialize() {},
        async clearTranscript() {},
        async copyTranscriptTo() {},
        async appendEvent() {},
        async hasEvent() { return false; },
        async recentEvents() { return []; },
        async eventsAfterCursor(cursor) { return { events: [], nextCursor: cursor }; },
        async readState() { return structuredClone(state); },
        async stateCompatibility() { return { writable: true, unsupportedFields: [] }; },
        async writeState(next) { state = structuredClone(next); },
        async updateState(mutate) {
          const working = structuredClone(state);
          state = structuredClone((await mutate(working)) ?? working);
          return structuredClone(state);
        },
      };
      this.stores.set(roomId, store);
    }
    return store;
  }

  async ensure(roomId: string): Promise<RoomStore> {
    this.ensured.push(roomId);
    return this.open(roomId);
  }

  async reserveFork(base: string) {
    const id = `${base}-fake-fork`;
    return { id, store: await this.ensure(id) };
  }
}

async function withWorkspace<T>(run: (workspace: Awaited<ReturnType<typeof loadWorkspace>>) => Promise<T>): Promise<T> {
  const temp = await createTempDir();
  try {
    await initWorkspace(temp.path);
    return await run(await loadWorkspace(temp.path));
  } finally {
    await temp.cleanup();
  }
}

test("GaiaController lists rooms through the workspace room composition", async () => {
  await withWorkspace(async (workspace) => {
    const lifecycle = new FakeLifecycle();
    const controller = new GaiaControllerClass({
      workspaceId: "workspace",
      workspace: { ...workspace, rooms: lifecycle },
    });

    assert.deepEqual(await controller.listRooms(), [{ id: "fake-room", path: "fake://rooms/fake-room", isCurrent: false }]);
    assert.deepEqual(lifecycle.listed, [workspace.config.room]);
  });
});

test("GaiaController mutations preserve state committed after controller initialization", async () => {
  await withWorkspace(async (workspace) => {
    const lifecycle = new FakeLifecycle();
    const roomId = workspace.config.room;
    const controller = new GaiaControllerClass({
      workspaceId: "workspace",
      workspace: { ...workspace, rooms: lifecycle },
    });
    await controller.init();

    const store = lifecycle.open(roomId);
    await store.updateState((state) => {
      state.activeRoles.gaia = "plan";
      state.activeRoles.sidia = "review";
      state.agentCursors.gaia = 17;
      state.runtimeDetails.evt_external = { model: "external/model" };
      state.parentRoomId = "parent-room";
    });

    assert.equal(await controller.setRole("gaia", "none"), "Cleared role for @gaia.");
    const committed = await store.readState();
    assert.deepEqual(committed.activeRoles, { sidia: "review" });
    assert.equal(committed.agentCursors.gaia, 17);
    assert.deepEqual(committed.runtimeDetails.evt_external, { model: "external/model" });
    assert.equal(committed.parentRoomId, "parent-room");
    controller.dispose();
  });
});

test("SummonCoordinator creates child rooms through the workspace composition, not the v1 layout", async () => {
  await withWorkspace(async (workspace) => {
    const lifecycle = new FakeLifecycle();
    const roomsBefore = (await readdir(workspace.roomsDir)).sort();
    const controllerForRoom = async () => ({
      async sendMessage() {},
      async waitForIdle() {},
      async latestReplyFrom() { return "fake child reply"; },
    } as unknown as GaiaController);
    const coordinator = new SummonCoordinator({ ...workspace, rooms: lifecycle }, controllerForRoom, 8);

    assert.equal(await coordinator.summonAndWait("default", workspace.config.defaultAgent, "spec task"), "fake child reply");
    assert.equal(lifecycle.ensured.length, 1);
    assert.deepEqual((await readdir(workspace.roomsDir)).sort(), roomsBefore);
  });
});

test("v1 defaults remain in force for a normally loaded workspace", async () => {
  await withWorkspace(async (workspace) => {
    const controller = new GaiaControllerClass({ workspaceId: "workspace", workspace });
    assert.ok((await controller.listRooms()).some((room) => room.id === workspace.config.room));

    const controllerForRoom = async () => ({
      async sendMessage() {},
      async waitForIdle() {},
      async latestReplyFrom() { return "v1 child reply"; },
    } as unknown as GaiaController);
    const coordinator = new SummonCoordinator(workspace, controllerForRoom, 8);
    assert.equal(await coordinator.summonAndWait("default", workspace.config.defaultAgent, "v1 task"), "v1 child reply");
    assert.ok((await readdir(workspace.roomsDir)).length > 1);
  });
});
