> ⚠️ **HARNESS ABSTRACTION — ABSOLUTE RULE (see [AGENTS.md](AGENTS.md) §RULE #0).** pi/claude/codex are interchangeable harnesses behind ONE abstraction. Implement every capability ONCE at the abstraction layer (harness registry / RunnerHost / runner) so it applies to ALL harnesses — present, unimplemented, and future. NEVER special-case a harness, NEVER `if (harness === "pi")` in shared code, NEVER touch the thing underneath. A harness may ONLY declare its own wiring as DATA on its spec.

# OpenFugu → Gaia: research + setup/preset design

Status: RESEARCH (branch `worktree-research+openfugu-setups`, isolated worktree).
Nothing in core changed. This is the **findings/background** doc.

> **Build spec → `HANDOFF-MONAD-ENGINE.md`** (the fresh-context entry point: core
> engine interfaces, the setup system, the Fugu-as-plugin map, file-by-file plan).
> **Runnable setup → `setups/monad/`** (setup.json + role files + the `monad-loop`
> skill). This doc is the *why*; that doc is the *how*.

---

## 0. The honest reframe (read this first)

**OpenFugu is not a multi-agent role/persona framework.** It is an open
reverse-engineering of Sakana AI's *Fugu* — an **LLM router**. A tiny 0.6B model
(Qwen3-0.6B) reads the query, a bias-free linear head scores a pool of worker
LLMs, the top worker is dispatched, and *its* answer is returned. The repo is
mostly ML research scaffolding: training the router (CMA-ES / GRPO), evaluating
it, verifying it against released weights, and serving it as one OpenAI endpoint.

So the literal hope — "clone it in as a plugin bundle" — does **not** map: 90% of
the repo (`train/`, `eval/`, `verify/`, the 0.6B head, the GRPO loop) is research
infrastructure with no place in Gaia.

The "TRINITY" in the name is **not** Sidya/Gaia/Terry. It's a codename for the
routing mechanism, and for a 3-role loop: **solver / thinker / verifier**.

**But** — and this is why the clone was worth it — the *conceptual core* of
OpenFugu is exactly the brain Gaia's swarm is missing, and it decomposes into two
clean patterns that Gaia can absorb as **setups** (roles + skills + config), with
only one genuinely new seam. Details below.

---

## 0.5 The monad — this IS the concept (grounded, not poetic)

The user's pre-existing **monad** concept (found in a `config.yaml`, NOT in the
current live tree — it was dropped in the unify refactor):
```yaml
personas: { gaia: {...}, sidia: {...}, monad: {...} }
monad:
  order: [gaia, sidia]
```
So the **monad = a meta-persona that runs an ORDERED sequence over sub-personas**
(gaia → sidia). That is a **coordinator**. TRINITY/Conductor is the same idea made
dynamic + learned. The mapping is now grounded:

CANONICAL ROLE MAPPING (fixed; "it has always been like that"):

| monad concept | TRINITY role | role |
|---|---|---|
| **monad** | the coordinator (0.6B head / 7B Conductor) | routes among the three; presents the swarm as one |
| **gaia** | **Thinker** | plans / decomposes / critiques — the meta layer |
| **terry** | **Worker** | does the concrete work |
| **sidia** | **Verifier** | skeptical / crack-finding → ACCEPT/REVISE |

Today's monad is a **static ordered pipeline** (gaia→sidia). TRINITY makes routing
**per-turn dynamic**, looping until Verifier ACCEPT. FP intuition holds: a monad
sequences/composes and presents-as-one — i.e. "Fugu as one model" hiding a pool.
**The monad is currently unimplemented in the live architecture; reviving it as a
real coordinator IS this work.** Re-frame the whole effort as "the monad," not
"importing OpenFugu."

---

## 0.6 Paper-verified facts (full text pulled 2026-06-25)

Both papers are real, ICLR 2026, same Sakana authors; OpenFugu's code is faithful.

- **TRINITY** (arXiv:2512.04695): roles Thinker (meta guidance/plans/critique) /
  Worker (concrete progress) / Verifier (ACCEPT|REVISE). Head = 10K linear on
  penultimate hidden state; SVF on select layers; <20K params total. Trained by
  **sep-CMA-ES**, λ≈32, **binary** terminal reward, 16 evals/candidate, 1.5k–40k
  evals. Stop on ACCEPT or ≤5 turns. **No saved-team / profile concept exists in
  the paper** — one θ over a fixed 7-model pool. → *the "setup/preset" idea is the
  user's own, not from the papers.*
