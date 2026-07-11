# TODO

## 2026-07-11 — from People of Pi
- Next Pi release: dynamic tool loading without cache wiping, on supported
  models/providers. They found a way to get somewhat consistent API behavior
  between OpenAI and Anthropic (thanks to @zeeg for pushing). Watch for this
  landing upstream — relevant to our harness abstraction (`src/harness/`) once
  it does, per Rule #0 (uniform, data-on-spec, no per-harness branches).
- Action: review our own token usage in general.
