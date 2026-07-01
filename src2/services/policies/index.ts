// Policy barrel. Importing this module self-registers every routing policy (the
// side-effect imports below) and re-exports the registry API. Consumers outside
// `policies/` import through here, so registration is guaranteed to have run
// before any lookup. Add a policy = new `policies/<x>.ts` + one import line here
// (exactly the harness barrel pattern).

import "./prompt-driven.js";
import "./conductor-dag.js";
import "./trinity-head.js";

export * from "./registry.js";
