> ⚠️ **HARNESS ABSTRACTION — ABSOLUTE RULE (see [AGENTS.md](AGENTS.md) §RULE #0).** pi/claude/codex are interchangeable harnesses behind ONE abstraction. Implement every capability ONCE at the abstraction layer (harness registry / RunnerHost / runner) so it applies to ALL harnesses — present, unimplemented, and future. NEVER special-case a harness, NEVER `if (harness === "pi")` in shared code, NEVER touch the thing underneath. A harness may ONLY declare its own wiring as DATA on its spec.

# HANDOFF — The Monad Engine (core) + Fugu-as-a-plugin

**This is the fresh-context entry point.** Read this top-to-bottom and you can build
without the prior conversation. Background/evidence lives in
`HANDOFF-OPENFUGU-SETUPS.md` (same branch); this doc is the spec.

- **Branch / worktree:** `worktree-research+openfugu-setups` (isolated git worktree;
  the other agent's `main` is untouched). Base = `origin/main`.
- **OpenFugu reference clone:** scratchpad `…/scratchpad/openfugu/` (Apache/Llama
  licensed — deliberately NOT committed). Key files: `openfugu/mini.py` (TRINITY
  router + loop), `openfugu/ultra.py` (Conductor DAG executor),
  `docs/HOW_FUGU_IS_IMPLEMENTED.md` (evidence-graded reverse-engineering).
- **Concrete setup shipped with this handoff:** `setups/monad/` (setup.json + role
  files + the `monad-loop` skill). Runnable as the zero-code P0 path today.
- **Memory:** `monad-concept.md`, `openfugu-research.md` (indexed in `MEMORY.md`).

---

## 0. STATUS — BUILT (P1 + P2 + P3), 233/233 green, `tsc` clean

The engine, both Fugu policies, the setup system, the serve seam, and the Fugu
plugin are **implemented and tested**. This section is the source of truth; the
spec below (§3–§7) is what was built, kept for rationale.

**New files (core):**
- `src/runtime/monad/types.ts` — all monad data types (value-free; no import cycle)
- `src/runtime/monad/policy-registry.ts` — `RoutingPolicy` registry (mirrors harness-registry)
- `src/runtime/monad/util.ts` — `replyAccepts` / `renderTranscript` / `extractJsonObject`
- `src/runtime/monad/policies/prompt-driven.ts` — default policy: model-led routing + deterministic Thinker→Worker→Verifier fallback (no ML, works with no model)
- `src/runtime/monad/policies/conductor-dag.ts` — **Conductor**: plans a workflow, replays one step/turn, threads `sees` (access_list). Pure TS.
- `src/runtime/monad/policies/trinity-head.ts` — **TRINITY**: shells to a Python sidecar; pure `decisionFromRouter` mapping is unit-tested.
- `src/runtime/monad/serve-registry.ts` + `serve/openai-compatible.ts` — the "answer as one" seam + a working adapter
- `src/runtime/monad/index.ts` — barrel (self-registers policies + adapters)
- `src/app/monad-engine.ts` — the loop + step-threading (`assembleTask`), reuses `SummonHost`
- `src/setups/setup-loader.ts` — discovery + `activateSetup` (inlines role prompts into `RoomState.monad`)
- `src/setups/setup-cli.ts` — `gaia setup list|activate|status|off`
- `src/setups/serve-cli.ts` — `gaia serve <room>` (headless coordinator + engine + adapter)

**Touched (core):** `src/room/state.ts` (`RoomState.monad?` + validating normalizer) ·
`src/app/gaia-controller.ts` (monad-message routing → `runMonadTask`; `/setup` command) ·
`src/app/commands.ts` (`/setup` parse + help) · `src/cli.ts` (`setup`, `serve` verbs).

**Bundled data:** `setups/monad/` (prompt-driven) · `setups/fugu/` (conductor-dag, **runs today, no weights**) ·
`setups/fugu-trinity/` (trinity-head; needs weights) · `plugins/fugu/` (py sidecar + fetch_artifacts + README with the 1-1 map).

**Tests:** `test/monad.test.ts` — 12 tests: engine loop (REVISE→ACCEPT), model-led
routing, max-turns, **step-threading proof** (P2: a later step sees only its
access_list), conductor `parseWorkflow` (drops forward refs / unknown agents),
trinity `decisionFromRouter`, state round-trip, util, registries, and **real
bundled-setup discovery + activation** in a temp workspace.

**How to run:**
```
gaia setup list
gaia setup activate fugu        # or: monad | fugu-trinity   (→ this room is now a monad room)
# then send a plain message in that room → the monad runs; each step is a visible child room
gaia serve default --port 8799  # expose the room as one OpenAI-compatible model
```

**One honest caveat (the only deviation from "pure plugins"):** routing policies
and serve adapters **register in-tree via the barrel**, exactly like harnesses
(`runtime/index.ts`) — that IS Gaia's extensibility idiom, not a hack. The Fugu
*setups* are pure drop-in config/data; what is NOT yet built is a *dynamic
external policy loader* (drop a `.ts` policy folder with zero core edit). That is
a clean follow-up (a `plugins/*/policies/*` import scan) and the seam is ready for
it. `trinity-head` runs only once its Python sidecar + trained weights are
installed (see `plugins/fugu/README.md`); everything else runs with no extra deps.

---

## 1. Findings recap (one page)

**OpenFugu** is an open reverse-engineering of Sakana AI's **Fugu** — an **LLM
router**, not a role framework. Two real ICLR-2026 papers, both verified:
- **TRINITY** (arXiv:2512.04695): a frozen Qwen3-0.6B + a 10K bias-free linear head on
  the penultimate hidden state (+ SVF, <20K trainable params), trained by **sep-CMA-ES**.
  Each turn it picks one of L workers **and** a role ∈ {Worker, Thinker, Verifier};
  loops until a Verifier ACCEPTs or K=5 turns.
- **Conductor** (arXiv:2512.04388): a 7B model (GRPO-trained) emits a whole workflow as
  three equal-length lists `model_id` / `subtasks` / `access_list`, executed
  sequentially with selective visibility (a topological DAG). Can recurse (emit itself).

**The monad = this, by the user's own name.** The user's "monad" (found in an old
`config.yaml`: `monad.order: [gaia, sidia]`) is a coordinator that runs sub-personas in
order and presents them as one. TRINITY/Conductor is the dynamic, learned version.

**Canonical roles (fixed — do not mix up):**
- **Gaia = Thinker** (plans / decomposes / critiques)
- **Terry = Worker** (does the concrete work)
- **Sidia = Verifier** (skeptical/crack-finding → ACCEPT/REVISE)
- **monad = the coordinator** that routes among them and answers as one.

All three (Gaia/Terry/Sidia) are **seeded default personas** today
(`src/agents/registry.ts`). Terry's default soul is literally "practical engineer,
smallest useful patch first" = a Worker.

**The de-risking finding:** the Conductor paper shows a 7B beats a 3B "by better NL
subtask prompting, not better agent selection" — both pick agents near-identically. So
**a strong model writing good instructions captures most of the value; a prompt-driven
monad needs no trained router.** The ML path is optional, maybe never needed.

---

## 2. Architecture decision (locked with the user)

- The **monad engine + the generic `monad-loop` skill live in core gaia-daemon.**
- **Fugu must be replicable 1-1 as a plugin/setup on top.** This is the acceptance
  test for every core seam: *if Fugu needs it and a plugin can't supply it, core is
  missing a seam.*

### "Isn't the monad just summons?" — yes, mostly. (Verified against the code.)
The turn loop is: route → dispatch a worker → read reply → update state → repeat until
ACCEPT or K. In Gaia, **dispatch + "see underneath" already is summons**:
`SummonCoordinator.summonAndWait(parentRoomId, agentId, task)` runs a worker in a
**child room with its own transcript** (`src/app/summon-coordinator.ts`).

So a **prompt-driven dynamic monad needs ZERO new code** — that's exactly what
`setups/monad/` is (the `monad-loop` skill drives summons). The engine adds only the
two things summons lack, and they are precisely what full Fugu needs:

1. **Routing as a first-class, swappable policy** (today "who runs" is a coordinator
   LLM's freeform choice or a per-agent constant; Fugu's thesis is a *trained* router).
2. **Deterministic step data-flow between dispatches** (Conductor `access_list`).

### The 1-1 Fugu replication map (core seam vs. plugin/setup)

| Fugu component | core seam (engine) | Fugu plugin/setup supplies |
|---|---|---|
| per-turn loop (route→dispatch→append→until ACCEPT/K) | **MonadEngine loop** | — (this *is* the engine) |
| routing policy = 0.6B head / Conductor-DAG / LLM | **`RoutingPolicy` registry seam** (default: prompt-driven) | TRINITY-head policy (py sidecar + weights) / Conductor-DAG policy |
| roles Worker/Thinker/Verifier (+ prompts) | **roles** (existing markdown primitive) | ships `worker/thinker/verifier.md` |
| 7-slot worker pool → providers | **slot→agent map** in `setup.json` | maps slots to gaia agents/harnesses |
| Verifier ACCEPT/REVISE stop, K turns | **termination hook** (config / policy) | setup config |
| Conductor `access_list` DAG data-flow | **step-threading in the engine** | the DAG policy uses it |
| recursion (Conductor names itself) | falls out of `RoutingPolicy` (may select "self") | plugin behavior |
| "answer as one" OpenAI endpoint | **`ServeAdapter` seam** | a serve plugin |
| trained weights (`model_iter_60.npy`, 7B) | loaded by the policy plugin | `fetch_artifacts` in the plugin |

The 0.6B head is torch/Python; core is TS. The `RoutingPolicy` seam is
**language-agnostic** — a Fugu plugin shells out to a Python sidecar (literally
`openfugu/mini.py`'s `FuguRouter`); the TS default policy needs no Python.

---

## 3. Core engine spec

### 3.1 Placement (the main design decision)

**Recommended: the engine runs at the app/daemon layer, beside `SummonCoordinator`**,
because it needs cross-room orchestration (summon) and must host policies (incl. a
Python sidecar) in the daemon process — not in a per-agent subprocess.

A room becomes a **monad room** when a setup is activated into it. The controller, on a
user message to a monad room, routes to `MonadEngine.run(query)` instead of a single
agent turn. The engine orchestrates real summons (inspectable child rooms = "see
underneath" for free) and streams step events to the UI.

> Alternative considered: a `monad` *harness* (so a monad agent's turn = an engine
> run, fitting the "uniform per-room runner" aesthetic). Rejected as primary because
> the engine needs the in-daemon `SummonHost` and daemon-hosted policies; a subprocess
> harness would have to drive summons over the harness bridge and couldn't host a
> Python policy cleanly. Revisit only if the engine must run inside the sandboxed
> runner.

### 3.2 `RoutingPolicy` — the brain (new registry seam)

Mirror `src/runtime/harness-registry.ts` exactly (self-registering Map; nothing else
learns policy ids). New file `src/runtime/monad/policy-registry.ts`:

```ts
// One descriptor per routing policy. A policy is added by dropping in one
// runtime/monad/policies/<x>.ts that calls registerRoutingPolicy(...) and adding one
// import to the barrel. The engine, setup loader, and config parsers iterate this
// registry generically — never `=== "trinity-head"` branches.

export interface ChatMessage { role: string; content: string; }

export interface MonadStep {
  index: number;
  agentId: string;        // resolved gaia agent that ran this step
  role: string;           // "thinker" | "worker" | "verifier" | ...
  subtask: string;        // the NL instruction the worker was given
  sees: number[];         // indices of earlier steps fed into this step (access_list)
  reply: string;          // the worker's output
}

export interface MonadObservation {
  query: string;          // original user query
  steps: MonadStep[];     // completed steps, in order
  transcript: string;     // raw "role: content\n" rendering (TRINITY's decisive format)
}

export interface MonadSlot { index: number; agentId: string; label?: string; defaultRole?: string; }

export interface RouteDecision {
  agentId: string;                 // worker to dispatch (resolved from a slot)
  role: string;                    // role to condition on
  subtask: string;                 // NL instruction for this step
  sees: number[] | "all";          // which prior outputs this step may see
}

export type MonadOutcome =
  | { kind: "dispatch"; decision: RouteDecision }
  | { kind: "accept"; finalStepIndex?: number }
  | { kind: "stop"; reason: "max-turns" | "no-progress" };

export interface RoutingPolicyContext {
  slots: MonadSlot[];
  roles: string[];
  maxTurns: number;
  /** Thin model-call handle the policy may use. Prompt-driven & Conductor policies
   *  call a model here; the head policy shells out to a python sidecar instead and
   *  ignores this. Implemented by the engine over SummonHost / a direct runtime. */
  invoke(agentId: string, messages: ChatMessage[]): Promise<string>;
}

export interface RoutingPolicy {
  id: string;
  /** Decide the next action from the evolving observation. Per-turn policies decide
   *  one step; workflow (DAG) policies plan on turn 0 and then replay one step/turn. */
  next(obs: MonadObservation, ctx: RoutingPolicyContext): Promise<MonadOutcome>;
}

export interface RoutingPolicySpec {
  id: string;
  ui?: { label: string; description: string };
  create(config: unknown): RoutingPolicy;   // config = setup.json "monad.policyConfig"
}

const registry = new Map<string, RoutingPolicySpec>();
export function registerRoutingPolicy(spec: RoutingPolicySpec): void { registry.set(spec.id, spec); }
export function findRoutingPolicy(id: string): RoutingPolicySpec | undefined { return registry.get(id); }
export function routingPolicySpecFor(id: string): RoutingPolicySpec {
  const s = registry.get(id); if (!s) throw new Error(`Unsupported routing policy: ${id}`); return s;
}
export function routingPolicyIds(): string[] { return [...registry.keys()]; }
```

One interface covers **both** Fugu variants: TRINITY decides each turn; Conductor plans
a DAG on turn 0 (storing it in closure) and emits one `dispatch` per step with `sees`
set from its `access_list`. `accept` ends the loop (verifier ACCEPT / empty-lists
recursion stop).

### 3.3 `MonadEngine` — the loop (new, app layer)

New file `src/app/monad-engine.ts`. Reuses `SummonHost` (existing) for dispatch; the
only genuinely new logic is the loop + step-threading (`assembleTask`).

```ts
import type { SummonHost } from "./summon-coordinator.js";
import type { ResolvedRole } from "../roles/roles.js";

export interface MonadConfig {
  policy: string;                    // routing policy id
  policyConfig?: unknown;
  slots: MonadSlot[];
  roles: string[];
  maxTurns: number;
  terminate?: { on: "verifier-accept"; acceptToken: string };
}

export interface MonadResult { final: string; steps: MonadStep[]; terminatedBy: string; }

export class MonadEngine {
  constructor(
    private readonly summon: SummonHost,
    private readonly policy: RoutingPolicy,
    private readonly config: MonadConfig,
    private readonly parentRoomId: string,
    private readonly resolveRolePrompt: (agentId: string, role: string) => Promise<string>,
  ) {}

  async run(query: string, onStep?: (s: MonadStep) => void): Promise<MonadResult> {
    const obs: MonadObservation = { query, steps: [], transcript: render(query, []) };
    for (let t = 0; t < this.config.maxTurns; t++) {
      const outcome = await this.policy.next(obs, this.ctx());
      if (outcome.kind === "accept") return finalize(obs, "verifier-accept", outcome.finalStepIndex);
      if (outcome.kind === "stop")   return finalize(obs, outcome.reason);
      const d = outcome.decision;
      const task = await this.assembleTask(d, obs);           // role prompt + access_list context
      const reply = await this.summon.summonAndWait(this.parentRoomId, d.agentId, task);
      const step: MonadStep = {
        index: t, agentId: d.agentId, role: d.role, subtask: d.subtask,
        sees: d.sees === "all" ? obs.steps.map((s) => s.index) : d.sees, reply,
      };
      obs.steps.push(step); obs.transcript = render(query, obs.steps); onStep?.(step);
    }
    return finalize(obs, "max-turns");
  }

  // step-threading: build the worker's prompt from its role + the prior outputs it may see.
  private async assembleTask(d: RouteDecision, obs: MonadObservation): Promise<string> {
    const rolePrompt = await this.resolveRolePrompt(d.agentId, d.role);
    const seen = (d.sees === "all" ? obs.steps : obs.steps.filter((s) => d.sees.includes(s.index)));
    const ctx = seen.map((s) => `<Agent ${s.index} (${s.role})>\n${s.reply.trim()}\n</Agent ${s.index}>`).join("\n");
    return [rolePrompt, ctx && `Context from earlier steps:\n${ctx}`, `Your subtask: ${d.subtask}`]
      .filter(Boolean).join("\n\n");
  }
  // ctx(), render(), finalize() omitted for brevity — see §3.4 for behavior.
}
```

**Dispatch = `summonAndWait` (unchanged).** That is why the everyday monad is "just
summons," and why every step is a real, inspectable child room.

### 3.4 Behavior notes
- **`render(query, steps)`** produces the raw `"role: content\n"` transcript — TRINITY
  needs exactly this (chat-template input collapses accuracy 95% → 5%, per the paper).
- **Termination:** the engine trusts the policy's `accept`/`stop`. A convenience
  `terminate.on = "verifier-accept"` lets the prompt-driven policy detect ACCEPT by
  token; head/Conductor policies own their own stop.
- **`invoke()` for policies** that need a model (prompt-driven, conductor-dag): run a
  one-shot turn on a coordinator agent. Simplest impl: a private summon whose reply is
  the model output; or a direct `createAgentRuntime` + `runAgentTurn` for the
  coordinator agent (`src/app/turn-runner.ts`). Keep it on the daemon side.

### 3.5 Where monad state lives
Extend `RoomState` (`src/room/state.ts`) with an optional active-monad block, written by
setup activation and read by the controller to decide "is this a monad room?":

```ts
export interface RoomState {
  activeRoles: Record<string, string>;
  agentCursors: Record<string, number>;
  runtimeDetails: Record<string, RuntimeMessageDetails>;
  parentRoomId?: string;
  monad?: MonadConfig;     // NEW: present ⇒ user messages route through MonadEngine
}
```
Add a `normalizeRoomState` branch (same pattern as the existing fields). No other core
type changes are required for P1/P2.

### 3.6 Default policy (core, TS, no ML): `prompt-driven`
`src/runtime/monad/policies/prompt-driven.ts`. Uses `ctx.invoke(coordinatorAgent, …)`
to ask, each turn: *given the pool, the roles, and the transcript, return the next
{agent, role, subtask} or ACCEPT.* Parse a tiny JSON/line reply into a `MonadOutcome`.
This reproduces the everyday monad and — per the de-risking finding — most of Fugu's
value, with zero Python and zero weights.

### 3.7 Serve adapter seam (for "answer as one")
`src/runtime/monad/serve-registry.ts` — same registry shape:
```ts
export interface ServeAdapter {
  id: string;
  start(opts: { port: number; run: (messages: ChatMessage[]) => Promise<string> }): Promise<{ stop(): Promise<void> }>;
}
```
`run` invokes `MonadEngine.run(lastUserMessage)`. A core `gaia serve <room> --port`
command wires it. The OpenAI-compatible adapter can be a plugin; core only defines the
seam + command.

---

## 4. The setup/preset system (Feature A)

A **setup** = a saved bundle loaded into a room in one command. This is the user's own
idea (the papers have no team/profile concept).

### 4.1 `setup.json` schema
See the runnable `setups/monad/setup.json`. Fields: `id`, `displayName`, `description`,
`version`, `roomDefaults`, `monad` (the `MonadConfig`: policy + slots + roles +
maxTurns + terminate), `agents` (ref → role bindings), `roles` (agentId → role-file
path, copied on activate), optional `coordinator` (zero-code path: a coordinator agent
+ the `monad-loop` skill), optional `skills`.

### 4.2 Discovery paths
`~/.gaia/setups/{id}/setup.json` (global) and `{project}/.gaia/setups/{id}/` (project),
plus repo-bundled defaults under `setups/` (seed like default agents in
`registry.ts`). New loader `src/setups/setup-loader.ts`.

### 4.3 `gaia setup activate <id> [room]` (new CLI verb + controller hook)
Activation steps (all reuse existing primitives):
1. **Ensure agents** — for each `agents[].ref`, if missing and `from` is set, clone the
   bundled agent dir into `.gaia/agents/{id}/` (reuse `ensureGlobalDefaultAgents`-style
   scaffold in `src/agents/registry.ts`).
2. **Place roles** — copy each `roles[agentId]` file into that agent's
   **`projectRolesDir`** (`.gaia/agents/{id}/persona/roles/{role}.md`). This reuses the
   existing role resolver (`resolveAgentRole` already merges project roles) — **no new
   search-path code.**
3. **Place skills** — copy setup skills into the project skills dir the resolver
   already searches.
4. **Set roles** — write `state.activeRoles[agentId] = role` for each binding.
5. **Write monad config** — set `state.monad = setup.monad` on the room (§3.5).
6. **Apply `roomDefaults`** — merge into workspace/room config.

After activation the room is a monad room; the next user message runs the engine.

### 4.4 Wire points (existing files)
- CLI verb: `src/cli.ts` + `src/app/commands.ts` (where `/summon`, `/role`, `/thinking`
  already live — add `/setup` + `gaia setup`).
- Tools registry: if a `summon_workflow` tool is wanted for the zero-code DAG path, add
  one entry to `GAIA_TOOLS` in `src/tools/gaia-tools.ts` (one entry = in-process tool +
  Claude grant + CLI verb + prompt pointer, all at once).

---

## 5. Fugu-as-a-plugin (the 1-1 target)

A `fugu` plugin = a folder of registered policies + a setup, bundling nothing core.

1. **`trinity-head` policy** (`per-turn`): a TS `RoutingPolicy` whose `next()` shells
   out to a Python sidecar wrapping `openfugu/mini.py`'s `FuguRouter.route(messages)` →
   `{agent_id, role_id}`. Maps `agent_id`→slot, `role_id`→{Worker,Thinker,Verifier},
   emits `dispatch`; on a Verifier reply starting `ACCEPT` → `accept`. Needs
   `model_iter_60.npy` + Qwen3-0.6B (the plugin's `fetch_artifacts.py`). Set `maxTurns=5`.
   Input MUST be the raw `"role: content"` transcript (already what `render()` produces).
2. **`conductor-dag` policy** (`workflow`): `next()` on turn 0 calls
   `ctx.invoke(conductorAgent, conductor_prompt(query, slots))`, parses the 3 lists
   (`openfugu/ultra.py` `parse_workflow`), stores them; each turn emits one `dispatch`
   with `sees` = `visible_indices(access_list, t)`; after the last step → `accept`.
   Recursion = the policy may emit a `dispatch` to the conductor slot itself.
3. **Pool** = `setup.json` `monad.slots` mapping 7 slots → gaia agents (each agent
   carries its own harness/model/trust/sandbox). "Slot labels are training metadata,
   remappable to any provider" — same as Gaia's swappable harnesses.
4. **Serve** = an OpenAI-compatible `ServeAdapter` plugin → `gaia serve fugu-room`.
5. **Two head variants:** production Fugu drops the 3 role logits (L-only head);
   academic TRINITY keeps L+3. Expose a `roles: on|off` flag in the policy config.

**1-1 test:** every box above is a registered policy / setup field / markdown / serve
plugin. If any can't be, that's a core seam to add — report it rather than hack core.

---

## 6. File-by-file build plan

**New (core):**
- `src/runtime/monad/policy-registry.ts` — `RoutingPolicy` types + registry (§3.2)
- `src/runtime/monad/policies/prompt-driven.ts` — default policy (§3.6)
- `src/runtime/monad/index.ts` — barrel that imports policies (self-register)
- `src/app/monad-engine.ts` — `MonadEngine` loop + step-threading (§3.3)
- `src/setups/setup-loader.ts` — discovery + `activate()` (§4)
- `src/runtime/monad/serve-registry.ts` — `ServeAdapter` seam (§3.7)

**Touched (core):**
- `src/room/state.ts` — add `RoomState.monad?` + normalize branch (§3.5)
- `src/app/gaia-controller.ts` — if `state.monad`, route user message → `MonadEngine`
  (inject the existing `SummonHost`)
- `src/cli.ts`, `src/app/commands.ts` — `/setup`, `gaia setup activate`, `gaia serve`
- `src/tools/gaia-tools.ts` — (optional P2) a `summon_workflow` entry

**New (bundled data, already written here):**
- `setups/monad/` — setup.json + roles + `monad-loop` skill (the reference setup)

**New (Fugu plugin, P3):**
- `plugins/fugu/policies/{trinity-head,conductor-dag}.ts` + `py/` sidecar +
  `fetch_artifacts.py` + `setups/fugu/setup.json` + a serve adapter.

---

## 7. Phasing + acceptance tests

- **P0 — prompt-driven monad, zero core.** Activate `setups/monad/` by hand (place the
  role files on gaia/terry/sidia, give a coordinator the `monad-loop` skill). *Accept:*
  a query runs Gaia→Terry→Sidia over visible summons and stops on Sidia ACCEPT.
  *(Files already exist; this just needs manual wiring or the P1 loader.)*
- **P1 — Setup loader + `gaia setup activate` + `MonadEngine` + `prompt-driven`
  policy.** *Accept:* `gaia setup activate monad` makes a room a monad room; one user
  message yields one accepted answer, with the step trace inspectable as child rooms.
- **P2 — step-threading + `summon_workflow` (DAG data-flow).** *Accept:* a 3-step plan
  where step 2 provably consumes step 1's output (access_list honored; forward refs
  rejected).
- **P3 — Fugu plugin (`trinity-head` + `conductor-dag` + serve).** *Accept:*
  `openfugu/mini.py --self-test` parity behind the policy seam (95%/100% on the 37-case
  fixture); `gaia serve` returns one answer over the hidden pool. **= Fugu 1-1.**

---

## 8. Open decisions for the implementer
1. **Engine placement** — app-layer coordinator (recommended, §3.1) vs a `monad`
   harness. Affects how policies are hosted and how the sandbox wraps steps.
2. **`invoke()` impl** — private summon vs direct `createAgentRuntime`+`runAgentTurn`
   for the coordinator. The latter avoids a child room for pure routing calls.
3. **Monad config home** — `RoomState.monad` (recommended) vs a per-room `monad.json`
   vs a `WorkspaceConfig.monad`. Per-room fits "a room is/ isn't a monad room."
4. **Role placement on activate** — copy into each agent's `projectRolesDir` (reuses
   the resolver, recommended) vs add a setup-scoped role search path to
   `resolveAgentRole`.
5. **Trust/sandbox** — monad steps are summons, so existing summon-policy
   (`src/app/summon-policy.ts`: summons never naked, nested-summon gating) already
   applies. Confirm a slot agent with `trust:false` still routes correctly.
