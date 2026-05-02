import test from "node:test";
import assert from "node:assert/strict";
import { planMentionRoute } from "../src/router/mention-router.ts";

test("routes to the default agent when no mention is present", () => {
  const result = planMentionRoute("help me think", ["gaia", "sidia"], "gaia");

  assert.deepEqual(result, {
    ok: true,
    plan: { targets: ["gaia"], mentions: [] },
  });
});

test("routes mentioned agents in first-mentioned order without duplicates", () => {
  const result = planMentionRoute("@sidia then @gaia and @sidia again", ["gaia", "sidia"], "gaia");

  assert.deepEqual(result, {
    ok: true,
    plan: { targets: ["sidia", "gaia"], mentions: ["sidia", "gaia"] },
  });
});

test("reports unknown mentions", () => {
  const result = planMentionRoute("@unknown please help", ["gaia"], "gaia");

  assert.deepEqual(result, {
    ok: false,
    unknown: ["unknown"],
  });
});
