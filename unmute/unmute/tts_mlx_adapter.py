import asyncio
import json
import logging
import os
import re
import threading
from dataclasses import dataclass
from typing import Any, Callable, Sequence

import msgpack
import numpy as np
from fastapi import FastAPI, WebSocket, WebSocketDisconnect

logger = logging.getLogger(__name__)

SAMPLE_RATE = 24_000
SAMPLES_PER_FRAME = 1_920
DEFAULT_VOICE = "expresso/ex03-ex01_happy_001_channel1_334s.wav"
DEFAULT_COALESCE_SEC = 0.12
DEFAULT_MIN_WORDS = 4


def pack(message: dict[str, Any]) -> bytes:
    return msgpack.packb(message, use_bin_type=True, use_single_float=True)


def unpack(data: bytes) -> dict[str, Any]:
    message = msgpack.unpackb(data, raw=False)
    if not isinstance(message, dict):
        raise ValueError(f"Expected msgpack dict, got {type(message)!r}")
    return message


def text_duration(text: str) -> float:
    # TTS text events are used for subtitle timing only. Real alignment comes in
    # Phase 2 tuning; this estimate keeps the frontend moving with the audio.
    return max(0.18, min(3.0, len(text.strip()) / 14))


def display_tokens(text: str) -> list[str]:
    return [token for token in re.split(r"\s+", text.strip()) if token]


def normalize_pcm(pcm: Any) -> list[float]:
    array = np.asarray(pcm, dtype=np.float32).reshape(-1)
    if array.size == 0:
        return []
    return np.clip(array, -1.0, 1.0).tolist()


def load_mlx_modules():
    import mlx.core as mx
    import mlx.nn as nn
    import sentencepiece
    from moshi_mlx import models
    from moshi_mlx.models.generate import LmGen
    from moshi_mlx.models.tts import (
        DEFAULT_DSM_TTS_REPO,
        DEFAULT_DSM_TTS_VOICE_REPO,
        TTSModel,
        script_to_entries,
    )
    from moshi_mlx.modules.conditioner import (
        ConditionAttributes,
        ConditionTensor,
        dropout_all_conditions,
    )
    from moshi_mlx.utils.loaders import hf_get
    from moshi_mlx.utils.sampling import Sampler

    return {
        "mx": mx,
        "nn": nn,
        "sentencepiece": sentencepiece,
        "models": models,
        "LmGen": LmGen,
        "DEFAULT_DSM_TTS_REPO": DEFAULT_DSM_TTS_REPO,
        "DEFAULT_DSM_TTS_VOICE_REPO": DEFAULT_DSM_TTS_VOICE_REPO,
        "TTSModel": TTSModel,
        "script_to_entries": script_to_entries,
        "ConditionAttributes": ConditionAttributes,
        "ConditionTensor": ConditionTensor,
        "dropout_all_conditions": dropout_all_conditions,
        "hf_get": hf_get,
        "Sampler": Sampler,
    }


