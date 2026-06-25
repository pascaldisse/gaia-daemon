> ⚠️ **HARNESS ABSTRACTION — ABSOLUTE RULE (see [AGENTS.md](AGENTS.md) §RULE #0).** pi/claude/codex/gemini are interchangeable harnesses behind ONE abstraction. Implement every capability ONCE at the abstraction layer (harness registry / RunnerHost / runner) so it applies to ALL harnesses. NEVER special-case a harness. A harness may ONLY declare its own wiring as DATA on its spec.

# HANDOFF — Reproduce Sakana **Fugu**, subscription-only (no API)

**Fresh-context entry point.** Goal: reproduce Sakana AI's *Fugu* (the learned LLM
orchestrator served as one model) — **same architecture, lower cost: never call a
paid API, drive the frontier workers through subscription CLIs** (Claude Code,
Codex, gemini-cli). Background/spec for the engine that already exists is in
[HANDOFF-MONAD-ENGINE.md](HANDOFF-MONAD-ENGINE.md); this doc is the *Fugu-fidelity*
plan written **after reading both papers in full**.

- Papers read in full (PDFs in scratchpad of session that wrote this):
  - **TRINITY** — arXiv:2512.04695, *"TRINITY: An Evolved LLM Coordinator"* (ICLR 2026).
  - **Conductor** — arXiv:2512.04388, *"Learning to Orchestrate Agents in Natural Language with the Conductor"* (ICLR 2026).
- Same Sakana authors on both. The public `SakanaAI/fugu` repo is **100% shell**
  (it just installs the closed API into Codex: `curl … | bash; codex-fugu`); the
  method is entirely in these two papers + a tech report.
- **User decisions already locked:** target = *Fugu-equivalent quality* (no trained
  weights); Gemini via **gemini-cli**; GPT via the **codex** harness.

---

## 0. What the papers ACTUALLY say (corrections to prior summaries)

The earlier `HANDOFF-OPENFUGU-SETUPS.md` / `HANDOFF-MONAD-ENGINE.md` were built off
abstracts + a reverse-engineering writeup. Reading the papers themselves corrects
several load-bearing facts:

### 0.1 The worker pool is **7 models, identical in both papers** — not 3
TRINITY §4.1 and Conductor §4.1 use the **same pool**:

| # | Model | Type | Subscription route for us |
|---|---|---|---|
| 1 | **GPT-5** | closed | `codex` harness (or ChatGPT-in-`pi`) |
| 2 | **Gemini-2.5-Pro** | closed | `gemini-cli` harness (NEW) |
| 3 | **Claude-Sonnet-4** | closed | `claude` harness (Claude Code) |
| 4 | Gemma-3-27B-it | open | local (ollama/vllm) |
| 5 | DeepSeek-R1-Distill-Qwen-32B | open | local, or `pi` (DeepSeek) as a stand-in |
| 6 | Qwen3-32B (direct) | open | local |
| 7 | Qwen3-32B (thinking) | open | local |

The product **README** pool ("Gemini 3.1 Pro · Opus 4.8 · GPT 5.5") is the *rotated
commercial* lineup (Sakana notes it rotates ~biweekly). The **academic, reproducible**
pool is the 7 above. Our setups currently model **3 persona-slots (gaia/terry/sidia)**
— that is *not* the Fugu pool (see §2 gap A).

### 0.2 The paper itself blesses the subscription/no-API path
Two findings make "subscription-only" *faithful*, not a compromise:
- **TRINITY §4.4 ("Unleashing full power"):** after training on LiveCodeBench the
  router's selection **narrows to the three closed models**; the open models get
  pruned for hard tasks. → A **3-closed-model pool is a legitimate Fugu config.**
- **Conductor §3.2 ("Adaptive worker selection"):** they finetune over random
  *k*-subsets so the Conductor works on **closed-only OR open-only** subsets,
  explicitly so users "still harness SOTA performance with **no expensive API
  calls**." → The exact thing we want is a first-class Fugu feature.

