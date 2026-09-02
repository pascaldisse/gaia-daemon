// Archtree model + layout are pure functions; this is their headless contract.
import { describe, expect, test } from "bun:test";
// @ts-expect-error web client is plain JS with JSDoc types
import { buildModel, nodeLabel, roomStatus } from "../web/src/archtree/model.js";
// @ts-expect-error web client is plain JS with JSDoc types
import { layoutTree, jitterOf } from "../web/src/archtree/layout.js";
// @ts-expect-error web client is plain JS with JSDoc types
import { DEFAULT_PARAMS, resolveParams } from "../web/src/archtree/params.js";

const NOW = 1_800_000_000_000;

describe("archtree params", () => {
  test("defaults resolve unchanged without overrides", () => {
    expect(resolveParams(undefined)).toEqual(DEFAULT_PARAMS);
  });

  test("override applies, wrong type and non-finite are ignored", () => {
    const params = resolveParams({ witherMs: 1000, freshMs: "nope" as never, levelHeight: Number.NaN });
    expect(params.witherMs).toBe(1000);
    expect(params.freshMs).toBe(DEFAULT_PARAMS.freshMs);
    expect(params.levelHeight).toBe(DEFAULT_PARAMS.levelHeight);
  });
});

describe("roomStatus", () => {
  test("running beats every age", () => {
    expect(roomStatus({ id: "a", running: true, lastActivity: 0 }, NOW, DEFAULT_PARAMS)).toBe("active");
  });
  test("fresh finish = done, ancient = dead, in between = idle", () => {
    expect(roomStatus({ id: "a", lastActivity: NOW - 1000 }, NOW, DEFAULT_PARAMS)).toBe("done");
    expect(roomStatus({ id: "a", lastActivity: NOW - DEFAULT_PARAMS.witherMs }, NOW, DEFAULT_PARAMS)).toBe("dead");
    expect(roomStatus({ id: "a", lastActivity: NOW - DEFAULT_PARAMS.freshMs - 1 }, NOW, DEFAULT_PARAMS)).toBe("idle");
    expect(roomStatus({ id: "a" }, NOW, DEFAULT_PARAMS)).toBe("idle");
  });

  test("inclusive age boundaries assign fresh to done and withered to dead", () => {
    // Current semantics deliberately use <= freshMs and >= witherMs; only the
    // interval strictly between them is idle. The boundaries are asymmetric only
    // in their direction, not their inclusion.
    expect(roomStatus({ id: "fresh", lastActivity: NOW - DEFAULT_PARAMS.freshMs }, NOW, DEFAULT_PARAMS)).toBe("done");
    expect(roomStatus({ id: "withered", lastActivity: NOW - DEFAULT_PARAMS.witherMs }, NOW, DEFAULT_PARAMS)).toBe("dead");
  });

  test("custom thresholds apply to direct status derivation", () => {
    const params = resolveParams({ freshMs: 10, witherMs: 20 });
    expect(roomStatus({ id: "fresh", lastActivity: NOW - 10 }, NOW, params)).toBe("done");
    expect(roomStatus({ id: "middle", lastActivity: NOW - 11 }, NOW, params)).toBe("idle");
    expect(roomStatus({ id: "withered", lastActivity: NOW - 20 }, NOW, params)).toBe("dead");
  });
});

describe("nodeLabel", () => {
  test("title wins, then path tail with summon suffix stripped", () => {
    expect(nodeLabel({ id: "x", title: "root" })).toBe("root");
    expect(nodeLabel({ id: "naru-opus-mtebutxfryxi4i" })).toBe("naru-opus");
    expect(nodeLabel({ id: "x", path: "/w/rooms/naru-kimi-mtebor8yhaf1bj" })).toBe("naru-kimi");
    expect(nodeLabel({ id: "short" })).toBe("short");
  });
});

