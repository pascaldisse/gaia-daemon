# Fugu plugin — replicating Sakana Fugu 1-1 on the monad engine

This is the acceptance target for the monad engine: **reproduce OpenFugu (the
open reverse-engineering of Sakana AI's Fugu) using nothing but a routing policy
+ a setup + role files + a serve adapter** — no changes to core gaia-daemon.

Fugu is an **LLM router**, not a role framework. It has two variants, and each
maps onto one registered `RoutingPolicy`:

| Fugu variant | what it is | GAIA policy | setup |
|---|---|---|---|
| **Fugu / TRINITY** (arXiv:2512.04695) | frozen Qwen3-0.6B + a tiny bias-free linear head on the penultimate hidden state (SVF, <20K params, trained by sep-CMA-ES). Picks one of L workers **and** a role ∈ {Worker, Thinker, Verifier} **each turn**; loops until a Verifier ACCEPTs or K=5. | `trinity-head` (shells out to `py/route.py`, which wraps `openfugu/mini.py`'s `FuguRouter`) | `setups/fugu-trinity/` |
| **Fugu-Ultra / Conductor** (arXiv:2512.04388) | a 7B model (GRPO-trained) emits a whole workflow as three equal-length lists `model_id` / `subtasks` / `access_list`, run **sequentially with selective visibility**. Can recurse. | `conductor-dag` (plans on turn 0, replays one step/turn, wires `sees` from the access_list) | `setups/fugu/` |

The **de-risking finding** from the Conductor paper: the 7B beats a 3B "by better
NL subtask prompting, not better agent selection." So the no-weights
`conductor-dag` (and even the core `prompt-driven`) policy captures most of the
value. That is why `setups/fugu/` runs **today**, with zero ML.

## The 1-1 map (every box is a policy / setup field / markdown / serve plugin — nothing in core)

| Fugu component | supplied by |
|---|---|
| per-turn loop (route → dispatch → append → until ACCEPT/K) | the core **MonadEngine** (`src/app/monad-engine.ts`) — this *is* the engine |
| routing policy (0.6B head / Conductor-DAG) | a registered **RoutingPolicy** (`trinity-head` / `conductor-dag`) |
| roles Worker / Thinker / Verifier | role markdown (`roles/*.md` in each setup) |
| worker pool → providers | `monad.slots` in `setup.json` (each slot → a gaia agent, with its own harness/model/trust/sandbox) |
| Verifier ACCEPT/REVISE stop, K turns | `monad.terminate` + `monad.maxTurns` |
| Conductor `access_list` data-flow | the engine's step-threading (`sees`); the `conductor-dag` policy fills it |
| recursion (Conductor names itself) | a planned step may target the coordinator slot — falls out of the policy |
| "answer as one" OpenAI endpoint | the **ServeAdapter** seam + `gaia serve` (core); `openai-compatible` adapter |
| trained weights (`model_iter_60.npy`, 7B) | this plugin's `py/` sidecar + `fetch_artifacts.py` |

If anything here could NOT be expressed as a policy/setup/markdown/serve plugin,
that would be a missing core seam — report it instead of patching core.

## Run the Conductor variant (no weights)

```sh
gaia setup activate fugu            # into the workspace's current room
gaia serve default --port 8799      # expose it as one OpenAI-compatible model
# POST http://127.0.0.1:8799/v1/chat/completions  → one final answer
```

Every step runs as a real summon (an inspectable child room): "answer as one" on
the outside, full visibility underneath.

## Run the TRINITY variant (needs the trained head)

The 0.6B head is torch/Python, so core stays TS and the brain lives in a sidecar.

1. Clone the reverse-engineering and point the sidecar at it:
   ```sh
   git clone https://github.com/trotsky1997/openfugu ~/.gaia/plugins/fugu/openfugu
   pip install torch transformers numpy        # the sidecar's deps, never GAIA's
   ```
2. Provide the trained head weights (train via openfugu, or drop a release artifact):
   ```sh
   FUGU_WEIGHTS_URL=<artifact-url> python3 plugins/fugu/py/fetch_artifacts.py
   # → ~/.gaia/plugins/fugu/model_iter_60.npy
   ```
3. Edit `setups/fugu-trinity/setup.json` → `monad.policyConfig.script` to an
   **absolute** path to `plugins/fugu/py/route.py` (it is spawned with cwd =
   wherever `gaia` runs), then:
   ```sh
   gaia setup activate fugu-trinity
   gaia serve default
   ```

The sidecar contract is one JSON line on stdout — `{"agent_id":<int>,"role_id":<int>}`
— exactly `FuguRouter.route(transcript)`. The TS mapping
(`decisionFromRouter`, unit-tested) turns that into the next step.

**Two head variants:** production Fugu drops the 3 role logits (L-only head);
academic TRINITY keeps L+3. Toggle with `policyConfig.roles: "on" | "off"`.

## Licensing

OpenFugu (`mini.py` / `ultra.py`) and the base model are Apache/Llama-licensed and
are **not vendored** here — the plugin points at your own checkout. Only the thin
sidecar wrapper and the setups live in this repo.
