// Monad barrel. Importing this module self-registers every routing policy and
// serve adapter (the side-effect imports below) and re-exports the registry +
// type APIs. Every consumer outside `runtime/monad/` imports through here, so
// registration is guaranteed to have run before any lookup. Add a policy = new
// `policies/<x>.ts` + one import line here (exactly the harness barrel pattern).
import "./policies/prompt-driven.js";
import "./policies/conductor-dag.js";
import "./policies/trinity-head.js";
import "./serve/openai-compatible.js";

export * from "./types.js";
export * from "./policy-registry.js";
export * from "./serve-registry.js";