@dataclass
class MlxTtsGenerator:
    engine: "MlxTtsEngine"
    attributes: Sequence[Any]
    on_frame: Callable[[Any], None]

    def __post_init__(self) -> None:
        tts_model = self.engine.tts_model
        mlx = self.engine.mlx
        mx = mlx["mx"]
        attributes = self.attributes
        self.offset = 0
        self.state = tts_model.machine.new_state([])

        if tts_model.cfg_coef != 1.0:
            if tts_model.valid_cfg_conditionings:
                raise ValueError(
                    "This model was trained with CFG distillation. Use cfg_coef "
                    "inside make_condition_attributes instead."
                )
            attributes = list(attributes) + mlx["dropout_all_conditions"](attributes)

        assert tts_model.lm.condition_provider is not None
        self.ct = None
        self.cross_attention_src = None
        for attr in attributes:
            for key, value in attr.text.items():
                ct = tts_model.lm.condition_provider.condition_tensor(key, value)
                if self.ct is None:
                    self.ct = ct
                else:
                    self.ct = mlx["ConditionTensor"](self.ct.tensor + ct.tensor)
            for key, value in attr.tensor.items():
                conditioner = tts_model.lm.condition_provider.conditioners[key]
                ca_src = conditioner.condition(value)
                if self.cross_attention_src is None:
                    self.cross_attention_src = ca_src
                else:
                    raise ValueError("Multiple cross-attention conditioners are unsupported")

        def on_audio_hook(audio_tokens: Any) -> None:
            delays = tts_model.lm.delays
            for q in range(audio_tokens.shape[0]):
                delay = delays[q]
                if self.offset < delay + tts_model.delay_steps:
                    audio_tokens[q] = tts_model.machine.token_ids.zero

        def on_text_hook(text_tokens: Any) -> None:
            tokens = text_tokens.tolist()
            out_tokens = []
            for token in tokens:
                out_token, _ = tts_model.machine.process(self.offset, self.state, token)
                out_tokens.append(out_token)
            text_tokens[:] = mx.array(out_tokens, dtype=mx.int64)

        self.lm_gen = mlx["LmGen"](
            tts_model.lm,
            max_steps=tts_model.max_gen_length,
            text_sampler=mlx["Sampler"](temp=tts_model.temp),
            audio_sampler=mlx["Sampler"](temp=tts_model.temp),
            cfg_coef=tts_model.cfg_coef,
            on_text_hook=on_text_hook,
            on_audio_hook=on_audio_hook,
        )

    def append_text(self, text: str, first_turn: bool) -> None:
        tts_model = self.engine.tts_model
        entries = self.engine.prepare_script(text, first_turn=first_turn)
        for entry in entries:
            self.state.entries.append(entry)
            self.process()

    def process(self) -> None:
        while len(self.state.entries) > self.engine.tts_model.machine.second_stream_ahead:
            self.step()

    def process_last(self) -> None:
        while len(self.state.entries) > 0 or self.state.end_step is not None:
            self.step()
        additional_steps = (
            self.engine.tts_model.delay_steps + max(self.engine.tts_model.lm.delays) + 8
        )
        for _ in range(additional_steps):
            self.step()

    def step(self) -> None:
        tts_model = self.engine.tts_model
        mx = self.engine.mlx["mx"]
        missing = tts_model.lm.n_q - tts_model.lm.dep_q
        input_tokens = mx.ones((1, missing), dtype=mx.int64) * tts_model.machine.token_ids.zero
        self.lm_gen.step(input_tokens, ct=self.ct, cross_attention_src=self.cross_attention_src)
        frame = self.lm_gen.last_audio_tokens()
        self.offset += 1
        if frame is not None and not (frame == -1).any():
            self.on_frame(frame)


