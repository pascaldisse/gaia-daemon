import asyncio
import logging
from typing import Any

import msgpack
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

SAMPLE_RATE = 24_000
SAMPLES_PER_FRAME = 1_920
DEFAULT_CHARS_PER_SECOND = 14
TRAILING_SILENCE_SEC = 0.24

logger = logging.getLogger(__name__)
app = FastAPI()


@app.get("/")
async def root() -> dict[str, str]:
    return {"service": "unmute-tts-stub", "status": "ok"}


@app.get("/api/build_info")
async def build_info() -> dict[str, str]:
    return {
        "service": "unmute-tts-stub",
        "backend": "silent",
        "status": "ok",
    }


def pack(message: dict[str, Any]) -> bytes:
    return msgpack.packb(message, use_bin_type=True, use_single_float=True)


def unpack(data: bytes) -> dict[str, Any]:
    message = msgpack.unpackb(data, raw=False)
    if not isinstance(message, dict):
        raise ValueError(f"Expected msgpack dict, got {type(message)!r}")
    return message


def estimate_duration(text: str) -> float:
    stripped = text.strip()
    if not stripped:
        return TRAILING_SILENCE_SEC
    return max(0.18, min(1.2, len(stripped) / DEFAULT_CHARS_PER_SECOND))


def silent_pcm(duration_sec: float) -> list[float]:
    samples = max(SAMPLES_PER_FRAME, int(duration_sec * SAMPLE_RATE))
    samples = ((samples + SAMPLES_PER_FRAME - 1) // SAMPLES_PER_FRAME) * SAMPLES_PER_FRAME
    return [0.0] * samples


async def send_text_and_silence(
    websocket: WebSocket,
    text: str,
    cursor_sec: float,
) -> float:
    duration_sec = estimate_duration(text)
    await websocket.send_bytes(
        pack(
            {
                "type": "Text",
                "text": text,
                "start_s": cursor_sec,
                "stop_s": cursor_sec + duration_sec,
            }
        )
    )
    await websocket.send_bytes(pack({"type": "Audio", "pcm": silent_pcm(duration_sec)}))
    return cursor_sec + duration_sec


@app.websocket("/api/tts_streaming")
async def tts_streaming(websocket: WebSocket) -> None:
    await websocket.accept()
    await websocket.send_bytes(pack({"type": "Ready"}))

    cursor_sec = 0.0
    try:
        while True:
            data = await websocket.receive_bytes()
            message = unpack(data)
            message_type = message.get("type")

            if message_type == "Text":
                text = str(message.get("text", ""))
                if text:
                    cursor_sec = await send_text_and_silence(websocket, text, cursor_sec)
            elif message_type == "Voice":
                logger.info("Ignoring Voice message in silent TTS stub.")
            elif message_type == "Eos":
                await websocket.send_bytes(
                    pack({"type": "Audio", "pcm": silent_pcm(TRAILING_SILENCE_SEC)})
                )
                await asyncio.sleep(0)
                await websocket.close()
                return
            else:
                await websocket.send_bytes(
                    pack(
                        {
                            "type": "Error",
                            "message": f"Unsupported TTS stub message: {message_type}",
                        }
                    )
                )
    except WebSocketDisconnect:
        logger.info("TTS stub client disconnected.")