So the pragmatic faithful core = **the 3 closed models via subscription CLIs**
(claude + codex + gemini-cli), with the 4 open models as an optional breadth tier.

### 0.3 The "you don't need the trained router" finding (de-risks all ML)
Conductor §4.5 / Fig 7: a **3B and a 7B Conductor converge to the *same* agent
distribution**; the 7B's only edge is **better prompt-engineering of subtasks**, not
better selection. → A strong *prompted* coordinator captures most of Fugu's value.
This is why **Fugu-equivalent quality needs no trained weights** (user's chosen
target). The trained brains become an optional research tier (§5).

### 0.4 Exact TRINITY spec (for fidelity of the loop)
- Coordinator = frozen **Qwen3-0.6B** + a **bias-free linear head ≈10K params** on the
  **penultimate-token hidden state**; total trainable **<20K** params.
- Head emits **L+3 logits**: L (=7) for *which model*, **3** for *which role* via an
  independent softmax → role ∈ {**Thinker, Worker, Verifier**}. **Model and role are
  two orthogonal axes chosen each turn.** (This is the crux our setups get wrong.)
- **SVF** (singular-value fine-tuning) on the backbone's **second-to-last layer**:
  learn only per-singular-value scales, freeze U/V. ~9 matrices.
- Loop: at most **K=5** turns. Each turn the coordinator builds the worker's input by
  concatenating the original query + full transcript, injects a role-specific prompt,
  dispatches one worker, appends its reply.
- Roles: **Thinker** strategizes (plans/decompose/critique; may emit subgoals AND
  *specify the role of the next agent*); **Worker** executes; **Verifier** outputs
  `u ∈ {ACCEPT, REVISE}` + optional diagnosis. **Stop** = first Verifier ACCEPT, else
  return the response at turn K.
- Worker run config: **max 4096 generated tokens, minimal reasoning effort.**
- Training: **sep-CMA-ES** (separable CMA-ES, diagonal covariance), binary terminal
  reward J(θ)=E[R(τ)], R∈{0,1}; budget 1.5k–40k evals for a ~10k-dim problem;
  λ≈32. Input format is raw `role: content` (NOT a chat template).

### 0.5 Exact Conductor (Fugu-Ultra) spec
- Coordinator = **7B**, started from **Qwen2.5-7B**, trained with **GRPO** (AdamW,
  **200 iters, batch 256, NO KL (β=0)**, G grouped completions, group-normalized
  advantage).
- Output (after a chain-of-thought) = **three equal-length Python lists**:
  `model_id` / `subtasks` / `access_list`. Example (Fig 2):
  `model_id=[2,0]`, `subtasks=["Develop an efficient algorithm…","Implement … in Python"]`,
  `access_list=[[], ["all"]]`. **`access_list` entries may be `[]`, `["all"]`, or
  index lists** of earlier steps.
- Execution: **sequential**, ≤**5 steps**, **avg ~3**. Each step's worker context =
  the prior `(subtask, response)` pairs named in its access_list, as past messages.
  Last step's output is the answer.
- **Reward = 0** (lists unparseable / format fail) **/ 0.5** (parsed but wrong) **/ 1**
  (parsed + correct).
- **Recursion:** the Conductor may name **itself** as a worker. On a recursive call it
  is fed its **own parent output + the previous agent's response**; recursion depth is
  **capped** (tunable at inference → a test-time-scaling axis). Recursion finetune:
  inject one recursion call for half the samples per batch, γ discount.
- **Task adaptivity (Fig 8):** simple tasks (MMLU) → ~2 steps; hard (LiveCodeBench) →
  3–4 steps. Beats GPT-5 avg (77.27 vs 74.78) at ~3 calls (cheaper than MoA/MASRouter).

---

## 1. Current status (verified in-tree, on `main` @ `626debe` + later commits)

The **monad engine** that Fugu sits on is built and merged. What exists, and how
close each piece is to the paper:

