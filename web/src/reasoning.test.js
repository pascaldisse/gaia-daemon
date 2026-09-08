// @ts-nocheck — bun test runtime; not app code, typecheck skipped like the other web tests.
// Pure reasoning-view logic. No DOM. Run: bun test web/src/reasoning.test.js
import { expect, test } from "bun:test";
import { agentReasoning, reasoningReturnLevel, reasoningView } from "./reasoning.js";

const choices = (levels) => levels.map((level) => ({ level, providerValue: level }));

test("absent descriptor falls back to the universal levels (transitional only)", () => {
  const v = reasoningView(undefined, "high", ["off", "low", "medium", "high"]);
  expect(v.state).toBe("known");
  expect(v.legacy).toBe(true);
  expect(v.available).toEqual(["off", "low", "medium", "high"]);
  expect(v.effective).toBe("high");
  expect(v.diverged).toBe(false);
});

test("absent descriptor with no legacy levels is 'none'", () => {
  const v = reasoningView(undefined, "off", []);
  expect(v.state).toBe("none");
});

test("unknown status advertises NO level list and never invents one", () => {
  const v = reasoningView({ status: "unknown", provider: "p", model: "m", requestedLevel: "high" }, "off", ["off", "low", "high"]);
  expect(v.state).toBe("unknown");
  expect(v.available).toEqual([]);
  expect(v.requested).toBe("high");
  expect(v.effective).toBe("high");
});

test("known model exposes only its own choices as menu options", () => {
  const v = reasoningView(
    { status: "known", provider: "p", model: "m", choices: choices(["off", "low", "high"]), adaptive: false, source: "discovered", requestedLevel: "high", effectiveLevel: "high" },
    "off",
    ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
  );
  expect(v.state).toBe("known");
  expect(v.available).toEqual(["off", "low", "high"]);
  expect(v.diverged).toBe(false);
});

test("requested unsupported by the model surfaces divergence + resolution, no silent escalate", () => {
  const v = reasoningView(
    { status: "known", provider: "p", model: "m", choices: choices(["off", "low", "medium"]), adaptive: false, source: "override", requestedLevel: "max", effectiveLevel: "low", resolution: "conservative" },
    "max",
  );
  expect(v.diverged).toBe(true);
  expect(v.requested).toBe("max");
  expect(v.effective).toBe("low");
  expect(v.resolution).toBe("conservative");
  expect(v.source).toBe("override");
});

test("a model whose only choice is off has no reasoning", () => {
  const v = reasoningView({ status: "known", provider: "p", model: "m", choices: choices(["off"]), adaptive: false, source: "discovered" }, "off");
  expect(v.state).toBe("none");
});

test("empty choices means no reasoning", () => {
  const v = reasoningView({ status: "known", provider: "p", model: "m", choices: [], adaptive: false, source: "discovered" }, "off");
  expect(v.state).toBe("none");
});

test("xhigh and max stay distinct levels", () => {
  const v = reasoningView(
    { status: "known", provider: "p", model: "m", choices: choices(["off", "high", "xhigh", "max"]), adaptive: false, source: "discovered", requestedLevel: "xhigh", effectiveLevel: "xhigh" },
    "off",
  );
  expect(v.available).toEqual(["off", "high", "xhigh", "max"]);
});

test("reasoningReturnLevel prefers a still-offered remembered level", () => {
  const v = reasoningView({ status: "known", provider: "p", model: "m", choices: choices(["off", "low", "high"]), defaultLevel: "low", adaptive: false, source: "discovered" }, "off");
  expect(reasoningReturnLevel(v, "high")).toBe("high");
});

test("reasoningReturnLevel drops a remembered level the model no longer offers, uses default", () => {
  const v = reasoningView({ status: "known", provider: "p", model: "m", choices: choices(["off", "low", "high"]), defaultLevel: "low", adaptive: false, source: "discovered" }, "off");
  expect(reasoningReturnLevel(v, "max")).toBe("low");
});

test("reasoningReturnLevel falls back to first non-off when no default/remembered", () => {
  const v = reasoningView({ status: "known", provider: "p", model: "m", choices: choices(["off", "medium", "high"]), adaptive: false, source: "discovered" }, "off");
  expect(reasoningReturnLevel(v, undefined)).toBe("medium");
});

test("agentReasoning reads the descriptor off an agent status", () => {
  const desc = { status: "known", provider: "p", model: "m", choices: choices(["off", "low"]), adaptive: false, source: "discovered" };
  expect(agentReasoning(/** @type {any} */ ({ id: "a", reasoning: desc }))).toBe(desc);
  expect(agentReasoning(/** @type {any} */ ({ id: "a" }))).toBeUndefined();
});