- **Conductor** (arXiv:2512.04388): emits 3 lists `model_id`/`subtasks`/
  `access_list` (e.g. `access_list=[[], ["all"]]`). **CORRECTION to §1b/§4 below:
  it is sequential execution with selective visibility, NOT a full DAG scheduler** —
  strictly left-to-right, access_list filters which prior outputs each step sees.
  Trained with **GRPO** (reward = parseable-format + correctness 1.0/0.5), Qwen2.5-7B,
  no KL. Can emit **itself** as a worker (recursion → test-time scaling).
- **THE finding that de-risks us:** a 7B Conductor beats a 3B one **almost entirely
  via better per-step prompt-engineering, not better agent selection** (both select
  agents near-identically). → **A strong model writing good subtask instructions
  captures most of the value; a prompt-driven monad needs no trained router.** This
  makes the ML path (P3) optional, possibly never needed.

---

## 0.7 Architecture: core monad engine + Fugu-as-a-plugin (the 1-1 test)

**Decision (user):** the **monad engine + the generic `monad-loop` skill live in
core gaia-daemon**; **Fugu must be replicable 1-1 as a plugin/setup on top.** That
gives the acceptance test for every core seam: *if Fugu needs it and a plugin can't
supply it, core is missing a seam* (= a design flaw to fix in the engine).

### "Isn't the monad just summons?" — mostly yes.
The monad turn-loop = route → dispatch a worker → read reply → update state → repeat
until the Verifier ACCEPTs or K turns. In Gaia today:
- **dispatch + "see what's going on underneath" = summons.** `summonAndWait` runs a
  worker in a **child room with its own transcript** — that IS the per-turn dispatch
  *and* the visible-underneath view you want. ✓