| Fugu piece | Gaia artifact | Fidelity |
|---|---|---|
| per-turn loop (route→dispatch→append→ACCEPT/K) | `src/app/monad-engine.ts` | ✅ faithful; K, verifier-accept stop, step-threading all present |
| routing-policy seam (swappable brain) | `src/runtime/monad/policy-registry.ts` | ✅ |
| step data-flow (`access_list` → `sees`) | engine `assembleTask`; `sees: number[] \| "all"` | ✅ engine supports `"all"`; conductor parser doesn't emit it (gap D) |
| prompt-driven router | `policies/prompt-driven.ts` | ⚠️ routes over **role-slots**, single-axis; no (model×role); no thinker role-override |
| Conductor / Fugu-Ultra | `policies/conductor-dag.ts` + `setups/fugu/` | ⚠️ runs today (no weights); **no recursion**, drops `["all"]`, slots=personas |
| TRINITY / Fugu | `policies/trinity-head.ts` + `plugins/fugu/py/route.py` | ⚠️ wired but **not runnable** (needs openfugu checkout + torch + pool-specific weights) |
| "answer as one" endpoint | `serve/openai-compatible.ts` + `gaia serve` | ⚠️ chat-completions exists; streaming/`/v1/responses` unverified |
| harnesses | `pi`, `claude`, `codex` | ❌ **no `gemini`** |
| setup/activate | `src/setups/*`, `gaia setup activate` | ✅ |

Handoff claims 233/233 tests + `tsc` clean; **not re-verified this session** (a
background instance is editing `main` — do not collide).

---

## 2. Gap analysis — current code vs the papers

**A. Slot/role collapse (the central fidelity bug).** Both `setups/fugu` and
`setups/fugu-trinity` define **3 slots = personas (gaia/terry/sidia), each pinned to
one role**. The papers' pool is **L MODELS**; role is an **orthogonal** axis chosen
per turn. The engine's `RouteDecision` already separates `agentId` from `role`, and
the head emits model-logits ⟂ role-logits — so this is a **setup + policy** fix, not
an engine change. We must model the **pool as model-bound agents** and let the policy
pick `(model, role)` independently.

**B. No Gemini harness.** Pool can't include Gemini-2.5-Pro without a `gemini-cli`
harness. Highest-leverage missing seam.

**C. Conductor recursion missing.** `conductor-dag` just replays planned steps; a step
naming the conductor slot runs it as a plain worker — it does **not** re-plan with
parent+prev context, nor depth-cap. Paper's recursion (§3.2) is unimplemented.

**D. Conductor `["all"]` access dropped.** `parseWorkflow` keeps only numeric indices
`< current`; the engine *does* support `sees:"all"`, so wiring `["all"]` through is a
small parser change.

**E. TRINITY no-ML path absent.** `trinity-head` needs weights that are
**pool-ordering-specific and unavailable** (training loop unreleased; live pool
secret). For *Fugu-equivalent quality* we need a **prompt-driven per-turn TRINITY
policy**: the loop + 3 roles + ACCEPT/REVISE + K=5 + thinker role-override, picking
`(model, role)` over the **model pool**. The existing `prompt-driven` policy is the
seed but is single-axis (role-slots) and lacks the role-override.

**F. Worker run config.** 4096 max tokens + minimal reasoning effort per worker step
(per TRINITY §4.1) is not set.

**G. Serve parity.** Sakana exposes Chat Completions + Responses; we have
chat-completions only, streaming unverified.

---

## 3. The plan (phased; "Fugu-equivalent quality", subscription-first)

> Strategy: reproduce the **architecture + pool + both orchestration modes** with
> **prompted** coordinators (no training). The papers show this captures most of the
> value. Trained brains are an optional last tier (§5).

