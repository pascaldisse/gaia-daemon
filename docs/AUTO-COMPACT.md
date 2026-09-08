# Auto-compaction

§Default → 180000 used tokens, cooldown1 completed turn; every model; no per-model table.
§Scope → shared room scheduler; native `runtime.compact`; no harness-id branches.
§Capacity → true model contextWindow/reserveTokens unchanged; smaller-model native safety unchanged.

§Config → `~/.gaia/config.json` global; `<workspace>/.gaia/config.json` override

```json
{
  "autoCompact": {
    "thresholdTokens": 180000,
    "cooldownTurns": 1,
    "modelOverrides": {
      "provider-id": {
        "exact-model-id": { "thresholdPct": 75, "cooldownTurns": 2 },
        "another-model-id": { "thresholdTokens": 160000 }
      }
    }
  }
}
```

§Precedence → global/workspace default merge → merged exact-provider/model patch → explicit room policy.
- Threshold pair atomic per layer; pct-only replaces inherited tokens; tokens-only replaces inherited pct.
- Both numeric → tokens wins. Either threshold alone `null` → off at that layer.
- Model patch may enable a disabled default; room off wins over every model patch.
- Cooldown independent; partial model patches merge by exact keys; no aliases/prefix matching.
- Invalid fields → inherited value; tokens positive safe integer; pct0–100; cooldown integer≥0.
- New workspace scaffold → no pinned autoCompact; runtime/global inheritance. Existing explicit-off files unchanged.
- Identity → shared `AgentRuntime.effectiveModel` (latest native report); fallback configured provider+name only when both known; no display-label parsing.

§Room commands
- `/autocompact` → effective active-agent policy + threshold/cooldown source.
- `/autocompact 180k` or `/autocompact 180000 tokens` → absolute mode.
- `/autocompact 75 2` → percentage75, cooldown2.
- `/autocompact off` → room off, including inherited model rules.
- Optional final cooldown for either mode; changed policy clears pending passes/cooldowns; omitted cooldown preserves override/inheritance.
- No room-reset-to-inherit command; explicit room policy persists.

§Boundary ≠ hard token cap
- Successful whole-turn completion → compare last reported usedTokens → durable per-agent pending marker.
- Agent's next turn → consume marker → same native compaction/floor path as `/compact` → assemble prompt.
- Tool loops/streaming → no mid-turn threshold interrupt;180000 may be exceeded inside one turn.
- Cancelled/failed turns → no new schedule; native safety remains independent.
- Missing maxTokens → token mode still schedules; percentage mode requires capacity.
- Native compaction unsupported/failure → existing `/compact` behavior; durable marker consumption not atomic with provider operation.

§Deployment → source ≠ running compiled daemon; Pascal reload required. No worker restart/global writes.
