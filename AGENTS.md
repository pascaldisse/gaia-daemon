# AGENTS.md — gaia-daemon project rules

## ⚠️ RULE #0 — THE HARNESS ABSTRACTION IS ABSOLUTE

**pi, claude, and codex are NOT different things. They are interchangeable agentic
harnesses behind ONE abstraction.** (harness registry → `RunnerHost` → `gaia __run-agent`
runner → the `AgentRuntime`/`AgentEvent` interface.)

You implement a capability **ONCE, at the harness/runtime abstraction layer**, and it
applies **uniformly to every harness** — the ones implemented today, the ones not yet
implemented, and any that come in the future. You do **not** touch "the thing underneath"
(a harness's own provider/SDK/CLI internals). When you add a feature, you add it to the
abstraction layer, full stop.

**ABSOLUTELY FORBIDDEN:**
- `if (harness === "pi")` / `=== "claude"` / `=== "codex"` branches in **shared** code.
- Implementing a feature for one harness "first" and the others "later."
- Describing follow-up as "wire claude/codex separately" — there is no separate.
- Any per-harness exception or special treatment anywhere in the shared layer.

**THE ONLY allowed harness-specific code:** a harness's own registration
(`registerHarness({...})` in `src/runtime/<x>.ts`) may declare its wiring as **DATA on the
spec** — capabilities, ui, and the credential-proxy descriptor — read uniformly by the
shared layer, which never learns which harness it is. `src/runtime/harness-registry.ts`
says it directly: *"Differences between harnesses live as data on the spec … read
uniformly — never as `=== "claude"` branches scattered across modules."*

**Why:** the entire unify refactor exists to give every harness ONE uniform runner + one
tool-IO bridge + swappable sandbox. A single special-case rots that into scattered
exceptions and silently denies the feature to the next harness. This rule has been stated
many times and is treated as a hard regression when broken.

**How to apply:** before writing any harness-touching code, ask — *does this branch on the
harness id in shared code?* If yes, STOP and move it to a uniform mechanism where each
harness declares its behavior as data on its spec. Worked example: the credential-proxy is
a uniform `HarnessSpec.credentialProxy` descriptor every harness declares; `RunnerHost`
applies it with ZERO harness-id branches.

---

## Other standing rules

- **gaia is a multi-human + multi-AI group-chat room daemon** — not single-user. Channel
  bridges (Telegram/Discord/…) are plugins, never core.
- **Summons run autonomously** behind the sandbox + trust tier. NEVER propose
  human-in-the-loop approval/command-gating for summons — the sandbox IS the boundary.
- **No build step.** Daemon runs via `tsx`; `web/src` is type-annotation-free JS served as
  `.ts`. `web/src` cannot import `src/`. Typecheck with `tsc --noEmit`.
- **Zero duplication.** Shared plumbing lives once. Don't re-implement it per harness.
- **Trust is data, not a hardcoded id.** `trust: false` → forced real sandbox, never
  config-weakenable. Never hardcode a provider/model string as a security gate.
