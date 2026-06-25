# Skill: monad-loop

Run a **dynamic** Thinker → Worker → Verifier loop over summons until the Verifier
ACCEPTs (max 5 rounds). Answer the user as one; only surface the final accepted result.

Each round, decide who should act next from the current state, then summon them with
the `summon` tool (`summon(agent, task)` — put the role and the needed context in the
task text):

1. Summon **@gaia** (thinker) to plan/decompose the query.
2. Summon **@terry** (worker) to do the work, passing the plan and any prior results.
3. Summon **@sidia** (verifier) to check the worker's result.
   - If Sidia's reply starts with **ACCEPT** → stop; return the worker's last result.
   - If **REVISE** → summon **@terry** again with Sidia's critique. Re-summon **@gaia**
     instead if the *plan itself* is wrong.
4. Stop after 5 rounds regardless; return the best worker result.

**Dynamic routing is the point:** choose the next role from state — skip the Thinker on
a trivial query, or loop Worker↔Verifier several times. The order above is the default,
not a rule.

This is the prompt-driven monad: it needs no engine code, only this skill + the role
files + the existing summon tool. The core `MonadEngine` (see HANDOFF-MONAD-ENGINE.md)
turns this same loop into a first-class, policy-swappable mechanism.
