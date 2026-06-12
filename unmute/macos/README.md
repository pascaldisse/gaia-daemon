# macOS Phase 1 Runbook

This folder contains native macOS startup scripts for the Phase 1 Apple Silicon
port. The goal is to run the existing Unmute frontend/backend with:

- local Gemma 3 1B through llama.cpp
- Moshi STT built with Metal
- a silent TTS stub that preserves Unmute's websocket/msgpack TTS contract

Run each service in its own terminal from the repo root.

## Ports

| Service | Port | Script |
| --- | ---: | --- |
| Frontend | 3000 | `macos/start_frontend.sh` |
| Backend | 8000 | `macos/start_backend.sh` |
| LLM | 8080 | `macos/start_llm.sh` |
| STT | 8090 | `macos/start_stt_metal.sh` |
| TTS stub | 8089 | `macos/start_tts_stub.sh` |
| TTS MLX | 8089 | `macos/start_tts_mlx.sh` |

## Startup Order

```bash
macos/start_llm.sh
macos/start_tts_stub.sh
macos/start_stt_metal.sh
macos/start_backend.sh
macos/start_frontend.sh
```

Then open:

```text
http://localhost:3000
```

## Environment

The backend script exports:

```bash
KYUTAI_STT_URL=ws://localhost:8090
KYUTAI_TTS_URL=ws://localhost:8089
KYUTAI_LLM_URL=http://localhost:8080
KYUTAI_LLM_MODEL=gemma-3-1b-it
```

The LLM script defaults to Gemma 3 1B Instruct via llama.cpp's Hugging Face
loader:

```text
gguf-org/gemma-3-1b-it-gguf:Q4_K_M
```

Override any default in the shell before running a script, for example:

```bash
LLAMA_PORT=8081 KYUTAI_LLM_MODEL=gemma-local macos/start_llm.sh
MODEL_PATH=/path/to/model.gguf KYUTAI_LLM_MODEL=qwen-local macos/start_llm.sh
```

## Dependencies

Required locally:

- `uv`
- `cargo`
- Node.js, preferably Homebrew Node on macOS
- `pnpm`
- `llama-server`

The STT script installs `moshi-server@0.6.4` with the Cargo `metal` feature if a
`moshi-server` binary is not already on PATH. It may need
`HUGGING_FACE_HUB_TOKEN` for model downloads.

The backend, STT, and TTS stub scripts keep `uv` state inside the repo by
default:

```bash
UV_CACHE_DIR=.uv-cache
UV_PYTHON_INSTALL_DIR=.uv-python
```

The frontend script prepends `/opt/homebrew/bin` to `PATH` so Next.js uses
Homebrew Node instead of a signed app-bundled Node binary. This avoids native
SWC loading failures caused by macOS library validation.

## Phase 1 Limitations

The TTS service is intentionally silent. It exists to prove the end-to-end
Unmute loop and keep the backend protocol unchanged. Real speech output belongs
to Phase 2, where this stub will be replaced by an MLX TTS adapter.

## Phase 2 MLX TTS

To use real Apple Silicon TTS, start `macos/start_tts_mlx.sh` instead of
`macos/start_tts_stub.sh`:

```bash
macos/start_llm.sh
macos/start_tts_mlx.sh
macos/start_stt_metal.sh
macos/start_backend.sh
macos/start_frontend.sh
```

The MLX TTS service loads model weights at startup before `/api/build_info`
reports healthy. First launch downloads the Kyutai TTS checkpoints and can take
several minutes.

Useful TTS environment variables:

```bash
KYUTAI_TTS_MLX_QUANTIZE=8
KYUTAI_TTS_MLX_VOICE=expresso/ex03-ex01_happy_001_channel1_334s.wav
KYUTAI_TTS_MLX_REPO=kyutai/tts-1.6b-en_fr
KYUTAI_TTS_MLX_VOICE_REPO=kyutai/tts-voices
KYUTAI_TTS_MLX_COALESCE_SEC=0.12
KYUTAI_TTS_MLX_MIN_WORDS=4
```

`KYUTAI_TTS_MLX_COALESCE_SEC` and `KYUTAI_TTS_MLX_MIN_WORDS` control how many
incoming LLM word chunks the adapter batches before feeding MLX. Higher values
can improve throughput but delay first audio; lower values can start sooner but
may stutter more on Apple Silicon.
