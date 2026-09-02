# REFACTOR live queue

## A1 ToolProviders bridge

- owner: root live slot
- repro: launch compiled daemon → summon Pi agent with `gaia` tool → invoke `{verb:"caryll",args:{action:"stats",path:"README.md"},raw:true}` → expect `真 caryll.stats`; invoke `{verb:"web",args:{url:"not a url"},raw:true}` → expect `ERROR: invalid url: not a url`; invoke `artifact create`/`artifact read` → payload round-trip.
- verify: runner → `/api/harness/tools` bearer bridge → daemon-injected `ToolProviders`; no harness→services imports.