- So a **prompt-driven dynamic monad needs ZERO new code**: a `monad` coordinator
  agent + a `monad-loop` skill ("inspect state → pick Gaia/Terry/Sidia → summon →
  read → decide next → stop on Sidia ACCEPT"). Pure role+skill+config. This is the
  everyday monad and the P0 proof. **Your instinct is correct.**

What summons do NOT give you — and the *only* new core the engine adds:
1. **A routing decision as a first-class, swappable policy.** Today "who runs" is the
   coordinator LLM's freeform choice (fine for the prompt-driven monad) or a per-agent
   constant. Fugu's whole thesis is a *trained* router. → core adds a **`RoutingPolicy`
   interface** (a self-registering registry seam, exactly like harnesses/sandboxes);
   default = prompt-driven; Fugu *registers* the 0.6B-head policy as a plugin.
2. **Deterministic step data-flow between dispatches** (Conductor `access_list`: step
   t sees specific earlier outputs). Flat summon fan-out can't express this without the
   coordinator hand-threading text. → core adds a small **workflow/step-threading
   capability** (or a `summon_workflow` tool). This is the one mechanism Gaia lacks.

Everything else Fugu needs is config / markdown / a registry-plugin.

### The 1-1 Fugu replication map (core seam vs. plugin/setup)

| Fugu component | core seam (engine) | Fugu plugin/setup supplies |
|---|---|---|
| per-turn loop (route→dispatch→append→until ACCEPT/K=5) | **the monad engine loop** | — (this *is* the engine) |
| routing policy = 0.6B head / Conductor-DAG / LLM | **`RoutingPolicy` registry seam** (default: prompt-driven) | TRINITY head policy (py sidecar + weights) / Conductor DAG policy |
| roles Worker/Thinker/Verifier (+ prompts) | **roles** (existing markdown primitive) | ships `worker/thinker/verifier.md` |
| 7-slot worker pool → providers | **slot→harness/model map** in `setup.json` | maps slots to harnesses / litellm models |
| Verifier ACCEPT/REVISE stop, K turns | **termination hook** (config / part of policy) | setup config |
| Conductor `access_list` DAG data-flow | **step-threading / workflow executor** (the new bit) | the DAG policy uses it |
| recursion (Conductor names itself a worker) | falls out of `RoutingPolicy` (policy may select "self") | plugin behavior |
| "answer as one" OpenAI-compatible endpoint | **serve-adapter seam** | a serve plugin |
| trained weights (`model_iter_60.npy`, 7B Conductor) | loaded by the policy plugin | `fetch_artifacts` inside the plugin |

The 0.6B head is torch/Python; Gaia core is TS. The `RoutingPolicy` seam is
**language-agnostic** — a Fugu plugin shells out to a Python sidecar (literally
`openfugu/mini.py`'s `FuguRouter`); the TS default policy needs no Python.

**Verdict:** with **two thin additions to core** — a `RoutingPolicy` interface and
step-data-threading — *everything Fugu-specific becomes a plugin/setup*, and the
everyday dynamic monad stays pure summons+skill+config (zero new code). That is the
design heading toward "replicate Fugu 1-1 through plugins/setup."

### Exact-from-the-papers notes that matter for 1-1
- **Two Fugu variants:** *production Fugu* drops roles (head emits only L worker
  logits, latency-first); *academic TRINITY* keeps L+3 (adds the 3 role logits).
  The released `model_iter_60.npy` is the academic L=7 → 10-logit head. A faithful
  setup should expose both (roles on/off).
- **Two-stage TRINITY training:** SFT KL-warmstart to a temperature-softmax of
  measured per-worker rewards (production only), then sep-CMA-ES (iters=60, σ0=0.03,
  Rrep=16, λ=33, μ=16; div/turn/cost shaping w=0.15/0.10/0). At this budget it
  collapses to an isotropic step-size ES.
- **Input format is load-bearing:** raw `"role: content\n"` transcript, NOT a chat
  template (95% vs 5% joint accuracy). Penultimate-token hidden state, SVF on 9
  matrices (embed + layer-26 {q,k,v,o,gate,up,down} + lm_head).
- **Conductor:** Qwen2.5-7B, GRPO, 200 iters, 64 rollouts/q, batch 256, lr 1e-6,
  β(KL)=0; reward 0/0.5/1 (format/parsed-wrong/correct); recursion finetune 20 iters,
  γ=0.25, stops by emitting empty lists. Beats GPT-5 avg (77.27 vs 74.78) on its table.
- **Headline that de-risks the no-ML path:** 3B vs 7B Conductor "converge to the same
  agent distribution"; the 7B's win is *better NL subtask prompts*, not better routing.

---

## 1. What OpenFugu actually does (the two mechanisms)

Two runnable cores, both worker-pool-agnostic (workers are swappable via litellm;
the slot labels "gpt-5/claude/gemini/…" are just metadata, remappable to any
provider — same philosophy as Gaia's swappable harnesses).

### 1a. TRINITY — per-turn router loop (`openfugu/mini.py`)
A multi-turn coordination loop. Each turn:
1. A **router** picks (worker_id, role) where role ∈ {Worker/solver, Thinker, Verifier}.
   (In OpenFugu the picker is a learned 0.6B head; the *loop around it* is plain code.)
2. **Solver** does the work; its `<think>` is appended to the evolving observation.
3. **Thinker** emits `<suggestion>` + a `<suggested_role>` override for next turn.
4. **Verifier** ACCEPT → done; REJECT → keep going. Caps at 5 turns.

This is a **propose → critique → revise loop with a verifier stop condition.**
The learned head is an optimization; the *pattern* needs no ML at all.

### 1b. Conductor / Fugu-Ultra — plan-then-execute DAG (`openfugu/ultra.py`)
A planner model emits, in one shot, a whole workflow as **three equal-length lists**:
- `model_id`   = which worker runs each step
- `subtasks`   = the NL instruction for each step
- `access_list`= for each step, which *earlier* steps' outputs it may see ([] / "all")

Executed in topological order; each step is fed `<Agent N response>` blocks for the
steps it's allowed to see; the last step's output is the answer. Forward references
are rejected (it must be a DAG). The executor (~80 lines) is the reusable part; the
trained 7B Conductor is optional (a prompted off-the-shelf model works).

---

## 2. The mapping nobody designed but that just fits

The Gaia/Terry/Sidia trinity maps onto TRINITY's three roles *exactly* — this is
the user's established cast, not an inference:

| TRINITY role | persona | Note |
|---|---|---|
| Thinker | **Gaia** | plans / decomposes / critiques — the meta layer |
| Worker | **Terry** | does the concrete work |
| Verifier | **Sidia** | skeptical/crack-finding is *literally* a verifier |
| (coordinator) | **the monad** | the routing policy that sequences the three |

So the user's **Gaia/Terry/Sidia = Thinker/Worker/Verifier**, and the **monad** is
the coordinator over them. That's the bridge: **TRINITY gives us the loop; the
monad/trinity is already the cast.**

---

## 3. What's reusable vs. what to drop

**Reuse (ideas, not code):**
- The **solver→verifier→revise loop** with a verifier ACCEPT stop condition.
- The **Conductor DAG format** (`model_id` / `subtasks` / `access_list`) as a
  serialization for "a swarm plan with explicit data-flow."
- The **topological executor** with access-list visibility (the ~80 LOC in `ultra.py`).
- The principle: **which worker handles a task is a *decision*, not a constant.**
  Gaia currently hardcodes harness-per-agent; routing should be a policy.

**Drop:** the 0.6B head, SVF, CMA-ES/GRPO training, the eval/verify suites, the
OpenAI-compatible server. (A learned router is a *much* later optimization; a
prompt/heuristic router is the right v1.)

---

## 4. Two features this unlocks for Gaia

### Feature A — the **Setup/Preset** system (the user's actual ask)

A *setup* = a named, saved bundle that loads a multi-agent configuration into a
room in one command: N agents, each with a role/system-prompt + harness + skills,
plus room defaults — optionally bundling its own skills/roles.

Gaia's current extension primitives (from the code, not memory):
- **Agents** — `~/.gaia/agents/{id}/agent.json` + `persona/` (`src/agents/`)
- **Roles** — markdown + frontmatter `skills: [...]` (`src/roles/roles.ts`)
- **Skills** — `{skillsDir}/{name}/SKILL.md` (`src/skills/skill-resolver.ts`)
- **Harnesses** — self-registering registry, ids `pi|claude|codex`
  (`src/runtime/harness-registry.ts`) — the closest thing to a "plugin" seam
- **Config** — workspace `.gaia/config.json` (`src/workspace/types.ts`),
  per-agent `agent.json`
- **Rooms** — `.gaia/rooms/{id}/{transcript.jsonl,state.json}`; `state.activeRoles`
  already maps agent → active role (`src/room/state.ts`)

**The proposed seam — a `setup.json` manifest** (pure data, no core logic):
```jsonc
// ~/.gaia/setups/{id}/setup.json   (and project .gaia/setups/{id}/)
{
  "id": "monad",
  "displayName": "Monad (Gaia · Terry · Sidia)",
  "description": "Thinker/Worker/Verifier coordination loop over a worker pool",
  "version": "0.1.0",
  "roomDefaults": { "harness": "pi", "maxSummonsPerRoom": 8 },
  "agents": [
    { "ref": "monad", "role": "coordinator", "harness": "pi",
      "from": "./agents/monad" },          // bundle the coordinator if it doesn't exist
    { "ref": "gaia",  "role": "thinker",  "harness": "pi" },
    { "ref": "terry", "role": "worker",   "harness": "claude" },  // Gaia/Terry/Sidia are seeded defaults
    { "ref": "sidia", "role": "verifier", "harness": "pi" }
  ],
  "roles":  ["./roles/coordinator.md", "./roles/thinker.md", "./roles/worker.md", "./roles/verifier.md"],
  "skills": ["./skills/monad-loop"],       // setup-local skills
  "entryAgent": "monad"                     // the coordinator you talk to
}
```
Activation: `gaia setup activate fugu-trinity [room]` →
1. ensure each referenced agent exists (clone bundled ones into `.gaia/agents/`),
2. copy setup-local roles/skills onto the right search paths,
3. set `state.activeRoles` for each agent to its setup role,
4. apply `roomDefaults` to the room/workspace config,
5. seat the agents in the room.

Everything except the *loader + the `activate` verb* is already data the system
understands. That loader is the one new seam (see §5).

### Feature B — **OpenFugu-as-a-Setup** (the showcase)

Two setups, increasing in what they need from core:

**B1. the `monad` setup — 100% expressible today, zero new core.**
- 4 role markdowns (coordinator/thinker/worker/verifier) + one skill `monad-loop`
  that instructs the coordinator (the monad): summon **Gaia** (thinker) to plan/
  decompose → summon **Terry** (worker) to execute → summon **Sidia** (verifier);
  on REVISE, re-summon the worker with the critique → stop on ACCEPT or after N rounds.
- Mechanism: the existing **summon tool** (`src/tools/summon-tool.ts`,
  `summonAndWait`) is the dispatch primitive. The loop lives in the coordinator's
  skill prompt. No router weights, no new tool. This is a pure roles+skill+config
  setup and is the proof that "weird setups work through nothing but
  plugins/skills/config."

**B2. `monad-conductor` — needs ONE new seam (the honest gap).**
- A planner agent emits the 3-list DAG; an executor runs it topologically, feeding
  each step the outputs of its `access_list` predecessors.
- Today's summon is **flat/parallel fan-out**: `whales:[{agent,task}…]` returns
  each worker's reply, but there is **no way to express data-flow *between*
  summons** (step 2's prompt = step 1's output) except by the coordinator manually
  threading text. For a 5-step DAG that's brittle.
- Cleanest fix: a small **`summon_workflow` tool** (a registered tool, the same
  seam harnesses/sandboxes already use) that accepts `{model_id, subtasks,
  access_list}`, runs `ConductorExecutor`'s logic over child rooms, and returns the
  final + the per-step trace. ~100 LOC ported from `ultra.py`, reusing
  `SummonCoordinator`. Still a "plugin," but a code one, not pure config.

---

## 5. Design-flaw audit — what does NOT fit through plugins/skills/config today

The user's standard: *"if there's something we can't implement through plugins,
that's a flaw in our design."* Here are the real seams, honestly:

1. **No setup/preset loader or discovery path.** Agents/roles/skills load from
   *fixed* paths; there is no `setups/` discovery and no `activate` verb. A setup is
   pure data, but *nothing reads it yet*. → **Add a loader + CLI/API verb.** (the
   single most important seam; everything else in Feature A is already data)
2. **No bulk agent instantiation.** Agents are created one-at-a-time via CLI;
   there's no "materialize these 3 agents from a bundle." → setup activation needs a
   clone-from-template routine.
3. **No data-flow between summons.** Summon is flat fan-out; no ordered DAG with
   per-step visibility. → blocks the Conductor pattern (Feature B2) without a
   `summon_workflow` tool. **This is the one mechanism OpenFugu has that Gaia
   genuinely lacks.**
4. **Routing is a constant, not a policy.** Harness/model is fixed per agent
   (`agent.json`), chosen at config time, never per-task. OpenFugu's whole thesis is
   per-query routing. → to adopt it, "pick the worker" must become a runtime
   decision (a coordinator skill picking, or later a router tool). Not blocked, just
   absent.
5. **Roles are per-agent strings, not a shared room contract.** `state.activeRoles`
   exists but there's no notion of "this room runs the trinity protocol." The
   protocol lives only in a coordinator's prompt. Fine for v1; worth noting.

Items 1–2 are the Setup system. Item 3 is the one new tool. Items 4–5 are
philosophy gaps, not blockers. **Verdict: the design is ~90% sufficient.** The only
thing that truly can't be done through config alone is *ordered, data-passing
multi-agent workflows* (the Conductor DAG) — and that's a small registered tool, not
a core rewrite. That's a fair "flaw," and a cheap one to close.

---

## 6. Recommended phasing

- **P0 (proof, ~no core):** ship the `monad` setup as roles + a `monad-loop` skill
  using today's summon. Demonstrates the loop end-to-end and validates the
  Gaia=Thinker / Terry=Worker / Sidia=Verifier cast. Tells us if Gaia's design
  really absorbs a "weird setup" with zero core changes.
- **P1 (the real feature):** the Setup/Preset loader + `gaia setup activate`. Make
  the `monad` a one-command setup. This is the user's actual ask.
- **P2 (the missing seam):** `summon_workflow` tool (port `ConductorExecutor`),
  then a `monad-conductor` setup. Closes design-flaw #3 and unlocks ordered,
  data-passing workflows for *every* future setup, not just the monad.
- **P3 (optional, far later):** a learned/heuristic router that picks the worker per
  task instead of a fixed coordinator prompt. Only if P0–P2 show routing quality is
  the bottleneck.

---

## Appendix: source references
- OpenFugu clone (research only, not committed): scratchpad `openfugu/`
  - router + trinity loop: `openfugu/mini.py` (`FuguRouter`, `Coordinator`)
  - DAG planner + executor: `openfugu/ultra.py` (`parse_workflow`, `visible_indices`, `ConductorExecutor`)
- Gaia seams to reuse:
  - summon: `src/tools/summon-tool.ts`, `src/app/summon-coordinator.ts` (`summonAndWait`)
  - registry seam: `src/runtime/harness-registry.ts` (pattern for a new tool/harness)
  - roles/skills: `src/roles/roles.ts`, `src/skills/skill-resolver.ts`
  - room roles: `src/room/state.ts` (`activeRoles`)
  - config: `src/workspace/types.ts`, `src/agents/types.ts`