describe("buildModel", () => {
  const rooms = [
    { id: "root", lastActivity: 1 },
    { id: "kid-a", parentRoomId: "root", running: true, lastActivity: 2 },
    { id: "kid-b", parentRoomId: "root", lastActivity: 3 },
    { id: "grand", parentRoomId: "kid-a", lastActivity: 4 },
    { id: "orphan", parentRoomId: "missing", lastActivity: 5 },
  ];

  test("edges follow parentRoomId, orphans become roots", () => {
    const model = buildModel(rooms, { now: NOW });
    expect(model.nodes.length).toBe(5);
    expect(model.edges).toEqual([
      { from: "root", to: "kid-a" },
      { from: "kid-a", to: "grand" },
      { from: "root", to: "kid-b" },
    ]);
    expect(model.nodes.find((n: { id: string }) => n.id === "orphan")?.parentId).toBe(null);
    expect(model.maxDepth).toBe(2);
    expect(model.anyActive).toBe(true);
  });

  test("descendant counts roll up transitively", () => {
    const model = buildModel(rooms, { now: NOW });
    const byId = new Map(model.nodes.map((n: { id: string }) => [n.id, n]));
    expect(byId.get("root")?.descendants).toBe(3);
    expect(byId.get("kid-a")?.descendants).toBe(1);
    expect(byId.get("grand")?.descendants).toBe(0);
  });

  test("parents always precede children (topological order)", () => {
    const model = buildModel(rooms, { now: NOW });
    const seen = new Set<string>();
    for (const node of model.nodes) {
      if (node.parentId) expect(seen.has(node.parentId)).toBe(true);
      seen.add(node.id);
    }
  });

  test("a parent cycle degrades to roots instead of hanging", () => {
    const model = buildModel([
      { id: "a", parentRoomId: "b" },
      { id: "b", parentRoomId: "a" },
    ], { now: NOW });
    expect(model.nodes.length).toBe(2);
    expect(model.edges.length).toBe(0);
  });

  test("self-parent is not an edge", () => {
    const model = buildModel([{ id: "a", parentRoomId: "a" }], { now: NOW });
    expect(model.edges.length).toBe(0);
  });

  test("empty room list yields an empty model", () => {
    const model = buildModel([], { now: NOW });
    expect(model.nodes).toEqual([]);
    expect(model.anyActive).toBe(false);
  });

  test("custom thresholds propagate through buildModel", () => {
    const model = buildModel([
      { id: "fresh", lastActivity: NOW - 10 },
      { id: "middle", lastActivity: NOW - 11 },
      { id: "withered", lastActivity: NOW - 20 },
    ], { now: NOW, params: { freshMs: 10, witherMs: 20 } });
    expect(Object.fromEntries(model.nodes.map((node: { id: string, status: string }) => [node.id, node.status]))).toEqual({
      fresh: "done", middle: "idle", withered: "dead",
    });
  });

  test("propagates every room status onto its node", () => {
    const model = buildModel([
      { id: "active", running: true, lastActivity: 0 },
      { id: "done", lastActivity: NOW - 1 },
      { id: "dead", lastActivity: NOW - DEFAULT_PARAMS.witherMs },
      { id: "idle", lastActivity: 0 },
    ], { now: NOW });
    expect(Object.fromEntries(model.nodes.map((node: { id: string, status: string }) => [node.id, node.status]))).toEqual({
      active: "active", done: "done", dead: "dead", idle: "idle",
    });
  });
});

describe("layoutTree", () => {
  const rooms = [
    { id: "root", lastActivity: 1 },
    { id: "kid-a", parentRoomId: "root", lastActivity: 2 },
    { id: "kid-b", parentRoomId: "root", lastActivity: 3 },
    { id: "grand", parentRoomId: "kid-a", lastActivity: 4 },
  ];

  test("deterministic: identical input gives identical points", () => {
    const a = layoutTree(buildModel(rooms, { now: NOW }));
    const b = layoutTree(buildModel(rooms, { now: NOW }));
    for (const [id, point] of a.points) expect(b.points.get(id)).toEqual(point);
  });

  test("depth raises height, every node has a segment", () => {
    const model = buildModel(rooms, { now: NOW });
    const layout = layoutTree(model);
    expect(layout.points.get("grand")!.y).toBeGreaterThan(layout.points.get("kid-a")!.y);
    expect(layout.segments.length).toBe(model.nodes.length);
    expect(Number.isFinite(layout.radius)).toBe(true);
  });

  test("renderer half scales mirror every layout point exactly on Y", () => {
    const model = buildModel(rooms, { now: NOW });
    const layout = layoutTree(model);
    // buildGeometry reads these layout coordinates unchanged; renderer.js applies
    // +1 for light and -params.shadowMirror for shadow in the vertex shader.
    // Default shadowMirror is 1, therefore the two rendered halves must be an
    // exact Y reflection while preserving X and Z.
    for (const point of layout.points.values()) {
      const light = { x: point.x, y: point.y, z: point.z };
      const shadow = { x: point.x, y: point.y * -model.params.shadowMirror, z: point.z };
      expect(shadow).toEqual({ x: light.x, y: -light.y, z: light.z });
    }
  });

  test("siblings fan apart", () => {
    const layout = layoutTree(buildModel(rooms, { now: NOW }));
    const a = layout.points.get("kid-a")!;
    const b = layout.points.get("kid-b")!;
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(0.1);
  });

  test("branch thickness grows with descendants", () => {
    const layout = layoutTree(buildModel(rooms, { now: NOW }));
    expect(layout.points.get("root")!.thickness).toBeGreaterThan(layout.points.get("grand")!.thickness);
  });

  test("jitterOf is stable and bounded", () => {
    expect(jitterOf("abc")).toBe(jitterOf("abc"));
    expect(Math.abs(jitterOf("abc"))).toBeLessThanOrEqual(1);
    expect(jitterOf("abc")).not.toBe(jitterOf("abd"));
  });
});
