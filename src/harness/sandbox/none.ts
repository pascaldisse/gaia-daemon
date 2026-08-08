// The default backend: no isolation. Registered so it appears in the backend
// list (UI/config) even though resolveSandboxLaunch short-circuits it.
import { registerSandbox } from "./spec.js";

registerSandbox({
  id: "none",
  available: () => true,
  wrap: (spec) => ({ command: spec.argv[0], args: spec.argv.slice(1) }),
});