class MlxTtsEngine:
    def __init__(self) -> None:
        self.hf_repo = os.environ.get("KYUTAI_TTS_MLX_REPO")
        self.voice_repo = os.environ.get("KYUTAI_TTS_MLX_VOICE_REPO")
        self.voice = os.environ.get("KYUTAI_TTS_MLX_VOICE", DEFAULT_VOICE)
        self.quantize = os.environ.get("KYUTAI_TTS_MLX_QUANTIZE", "8")
        self.coalesce_sec = float(
            os.environ.get("KYUTAI_TTS_MLX_COALESCE_SEC", DEFAULT_COALESCE_SEC)
        )
        self.min_words = int(os.environ.get("KYUTAI_TTS_MLX_MIN_WORDS", DEFAULT_MIN_WORDS))
        self.lock = threading.Lock()
        self.mlx: dict[str, Any] = {}
        self.tts_model: Any = None
        self.cfg_coef_conditioning: Any = None

    def load(self) -> None:
        self.mlx = load_mlx_modules()
        mx = self.mlx["mx"]
        nn = self.mlx["nn"]
        models = self.mlx["models"]
        sentencepiece = self.mlx["sentencepiece"]
        hf_get = self.mlx["hf_get"]
        tts_model_cls = self.mlx["TTSModel"]

        mx.random.seed(299792458)
        hf_repo = self.hf_repo or self.mlx["DEFAULT_DSM_TTS_REPO"]
        voice_repo = self.voice_repo or self.mlx["DEFAULT_DSM_TTS_VOICE_REPO"]

        logger.info("Loading MLX TTS checkpoints from %s", hf_repo)
        raw_config_path = hf_get("config.json", hf_repo)
        with open(hf_get(raw_config_path), "r", encoding="utf-8") as config_file:
            raw_config = json.load(config_file)

        mimi_weights = hf_get(raw_config["mimi_name"], hf_repo)
        moshi_weights = hf_get(raw_config.get("moshi_name", "model.safetensors"), hf_repo)
        tokenizer = hf_get(raw_config["tokenizer_name"], hf_repo)
        lm_config = models.LmConfig.from_config_dict(raw_config)
        lm_config.transformer.max_seq_len = lm_config.transformer.context

        model = models.Lm(lm_config)
        model.set_dtype(mx.bfloat16)
        logger.info("Loading MLX TTS LM weights from %s", moshi_weights)
        model.load_pytorch_weights(str(moshi_weights), lm_config, strict=True)

        if self.quantize:
            bits = int(self.quantize)
            logger.info("Quantizing MLX TTS model to %d bits", bits)
            nn.quantize(model.depformer, bits=bits)
            for layer in model.transformer.layers:
                nn.quantize(layer.self_attn, bits=bits)
                nn.quantize(layer.gating, bits=bits)

        logger.info("Loading MLX TTS text tokenizer from %s", tokenizer)
        text_tokenizer = sentencepiece.SentencePieceProcessor(str(tokenizer))

        generated_codebooks = lm_config.generated_codebooks
        audio_tokenizer = models.mimi.Mimi(models.mimi_202407(generated_codebooks))
        logger.info("Loading MLX TTS audio tokenizer from %s", mimi_weights)
        audio_tokenizer.load_pytorch_weights(str(mimi_weights), strict=True)

        self.tts_model = tts_model_cls(
            model,
            audio_tokenizer,
            text_tokenizer,
            voice_repo=voice_repo,
            temp=0.6,
            cfg_coef=1,
            max_padding=8,
            initial_padding=2,
            final_padding=2,
            padding_bonus=0,
            raw_config=raw_config,
        )
        if self.tts_model.valid_cfg_conditionings:
            self.cfg_coef_conditioning = self.tts_model.cfg_coef
            self.tts_model.cfg_coef = 1.0
        logger.info("MLX TTS loaded with sample_rate=%s", self.tts_model.mimi.sample_rate)

    def prepare_script(self, script: str, first_turn: bool) -> list[Any]:
        multi_speaker = first_turn and self.tts_model.multi_speaker
        return self.mlx["script_to_entries"](
            self.tts_model.tokenizer,
            self.tts_model.machine.token_ids,
            self.tts_model.mimi.frame_rate,
            [script],
            multi_speaker=multi_speaker,
            padding_between=1,
        )

    def make_attributes(self) -> list[Any]:
        voices = [self.tts_model.get_voice_path(self.voice)] if self.tts_model.multi_speaker else []
        return [
            self.tts_model.make_condition_attributes(voices, self.cfg_coef_conditioning)
        ]

    def new_generator(self, on_frame: Callable[[Any], None]) -> MlxTtsGenerator:
        return MlxTtsGenerator(self, self.make_attributes(), on_frame=on_frame)

    def process_text(
        self,
        generator: MlxTtsGenerator,
        text: str,
        first_turn: bool,
        *,
        is_final: bool = False,
        on_frame: Callable[[Any], None] | None = None,
    ) -> list[np.ndarray]:
        frames: list[np.ndarray] = []

        def collect_frame(frame: Any) -> None:
            pcm = self.tts_model.mimi.decode_step(frame[:, :, None])
            pcm = np.array(self.mlx["mx"].clip(pcm[0, 0], -1, 1))
            frames.append(pcm)

        generator.on_frame = on_frame or collect_frame
        with self.lock:
            if text:
                generator.append_text(text, first_turn=first_turn)
            if is_final:
                generator.process_last()

        return frames

    def generate_text(self, text: str) -> tuple[list[np.ndarray], float]:
        generator = self.new_generator(on_frame=lambda _: None)
        frames = self.process_text(generator, text, first_turn=True, is_final=True)
        duration = sum(frame.size for frame in frames) / SAMPLE_RATE
        return frames, duration


engine = MlxTtsEngine()
app = FastAPI()


@app.on_event("startup")
async def startup() -> None:
    await asyncio.to_thread(engine.load)


@app.get("/")
async def root() -> dict[str, str]:
    return {"service": "unmute-tts-mlx", "status": "ok"}


@app.get("/api/build_info")
async def build_info() -> dict[str, Any]:
    return {
        "service": "unmute-tts-mlx",
        "backend": "mlx",
        "status": "ok",
        "voice": engine.voice,
        "quantize": engine.quantize,
        "sample_rate": SAMPLE_RATE,
    }


