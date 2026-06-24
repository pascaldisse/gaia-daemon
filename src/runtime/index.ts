// Harness barrel. Importing this module self-registers every harness (the
// side-effect imports below) and re-exports the registry API. Every consumer
// outside `runtime/` imports the registry through here, so registration is
// guaranteed to have run before any lookup. Add a harness = new
// `runtime/<x>.ts` + one import line here.
import "./pi-runtime.js";
import "./codex-runtime.js";
import "./claude-runtime.js";

export * from "./harness-registry.js";
