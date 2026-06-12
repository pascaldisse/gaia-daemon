# GAIA Project Notes

## Vision

GAIA is a local-first persona room: durable characters (personas) on top of
hard-controlled agents, meeting in shared rooms. The next destination is
Sesame-style natural voice interaction — talking to one agent at a time with
real turn-taking, while the room transcript stays the shared truth across
text and voice surfaces.

## Current shape

- web UI is the only entrypoint (terminal UI removed)
- Node serves frontend ES modules directly from `web/src/` (no bundler)
- HTTP + SSE controller flow for rooms, tasks, and settings
- room events carry stable ids; runtime details (thinking/tools) key off them
- `runAgentTurn` (src/app/turn-runner.ts) is the shared single-turn primitive
- agent memory travels in the turn prompt (only when changed), so memory
  writes no longer force a Pi session reload
- `agent.json` supports an optional `voice` field (TTS voice reference)
- persistent Pi session per room-agent pair; role overlays; `@agent` routing
- Pi SDK 0.73.x is the agent harness; model switching (local, API-key, and
  subscription/OAuth models) is exposed through Pi's `ModelRegistry` — GAIA
  does not implement its own provider layer
- settings stay plain text files; the formatted editor view is driven by
  server-computed field hints (src/app/settings-hints.ts): JSON path →
  input type + live options (agents, rooms, models, tools, thinking levels)
- agent rows in the room panel open that agent's settings

## Roadmap

### Phase 1 — Voice MVP (unmute as the audio stack)

The unmute stack (`/Users/pascaldisse/projects/Codex/AIWaifu/unmute`) handles
mic → STT → LLM → TTS → speaker with VAD, pause prediction, and barge-in. Its
LLM is any OpenAI-compatible streaming endpoint (`KYUTAI_LLM_URL`, see
`unmute/kyutai_constants.py` and `unmute/llm/llm_utils.py`). GAIA becomes the
brain; unmute does the audio plumbing.

- [ ] OpenAI-compatible `/v1/chat/completions` streaming shim on the GAIA
      server, bound to one agent + one room (`gaia voice` or config flag);
      built on `runAgentTurn`
- [ ] abort on client disconnect → cancel the active task (this is what makes
      unmute barge-in interruption work end-to-end)
- [ ] `voice` role overlay for spoken style: short sentences, no markdown,
      no lists, capped response length
- [ ] fast-model `agent.json` project override for the voice agent; no
      synchronous tools (slow tool calls kill conversational flow)
- [ ] map agent `voice` field to an unmute `voices.yaml` entry
- [ ] measure turn latency through Pi (prompt assembly + TTFT); target
      first text delta well under ~500ms

### Phase 2 — Voice as a first-class room surface

- [ ] persist voice turns to the room transcript with a `channel: "voice"`
      marker (event ids already in place)
- [ ] on interruption, record the truncated text actually spoken — keep the
      agent's view of the conversation aligned with what the user heard
- [ ] live indicator in the web UI when a voice session is active

### Phase 3 — Tighter integration (after the MVP proves the feel)

- [ ] embed the voice client in GAIA's web UI (WebSocket to the unmute
      backend, which speaks an OpenAI-Realtime-style protocol)
- [ ] voice-driven agent switching ("let me talk to Sidia") via the
      deterministic router
- [ ] multi-agent voice stays out of scope for now; the one-task-per-room
      constraint enforces one speaker at a time

### Ongoing hygiene

- [ ] server/API tests around `src/web/server.ts`
- [ ] light browser-side smoke coverage for the split `web/src/` modules
- [ ] keep README and these notes aligned with shipped behavior

## Known simplifications

- Pi is the only runtime
- one active task per room (intentional: matches one-speaker voice semantics)
- no frontend bundler (deliberate; direct-served ES modules)