async def send_text_events(
    websocket: WebSocket,
    text: str,
    cursor_sec: float,
) -> float:
    for token in display_tokens(text):
        duration = text_duration(token)
        await websocket.send_bytes(
            pack(
                {
                    "type": "Text",
                    "text": token,
                    "start_s": cursor_sec,
                    "stop_s": cursor_sec + duration,
                }
            )
        )
        cursor_sec += duration
    return cursor_sec


def text_ends_turn(text: str) -> bool:
    return text.rstrip().endswith((".", "!", "?", ":", ";", ","))


async def send_audio_frame(websocket: WebSocket, frame: Any) -> None:
    pcm = normalize_pcm(frame)
    if pcm:
        await websocket.send_bytes(pack({"type": "Audio", "pcm": pcm}))


def decode_audio_frame(frame: Any) -> np.ndarray | None:
    if frame is None or (frame == -1).any():
        return None
    pcm = engine.tts_model.mimi.decode_step(frame[:, :, None])
    return np.array(engine.mlx["mx"].clip(pcm[0, 0], -1, 1))


async def audio_sender(
    websocket: WebSocket,
    audio_queue: asyncio.Queue[np.ndarray | None],
) -> None:
    while True:
        frame = await audio_queue.get()
        if frame is None:
            return
        await send_audio_frame(websocket, frame)


async def synth_worker(
    text_queue: asyncio.Queue[str | None],
    audio_queue: asyncio.Queue[np.ndarray | None],
) -> None:
    loop = asyncio.get_running_loop()
    generator = engine.new_generator(on_frame=lambda _: None)
    first_turn = True
    pending: list[str] = []

    def enqueue_frame(frame: Any) -> None:
        pcm = decode_audio_frame(frame)
        if pcm is not None:
            loop.call_soon_threadsafe(audio_queue.put_nowait, pcm)

    def flush_pending(is_final: bool = False) -> None:
        nonlocal first_turn, pending
        text = " ".join(chunk.strip() for chunk in pending if chunk.strip())
        pending = []
        engine.process_text(
            generator,
            text,
            first_turn,
            is_final=is_final,
            on_frame=enqueue_frame,
        )
        if text:
            first_turn = False

    try:
        eos = False
        while True:
            item = await text_queue.get()
            if item is None:
                eos = True
            else:
                pending.append(item)

            if not eos and engine.coalesce_sec > 0:
                await asyncio.sleep(engine.coalesce_sec)

            while not eos:
                try:
                    item = text_queue.get_nowait()
                except asyncio.QueueEmpty:
                    break
                if item is None:
                    eos = True
                    break
                pending.append(item)

            should_flush = (
                eos
                or len(pending) >= engine.min_words
                or (pending and text_ends_turn(pending[-1]))
            )
            if should_flush and pending:
                await asyncio.to_thread(flush_pending, False)

            if eos:
                await asyncio.to_thread(flush_pending, True)
                await audio_queue.put(None)
                return
    except Exception:
        await audio_queue.put(None)
        raise


@app.websocket("/api/tts_streaming")
async def tts_streaming(websocket: WebSocket) -> None:
    await websocket.accept()
    await websocket.send_bytes(pack({"type": "Ready"}))

    cursor_sec = 0.0
    text_queue: asyncio.Queue[str | None] = asyncio.Queue()
    audio_queue: asyncio.Queue[np.ndarray | None] = asyncio.Queue()
    synth_task = asyncio.create_task(synth_worker(text_queue, audio_queue))
    audio_task = asyncio.create_task(audio_sender(websocket, audio_queue))
    try:
        while True:
            data = await websocket.receive_bytes()
            message = unpack(data)
            message_type = message.get("type")

            if message_type == "Text":
                text = str(message.get("text", ""))
                if text:
                    cursor_sec = await send_text_events(websocket, text, cursor_sec)
                    await text_queue.put(text)
            elif message_type == "Voice":
                logger.info("Ignoring Voice message; configured voice is %s", engine.voice)
            elif message_type == "Eos":
                await text_queue.put(None)
                await synth_task
                await audio_task
                await websocket.close()
                return
            else:
                await websocket.send_bytes(
                    pack({"type": "Error", "message": f"Unsupported TTS message: {message_type}"})
                )
    except WebSocketDisconnect:
        synth_task.cancel()
        audio_task.cancel()
        logger.info("MLX TTS client disconnected.")
