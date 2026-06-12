# Apple Silicon Port Plan

## Goal

Run Unmute natively on Apple Silicon without Docker/CUDA while preserving the
existing browser frontend and Python backend as much as possible.

The target stack is:

- Next.js frontend running locally on macOS
- Python 3.12 FastAPI backend running locally on macOS
- local OpenAI-compatible LLM server, initially llama.cpp/Qwen
- STT through Moshi/Candle on Metal
- TTS through an MLX adapter that speaks Unmute's existing TTS protocol

## Ground Truth

Unmute's STT and TTS workers are not symmetric.

STT uses `services/moshi-server/configs/stt.toml` with:

```toml
[modules.asr]
type = "BatchedAsr"
```

This is a Rust/Candle path. Candle has a Metal backend, and community work shows
`moshi-server` STT can run on Apple Silicon with the same websocket/msgpack
endpoint. Treat this as low risk, but verify locally.

TTS uses `services/moshi-server/configs/tts.toml` with:

```toml
[modules.tts_py]
type = "Py"
```

This embeds the Python/PyTorch TTS path. Building `moshi-server` with the Cargo
`metal` feature is not enough to make this path run on Apple GPU. The practical
Apple Silicon TTS route is Kyutai's MLX implementation from
`delayed-streams-modeling`, wrapped in a compatibility server.

## Protocol Contracts

Any replacement worker must preserve the backend contracts.

### STT

Backend sends msgpack:

- `Audio` with `pcm`
- `Marker` with `id`

Backend expects msgpack:

- `Ready`
- `Error`
- `Word`
- `EndWord`
- `Step`
- `Marker`

Reference: `unmute/stt/speech_to_text.py`.

### TTS

Backend sends msgpack:

- `Text`
- `Voice`
- `Eos`

Backend expects msgpack:

- `Ready`
- `Error`
- `Audio`
- `Text`

Reference: `unmute/tts/text_to_speech.py`.

## Phase 1: Mac-Local Run With Stub TTS

Objective: prove the existing frontend/backend loop runs natively on macOS with
real STT, local Qwen LLM, and a silent TTS worker.

Planned additions:

- `macos/start_frontend.sh`
- `macos/start_backend.sh`
- `macos/start_llm.sh`
- `macos/start_stt_metal.sh`
- `macos/start_tts_stub.sh`
- `macos/README.md`
- `unmute/tts_stub_server.py`

Expected environment:

- Python 3.12 available through `uv`
- Cargo available
- Node plus pnpm available
- `llama-server` available for the local Qwen GGUF
- Hugging Face token available if model downloads require it

Phase 1 tasks:

1. Create macOS-native run scripts replacing the CUDA dockerless scripts.
2. Run the frontend locally.
3. Run the backend locally with:

```bash
KYUTAI_STT_URL=ws://localhost:8090
KYUTAI_TTS_URL=ws://localhost:8089
KYUTAI_LLM_URL=http://localhost:8080
KYUTAI_LLM_MODEL=local-model
```

4. Start local Qwen through `llama-server`.
5. Build/run Moshi STT with Metal and verify `/api/asr-streaming` emits real
   `Word` and `Step` messages.
6. Implement a silent TTS stub at `/api/tts_streaming` that emits `Ready`,
   accepts `Text` and `Eos`, and returns placeholder/silent `Audio` plus optional
   `Text` timing messages.
7. Verify the browser can connect, speech can be transcribed, the LLM can reply,
   and the backend completes the turn without real speech output.

Exit criteria:

- Documented macOS startup sequence exists.
- `/v1/health` reports STT, TTS, and LLM up.
- Real microphone input reaches the backend as transcript deltas.
- A user turn reaches the LLM and completes through the silent TTS stub.

## Phase 2: MLX TTS Adapter

Objective: replace the silent TTS stub with real Apple Silicon TTS while keeping
the Unmute backend unchanged.

Planned additions:

- `unmute/tts_mlx_adapter.py`
- `macos/start_tts_mlx.sh`
- `macos/README.md` updates
- focused tests or protocol smoke scripts for the TTS adapter

Phase 2 tasks:

1. Install and verify Kyutai MLX TTS can generate audio locally.
2. Wrap MLX TTS in a websocket server at `/api/tts_streaming`.
3. Implement Unmute-compatible msgpack handling for `Text`, `Voice`, and `Eos`.
4. Emit `Ready`, streaming `Audio`, and synchronized `Text` messages.
5. Tune chunk size and buffering for low latency.
6. Ensure interruption/connection close behavior does not deadlock the backend.

Exit criteria:

- The backend receives real audio from the MLX TTS adapter.
- The browser plays assistant speech.
- Text deltas and audio timing are close enough for normal conversation.
- Interrupting assistant speech does not leave stale adapter tasks running.

## Risks

- `moshi-server --features metal` may need local build patches even for STT.
- The community Apple STT installer may not match this repo's exact model/config
  versions.
- MLX TTS may not stream in the same granularity as Unmute expects; buffering may
  need adapter-level tuning.
- Voice cloning/custom voice support should be considered out of scope until base
  TTS works.
- The Python backend requires Python 3.12; local setup may need `uv` cache and
  Python install permissions.

## Non-Goals

- Do not port Docker Compose to macOS.
- Do not make CUDA containers run under emulation.
- Do not spend time trying to make Unmute's current `type = "Py"` TTS
  `moshi-server` worker run on Metal.
- Do not modify `Soul-of-Waifu`.
