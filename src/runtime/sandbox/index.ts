// Sandbox barrel: importing this self-registers every backend and re-exports the
// registry API. Add a backend = new `sandbox/<x>.ts` + one import line here.
import "./none.js";
import "./macos-seatbelt.js";

export * from "./registry.js";
