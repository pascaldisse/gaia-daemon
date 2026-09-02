import assert from "node:assert/strict";
import test from "node:test";
import {
  authorizeCapabilities,
  authorizePlugin,
  CapabilityBroker,
  CapabilityDeniedError,
  resolveCapabilityGrants,
} from "../src/services/capabilities/index.js";
import type { CapabilityContext, CapabilityRequester } from "../src/services/capabilities/index.js";

function ctx(roomId = "room-1", agentId = "agent-1", workspaceId = "ws-1"): CapabilityContext {
  return Object.freeze({ workspaceId, roomId, agentId });
}

function requester(namespace: string, requiredCaps: readonly string[]): CapabilityRequester {
  return Object.freeze({ namespace, requiredCaps: Object.freeze([...requiredCaps]) });
}

// ---- resolveCapabilityGrants: the trust floor -----------------------------

test("untrusted context resolves to the empty grant set regardless of policy", () => {
  const grants = resolveCapabilityGrants({ workspace: ["room.message", "shell.exec"], agent: ["shell.exec"] }, false);
  assert.equal(grants.size, 0);
});

test("untrusted floor is non-overridable even by an all-capabilities policy", () => {
  const wideOpen = { workspace: ["room.message"], agent: ["room.message", "shell.exec"] };
  assert.equal(resolveCapabilityGrants(wideOpen, false).size, 0);
});

test("trusted context grants are the union of workspace and agent policy", () => {
  const grants = resolveCapabilityGrants({ workspace: ["room.message"], agent: ["shell.exec"] }, true);
  assert.deepEqual([...grants].sort(), ["room.message", "shell.exec"]);
});

test("trusted context with no configured policy grants nothing (opt-in, not inferred)", () => {
  assert.equal(resolveCapabilityGrants(undefined, true).size, 0);
  assert.equal(resolveCapabilityGrants({}, true).size, 0);
});

test("trusted union deduplicates overlapping workspace/agent entries", () => {
  const grants = resolveCapabilityGrants({ workspace: ["room.message"], agent: ["room.message"] }, true);
  assert.deepEqual([...grants], ["room.message"]);
});

// ---- authorizeCapabilities / authorizePlugin: pure checks ------------------

test("authorizeCapabilities allows when grants cover every required cap", () => {
  const decision = authorizeCapabilities(["room.message"], new Set(["room.message", "shell.exec"]));
  assert.deepEqual(decision, { allowed: true, missing: [] });
});

test("authorizeCapabilities reports every missing cap, not just the first", () => {
  const decision = authorizeCapabilities(["room.message", "shell.exec"], new Set());
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.missing, ["room.message", "shell.exec"]);
});

test("authorizeCapabilities allows a plugin declaring zero required caps against zero grants", () => {
  assert.deepEqual(authorizeCapabilities([], new Set()), { allowed: true, missing: [] });
});

test("authorizePlugin throws CapabilityDeniedError carrying namespace/context/missing on denial", () => {
  const plugin = requester("bundled:example", ["shell.exec"]);
  const context = ctx("room-42", "agent-9");
  assert.throws(
    () => authorizePlugin(plugin, context, new Set()),
    (error: unknown) => {
      assert.ok(error instanceof CapabilityDeniedError);
      assert.equal(error.namespace, "bundled:example");
      assert.deepEqual(error.context, context);
      assert.deepEqual(error.missing, ["shell.exec"]);
      return true;
    },
  );
});

test("authorizePlugin does not throw when every required cap is granted", () => {
  assert.doesNotThrow(() => authorizePlugin(requester("bundled:example", ["room.message"]), ctx(), new Set(["room.message"])));
});

// ---- CapabilityBroker: {roomId, agentId}-scoped, host-injected sources -----

test("CapabilityBroker requires both sources to be functions", () => {
  assert.throws(() => new CapabilityBroker({ grantSource: undefined as never, trustSource: () => true }), TypeError);
  assert.throws(() => new CapabilityBroker({ grantSource: () => undefined, trustSource: undefined as never }), TypeError);
});

test("CapabilityBroker.authorize consults trustSource+grantSource per {roomId,agentId}, not globally", () => {
  const seen: CapabilityContext[] = [];
  const broker = new CapabilityBroker({
    grantSource: (context) => {
      seen.push(context);
      return context.roomId === "room-a" ? { agent: ["shell.exec"] } : {};
    },
    trustSource: (context) => context.agentId === "trusted-agent",
  });

  assert.doesNotThrow(() => broker.authorize(requester("p", ["shell.exec"]), ctx("room-a", "trusted-agent")));
  assert.throws(() => broker.authorize(requester("p", ["shell.exec"]), ctx("room-b", "trusted-agent")), CapabilityDeniedError);
  assert.throws(() => broker.authorize(requester("p", ["shell.exec"]), ctx("room-a", "other-agent")), CapabilityDeniedError);
  // grantSource is never consulted for the untrusted room-a/other-agent call
  // (the trust floor short-circuits before it) — only the two trusted calls appear.
  assert.deepEqual(seen, [ctx("room-a", "trusted-agent"), ctx("room-b", "trusted-agent")]);
});

test("CapabilityBroker never grants an untrusted context even when grantSource returns everything", () => {
  const broker = new CapabilityBroker({
    grantSource: () => ({ workspace: ["room.message", "shell.exec"], agent: ["room.message", "shell.exec"] }),
    trustSource: () => false,
  });
  assert.equal(broker.grantsFor(ctx()).size, 0);
  assert.throws(() => broker.authorize(requester("p", ["room.message"]), ctx()), CapabilityDeniedError);
});

test("CapabilityBroker never even calls grantSource for an untrusted context", () => {
  let calls = 0;
  const broker = new CapabilityBroker({
    grantSource: () => {
      calls += 1;
      return { workspace: ["room.message"] };
    },
    trustSource: () => false,
  });
  assert.equal(broker.grantsFor(ctx()).size, 0);
  assert.equal(calls, 0);
});

test("CapabilityBroker.decide returns the decision without throwing", () => {
  const broker = new CapabilityBroker({ grantSource: () => ({ agent: ["room.message"] }), trustSource: () => true });
  assert.deepEqual(broker.decide(requester("p", ["room.message"]), ctx()), { allowed: true, missing: [] });
  assert.deepEqual(broker.decide(requester("p", ["shell.exec"]), ctx()), { allowed: false, missing: ["shell.exec"] });
});

// ---- plugin declarations never self-authorize -----------------------------

test("a plugin cannot smuggle its own grants: only requester.namespace/requiredCaps are read", () => {
  // A malicious/careless plugin registration might attach extra fields
  // (grants, allowed, trust, ...) hoping a careless call site forwards them
  // into the authorization path. authorizePlugin/CapabilityBroker read only
  // the CapabilityRequester shape (namespace, requiredCaps); anything else is
  // structurally inert here — grants come solely from the injected sources.
  const selfDeclaringPlugin = {
    namespace: "bundled:sneaky",
    requiredCaps: ["shell.exec"],
    grants: ["shell.exec"], // ignored: not part of CapabilityRequester
    allowed: true, // ignored
  };
  assert.throws(() => authorizePlugin(selfDeclaringPlugin, ctx(), new Set()), CapabilityDeniedError);

  const broker = new CapabilityBroker({ grantSource: () => ({}), trustSource: () => true });
  assert.throws(() => broker.authorize(selfDeclaringPlugin, ctx()), CapabilityDeniedError);
});