### Phase 1 — `gemini` harness (gemini-cli)  ⟵ unblocks the pool
- Add `src/runtime/gemini-runtime.ts` mirroring `codex-runtime.ts`/`claude-runtime.ts`;
  register via `registerHarness({ id: "gemini", … })`. Wiring is **DATA on the spec**
  only (RULE #0). Reuse the same RunnerHost/runner/tool-IO bridge as the others.
- **Unknown to resolve first:** confirm gemini-cli supports **non-interactive,
  single-shot** prompting suitable for a harness runner (like Codex's app-server
  mode) — i.e. pipe a prompt in, get a completion out, with the subscription auth.
  If antigravity is the only programmatic path, fall back to it (user preferred
  gemini-cli). Spike this before building the full spec.
- Credential-proxy / sandbox: gemini steps are summons, so existing summon-policy +
  sandbox apply uniformly. Verify the subscription auth survives the sandbox.
- **Accept:** `gaia` can run a one-shot turn on a `gemini`-harness agent, no API key.

### Phase 2 — faithful **model-pool** setups (fix gap A)
Create worker agents **bound to harnesses** (one per model), roles as markdown applied
orthogonally:
- Agents (new, in `setups/<id>/agents/` → cloned on activate):
  `w-claude` (harness `claude`), `w-codex` (harness `codex`), `w-gemini` (harness
  `gemini`). [Tier-2: `w-gemma`, `w-deepseek`, `w-qwen`, `w-qwen-think` on local.]
- Roles: `worker.md` / `thinker.md` / `verifier.md` (port the paper's role contracts
  from §0.4) — applied to **whichever model** the policy picks, not pinned to a slot.
- Two setups:
  - `setups/fugu-conductor/` → policy `conductor-dag`, coordinator a strong model
    (Opus via `claude`), `maxTurns: 6` (≤5 steps + accept), pool = the model agents.
  - `setups/fugu-trinity/` (replace current) → policy `trinity-prompt` (Phase 3b),
    `maxTurns: 5`, pool = the model agents, roles orthogonal.
- **Tier-1 first:** 3 closed models (claude/codex/gemini) — legitimate per §0.2,
  zero API, zero local GPU. **Tier-2:** add 4 open models on local inference for full
  7-model parity.
- **Accept:** a query routes across **≥3 distinct harnesses**, each a real
  subscription; every step is an inspectable child room.

### Phase 3 — policy fidelity
**3a. Harden `conductor-dag`** (`src/runtime/monad/policies/conductor-dag.ts`):
- Parse `access_list` entries `[]` / `["all"]` / index-lists → emit `sees:"all"` for
  `["all"]` (gap D).
- Cap to **5 steps**; keep graceful single-worker degrade.
- **Recursion (gap C):** when a planned step targets the coordinator slot, re-invoke
  planning with the parent output + previous response in context; **depth-cap** (config
  `maxRecursion`, default 1–2) → maps to the paper's test-time-scaling axis.
- Keep weight-free (prompted conductor). Update `conductorPrompt` to the paper's
  3-list framing while still returning the engine's step objects.

**3b. New `trinity-prompt` policy** (`src/runtime/monad/policies/trinity-prompt.ts`):
- Per turn, ask the coordinator for **`{model, role, subtask}`** over the **model
  pool** (two axes, per §0.4) from the **raw `role: content` transcript** (engine
  already renders this via `renderTranscript`).
- Roles: thinker may emit a **`suggested_role`** that **overrides** the next turn's
  role (paper §3.2). Verifier → ACCEPT/REVISE; REVISE re-dispatches the **worker** with
  the diagnosis; **K=5**; stop on first ACCEPT (engine's `verifier-accept` already does
  this).
- This is **TRINITY minus the learned head** — the faithful no-ML variant. Keep
  `trinity-head` as-is for the optional trained tier (§5).

**3c. Worker run config (gap F):** thread **maxTokens=4096 + minimal reasoning** into
the summon/run for worker steps (per-agent or per-summon option).

### Phase 4 — serve-as-one parity (fix gap G)
- Harden `gaia serve <room>`: streaming, `/v1/chat/completions` (+ optionally
  `/v1/responses`), model id `"fugu"`. So any OpenAI-compatible client — even Codex
  itself — can point at it exactly like Sakana's endpoint.
- **Accept:** one endpoint returns one answer over the hidden pool; step trace visible
  underneath.

### Phase 5 — OPTIONAL trained brains (research; only if routing is the bottleneck)
- **5a. TRINITY 0.6B head:** must be **retrained on OUR pool** (released
  `model_iter_60.npy` is keyed to Sakana's secret pool ordering — unusable faithfully).
  Needs the openfugu trainer (the **sep-CMA-ES ask/tell loop is unreleased** → must be
  reconstructed), rollouts over our subscription pool, and a GPU for the 0.6B forward
  passes. Wire behind the existing `trinity-head` policy + `plugins/fugu` sidecar.
- **5b. Conductor 7B:** GRPO from Qwen2.5-7B on the 960-problem mix (MATH500/MMLU/
  RLPR/LiveCodeBench-V1), 200 iters, batch 256, no KL. Heavy.
- Both are explicitly **deferred** — §0.3 says prompted captures most value.

---

## 4. Acceptance tests (grounded in the papers)
- **Conductor:** a query yields a **≤5-step** workflow; step *t* provably consumes
  **only** its `access_list` predecessors; `["all"]` resolves to all-prior; a recursive
  step re-plans and **depth-caps**; final = last step.
- **TRINITY-prompt:** loop picks **(model, role)** each turn; **REVISE** re-dispatches
  the worker; **ACCEPT** stops; **K=5** cap honored; a **thinker `suggested_role`**
  overrides the next turn.
- **Pool:** routes across **≥3 distinct harnesses** (claude/codex/gemini), **no API
  key present** in any step.
- **Serve:** one OpenAI-compatible endpoint returns one answer; steps inspectable as
  child rooms.
- **(Optional) capability sanity:** on a handful of LiveCodeBench / GPQA items the
  orchestrated answer ≥ the best single worker — the papers' core claim.

---

## 5. Honest caveats / risks
- **"Perfect" reproduction of the *trained routers* is impossible from public
  artifacts** (TRINITY training loop unreleased; pool ordering secret; weights
  pool-specific). Achievable target = **Fugu-equivalent quality via prompted routing**
  — which the papers show captures most of the value. (User chose this.)
- **Full 7-model parity needs local compute** for the 4 open models; the **3-closed
  subscription pool** is the pragmatic faithful core (and is what the router converges
  to for hard tasks anyway).
- **gemini-cli as a programmatic harness is the main unknown** — spike non-interactive
  single-shot mode before committing to the spec.
- **Subscription latency / rate limits** differ from API; the K=5 / ≤5-step caps bound
  call counts (Conductor avg ~3 calls — cheaper than MoA/MASRouter, Fig 5).
- Do **not** special-case any harness in shared code (RULE #0). The Fugu plugin must
  remain a policy + setup + role markdown + serve adapter — if something can't be, that
  is a missing core seam: report it, don't patch core.

---

## 6. Decisions for the next agent / user
1. **Pool tier to ship first** — recommend **Tier-1 (3 closed via subscription)**;
   add Tier-2 open models later. (Confirm with user.)
2. **Where to run open models** if Tier-2 — local ollama/vllm vs `pi`/DeepSeek as a
   stand-in for R1-Distill.
3. **gemini-cli vs antigravity** — user picked gemini-cli; switch only if the spike
   shows no non-interactive mode.
4. **Reuse gaia/terry/sidia or new `w-*` agents** — recommend **new model-bound
   agents** (personas ≠ models); keep gaia/terry/sidia for the persona `monad` setup.

## Appendix: source map
- Engine + policies: `src/app/monad-engine.ts`, `src/runtime/monad/policies/*`,
  `src/runtime/monad/policy-registry.ts`, `serve/openai-compatible.ts`.
- Setups: `setups/{monad,fugu,fugu-trinity}/`; loader `src/setups/*`.
- Harnesses: `src/runtime/{pi,claude,codex}-runtime.ts`, `harness-registry.ts`.
- Fugu plugin (trained tier): `plugins/fugu/{README.md,py/route.py,py/fetch_artifacts.py}`.
- Papers (full text): arXiv:2512.04695 (TRINITY), arXiv:2512.04388 (Conductor).
</content>
</invoke>
