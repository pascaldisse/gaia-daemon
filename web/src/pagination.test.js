import { expect, test } from "bun:test";
import { visibleWithPinned } from "./pagination.js";

const ws = (id, running = false) => ({ id, running });

test("plain cap: renders the first N in order", () => {
  const all = [ws("a"), ws("b"), ws("c")];
  expect(visibleWithPinned(all, 2).map((w) => w.id)).toEqual(["a", "b"]);
});

test("no pinner: nothing escapes the cap", () => {
  const all = [ws("a"), ws("b"), ws("c", true)];
  expect(visibleWithPinned(all, 1).map((w) => w.id)).toEqual(["a"]);
});

// The regression: a workspace/room with a running agent BELOW the cap rendered
// no row at all, so its green dot could never appear (looked like dots only
// worked for the selected chat). Live entries must survive the slice.
test("a running entry past the cap stays visible", () => {
  const all = [ws("w1"), ws("w2"), ws("w3"), ws("w4"), ws("w5"), ws("w6"), ws("w7"), ws("w8"), ws("idle"), ws("empire-earth", true)];
  const visible = visibleWithPinned(all, 8, (w) => w.running);
  expect(visible.map((w) => w.id)).toEqual(["w1", "w2", "w3", "w4", "w5", "w6", "w7", "w8", "empire-earth"]);
  expect(visible.some((w) => w.id === "idle")).toBe(false);
});

test("multiple running entries past the cap keep display order", () => {
  const all = [ws("a"), ws("b", true), ws("c", true), ws("d"), ws("e", true)];
  expect(visibleWithPinned(all, 1, (w) => w.running).map((w) => w.id)).toEqual(["a", "b", "c", "e"]);
});

test("a running entry already inside the cap is not duplicated", () => {
  const all = [ws("a", true), ws("b"), ws("c", true)];
  expect(visibleWithPinned(all, 2, (w) => w.running).map((w) => w.id)).toEqual(["a", "b", "c"]);
});

test("cap of zero still surfaces live entries", () => {
  const all = [ws("a"), ws("b", true)];
  expect(visibleWithPinned(all, 0, (w) => w.running).map((w) => w.id)).toEqual(["b"]);
});

test("does not mutate the input list", () => {
  const all = [ws("a"), ws("b", true)];
  visibleWithPinned(all, 1, (w) => w.running);
  expect(all.map((w) => w.id)).toEqual(["a", "b"]);
});
