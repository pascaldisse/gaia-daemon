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
- voice calls (call button per agent) run through unmute with GAIA as the
  LLM; spoken turns are normal agent turns in the same room transcript

## Voice mode (shipped)

The unmute stack (`/Users/pascaldisse/projects/Codex/AIWaifu/unmute`) handles
mic → STT → LLM → TTS → speaker with VAD, pause prediction, and barge-in.
GAIA is the brain: the web server exposes an OpenAI-compatible
`/v1/chat/completions` + `/v1/models` shim (`KYUTAI_LLM_URL` points at GAIA),
so every spoken turn is a normal agent turn — same room, same Pi session,
same model, tools included.

- [x] chat-completions streaming shim bound to one agent + room
      (call button → `POST /api/workspaces/:id/voice/start`); built on the
      controller, so turns land in the transcript and stream over SSE
- [x] abort on client disconnect → cancel the active task (unmute barge-in
      interruption works end-to-end)
- [x] unmute's synthetic turns are recognized (`"Hello."` greeting, `"..."`
      silence marker) and become agent prompts, not fake user messages
      (src/app/voice-bridge.ts)
- [x] voice-mode overlay in the turn prompt (no session reload): short
      spoken prose, no markdown/emojis, transcription-error tolerance
- [x] voice turns persist with `channel: "voice"` (🎙 marker in the UI)
- [x] in-UI voice client (web/src/voice.ts + web/vendor/): call button next
      to each agent, opus mic capture → unmute WebSocket, TTS playback via
      the jitter-buffer worklet, buffer flush on `unmute.interrupted_by_vad`
- [x] live STT transcription rendered in the composer text box, cleared
      when the spoken turn commits to the room
- [x] agent `voice` field is sent as the unmute session voice
- [x] on-call indicators (agent row, topbar) synced across tabs via the
      `voice-status` SSE event
- [x] zero-setup lifecycle (src/app/voice-stack.ts): dialing auto-starts
      missing services (probed via `/api/build_info` and `/v1/health`, so a
      foreign process on a port triggers a free-port fallback instead of a
      false positive), startup progress streams to the topbar, hang-up stops
      exactly the services GAIA spawned; logs in `~/.gaia/logs/voice/`;
      exit hooks prevent orphans across dev restarts
- [x] voice settings file `~/.gaia/voice.json` with its own Voice tab in
      global settings (boolean/number hints): unmuteUrl, unmuteDir,
      autoStart, startTimeoutSec, speakOnSilence, silenceDelaySec,
      disableThinking
- [x] silence nudges are controllable: speakOnSilence off answers unmute's
      "..." turns with an empty completion, and the delay flows to the
      backend via KYUTAI_USER_SILENCE_TIMEOUT (env-configurable in the
      unmute fork, unmute_handler.py)
- [x] thinking control: voice calls force thinking off (restored on
      hang-up); the composer shows a clickable `💭 #level` indicator that
      cycles levels - persisted to agent.json outside calls, call-scoped
      during them (POST /api/workspaces/:id/agents/:agentId/thinking)

### Voice follow-ups

- [ ] editable transcription: click the composer before the turn
      auto-commits to correct the STT text by hand (needs unmute-side
      commit control — investigate `input_audio_buffer` events)
- [ ] on interruption, record the truncated text actually spoken — keep the
      agent's view of the conversation aligned with what the user heard
      (today the interrupted turn is dropped entirely, matching text cancel)
- [ ] TTS-ignored spans (e.g. tool-call narration tags) so long tool turns
      can say something short while the full text shows in the room
- [ ] measure turn latency through Pi (prompt assembly + TTFT); target
      first text delta well under ~500ms
- [ ] voice-driven agent switching ("let me talk to Sidia") via the
      deterministic router; multi-agent voice stays out of scope — the
      one-task-per-room constraint enforces one speaker at a time

### Ongoing hygiene

- [ ] server/API tests around `src/web/server.ts`
- [ ] light browser-side smoke coverage for the split `web/src/` modules
- [ ] keep README and these notes aligned with shipped behavior

## Known simplifications

- Pi is the only runtime
- one active task per room (intentional: matches one-speaker voice semantics)
- no frontend bundler (deliberate; direct-served ES modules)
