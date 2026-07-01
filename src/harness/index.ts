// Side-effect barrel: importing this module registers every harness (each
// adapter calls registerHarness at its bottom) and every sandbox backend.
// Adding a harness or backend = one module + one import line here; nothing
// else in the codebase learns the new id (AGENTS.md §RULE #0).

import "./pi.js";
import "./claude.js";
import "./codex.js";
import "./sandbox/seatbelt.js";
import "./sandbox/none.js";
