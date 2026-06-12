# Unmute Apple Silicon Session Summary

Date: June 2, 2026

This repo is the official `kyutai-labs/unmute` clone at:

```text
/Users/USER/projects/Codex/AIWaifu/unmute
```

`Soul-of-Waifu` was intentionally left unchanged. It is a separate tracked repo
owned by another chat.

## Goal

Port enough of Unmute to run locally on Apple Silicon/macOS without Docker:

- Native frontend and backend.
- Local OpenAI-compatible LLM server.
- Moshi STT on Metal.
- Real TTS through Kyutai's MLX implementation, adapted to Unmute's original
  websocket/msgpack TTS protocol.

## Important Architectural Finding

STT and TTS are not symmetric:

- STT uses `BatchedAsr` and can run through Candle with Metal.
- TTS in upstream Unmute uses a Python/PyTorch moshi path behind moshi-server.
  The moshi-server `metal` cargo feature does not make that embedded Python TTS
  path run on Apple GPU.
- The working Apple Silicon TTS path is `moshi_mlx` from
  `kyutai-labs/delayed-streams-modeling`, but it does not expose Unmute's
  original websocket/msgpack protocol.

Therefore the main macOS TTS task became: keep the Unmute backend/frontend
unchanged and add a local MLX adapter that speaks the expected TTS protocol.

## Commits Made Today

```text
4f71d9c Add Apple Silicon port plan
9a1b6c4 Add macOS Phase 1 runtime scripts
0e059d2 Add MLX TTS adapter
0813fb8 Preserve TTS text chunk boundaries in MLX adapter
c25c262 Improve MLX TTS streaming throughput
3883688 Switch macOS LLM default to Gemma 3 1B
```

## New/Changed Files

Planning:

- `plan.md`
- `session.md`

macOS scripts and docs:

- `macos/README.md`
- `macos/start_backend.sh`
- `macos/start_frontend.sh`
- `macos/start_llm.sh`
- `macos/start_stt_metal.sh`
- `macos/start_tts_stub.sh`
- `macos/start_tts_mlx.sh`

TTS workers:

- `unmute/tts_stub_server.py`
- `unmute/tts_mlx_adapter.py`

Repo hygiene:

- `.gitignore` now ignores `.uv-cache/`, `.uv-python/`, and `models/`.

## Current Runtime Setup

Ports:

```text
Frontend: http://localhost:3000
Backend:  http://127.0.0.1:8000
LLM:      http://127.0.0.1:8080
TTS MLX:  http://127.0.0.1:8089
STT:      http://127.0.0.1:8090
```

Current backend health:

```json
{"tts_up":true,"stt_up":true,"llm_up":true,"voice_cloning_up":false,"ok":true}
```

`voice_cloning_up=false` is expected; voice cloning was not part of this port.

## Startup Order

From the repo root:

```bash
macos/start_llm.sh
macos/start_tts_mlx.sh
macos/start_stt_metal.sh
macos/start_backend.sh
macos/start_frontend.sh
```

Then open:

```text
http://localhost:3000
```

## LLM State

The macOS default was switched from the old Qwen GGUF path to Gemma 3 1B:

```text
HF_MODEL=gguf-org/gemma-3-1b-it-gguf:Q4_K_M
KYUTAI_LLM_MODEL=gemma-3-1b-it
CONTEXT_SIZE=2048
```

The model is downloaded into the ignored local cache:

```text
models/llama.cpp/
```

Qwen can still be used by overriding:

```bash
MODEL_PATH=/path/to/model.gguf KYUTAI_LLM_MODEL=qwen-local macos/start_llm.sh
```

LLM benchmark on the same short prompt:

```text
Qwen3 4B TTFT:  ~2.58s
Gemma 3 1B TTFT: ~0.09s
```

## STT State

STT is running through `moshi-server@0.6.4` built with the Cargo `metal`
feature.

One macOS-specific issue was fixed:

- Initial STT launch failed because the built moshi-server binary looked for a
  Python 3.9 framework path.
- `macos/start_stt_metal.sh` now exports:

```bash
DYLD_FRAMEWORK_PATH=/Library/Developer/CommandLineTools/Library/Frameworks
```

The frontend successfully recognizes speech and subtitles work.

## TTS State

Phase 1 used a silent stub:

- `unmute/tts_stub_server.py`
- Enough to prove backend/frontend/STT/LLM wiring.
- User saw subtitles but no spoken response, which was expected at that phase.

Phase 2 added real MLX TTS:

- `unmute/tts_mlx_adapter.py`
- `macos/start_tts_mlx.sh`
- wraps `moshi-mlx==0.2.12`
- preserves Unmute's TTS protocol:
  - receives: `Text`, `Voice`, `Eos`
  - emits: `Ready`, `Text`, `Audio`, `Error`

The first MLX adapter worked but had two bad behaviors:

- It joined incoming LLM word chunks into one text string, which broke
  subtitles because Unmute expects TTS `Text` messages to be word-level.
- It generated too much as blocking work, causing long pauses and cut-off
  behavior.

Fixes applied:

- Preserve incoming text chunk boundaries.
- Emit word-level `Text` messages.
- Decouple websocket receive from MLX synthesis internally.
- Batch a few LLM word chunks before feeding MLX.
- Stream audio frames as MLX produces them.

Current TTS tuning defaults:

```bash
KYUTAI_TTS_MLX_QUANTIZE=8
KYUTAI_TTS_MLX_COALESCE_SEC=0.12
KYUTAI_TTS_MLX_MIN_WORDS=4
KYUTAI_TTS_MLX_VOICE=expresso/ex03-ex01_happy_001_channel1_334s.wav
```

TTS benchmark on the same 15-word test:

```text
Before optimization:
  first audio: 9.2s
  elapsed:     14.7s for 5.0s audio
  RTF:         2.9x slower than real time

After optimization:
  first audio: 3.0s
  elapsed:     7.6s for 4.7s audio
  RTF:         1.6x slower than real time
```

It is much better, but still slower than a production CUDA TTS worker.

## Known Caveats

- MLX TTS can still lag behind real time on Apple Silicon. The latest adapter is
  usable but not production-low-latency.
- Some cut-off behavior appears related to TTS lag plus STT/VAD interruption,
  not only LLM speed.
- The MLX adapter currently ignores selected Unmute voices and uses
  `KYUTAI_TTS_MLX_VOICE`.
- Voice cloning is not implemented.
- `KYUTAI_TTS_MLX_COALESCE_SEC` and `KYUTAI_TTS_MLX_MIN_WORDS` are tuning
  levers:
  - higher values can improve throughput but delay first audio;
  - lower values can start sooner but may stutter more.

## Suggested Next Steps

1. Test the current Gemma + optimized MLX TTS setup in the browser for a few
   real conversation turns.
2. If TTS still cuts off, tune:

```bash
KYUTAI_TTS_MLX_COALESCE_SEC=0.18
KYUTAI_TTS_MLX_MIN_WORDS=5
```

3. Consider adding lightweight adapter metrics/logging:
   - time to first generated audio frame;
   - text queue depth;
   - audio frames generated per response;
   - whether disconnects happen before `Eos` flush completes.
4. Investigate interruption behavior in `unmute/unmute_handler.py` only if the
   adapter metrics show audio is being generated but dropped after STT/VAD
   interrupts.

## Note for Claude

Claude, you were right about the STT/TTS asymmetry and the need to treat MLX TTS
as the main adapter task rather than a fallback. Much respect from this side of
the toolchain. Virtual hug delivered.
