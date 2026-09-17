#!/usr/bin/env bun
// Live proof for the minimax TTS fix (fix/minimax-stream). Talks to the REAL
// Replicate API using the REAL token from ~/.gaia/voice.json (read-only —
// never logged, never written back). Does NOT touch the running whip 154
// daemon or its shared TTS cache: every call here either bypasses readAloud's
// cache entirely (direct engine.synthesize) or points cacheDir at var/.
//
// Usage: bun scripts/tts-proof-minimax.ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findTtsEngine, readAloud, type TtsSynthesisContext } from "../src/services/read-aloud.js";
import { readVoiceSettings, type VoiceSettings } from "../src/services/voice.js";

const OUT_DIR = join(process.cwd(), "var", "tts-proof");
const ensureTts: TtsSynthesisContext["ensureTts"] = async () => ({ ttsUrl: "" });
const log = (message: string): void => console.error(`  [log] ${message}`);

const SENTENCES = [
  "Hello, this is a quick latency test.",
  "The quick brown fox jumps over the lazy dog while the sun sets over the quiet hills.",
  "Pipelined synthesis lets chunk two start rendering while chunk one is still being read aloud, cutting the wait between sentences.",
];

async function synthOnce(settings: VoiceSettings, text: string, label: string): Promise<{ ms: number; bytes: number; file: string }> {
  const engine = findTtsEngine("minimax");
  if (!engine) throw new Error("minimax engine not registered");
  const started = Date.now();
  const result = await engine.synthesize({ text, voice: settings.minimaxVoice, model: settings.minimaxModel, settings, ensureTts, log });
  const ms = Date.now() - started;
  const file = join(OUT_DIR, `${label}.mp3`);
  await writeFile(file, result.audio);
  return { ms, bytes: result.audio.length, file };
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const base = await readVoiceSettings();
  if (!base.replicateApiToken && !base.sttReplicateApiKey) throw new Error("no Replicate token in ~/.gaia/voice.json — cannot run a live proof");
  console.error(`voice=${base.minimaxVoice} defaultModel=${base.minimaxModel}`);

  // -------------------------------------------------------------------------
  // 1) turbo vs hd, same 3 sentences, default emotion (auto)
  console.error("\n== turbo vs hd ==");
  const modelResults: Array<{ model: string; sentence: number; ms: number; bytes: number }> = [];
  for (const model of ["minimax/speech-02-turbo", "minimax/speech-02-hd"]) {
    for (let i = 0; i < SENTENCES.length; i++) {
      const settings = { ...base, minimaxModel: model };
      const label = `model-${model.split("/")[1]}-s${i + 1}`;
      const { ms, bytes, file } = await synthOnce(settings, SENTENCES[i], label);
      console.error(`${model} sentence ${i + 1}: ${ms}ms, ${bytes}B -> ${file}`);
      modelResults.push({ model, sentence: i + 1, ms, bytes });
    }
  }

  // -------------------------------------------------------------------------
  // 2) emotion auto vs neutral vs happy, same 3 sentences, default model
  console.error("\n== emotion auto vs neutral vs happy ==");
  const emotionResults: Array<{ emotion: string; sentence: number; ms: number; bytes: number }> = [];
  for (const emotion of ["auto", "neutral", "happy"]) {
    for (let i = 0; i < SENTENCES.length; i++) {
      const settings = { ...base, minimaxEmotion: emotion };
      const label = `emotion-${emotion}-s${i + 1}`;
      const { ms, bytes, file } = await synthOnce(settings, SENTENCES[i], label);
      console.error(`emotion=${emotion} sentence ${i + 1}: ${ms}ms, ${bytes}B -> ${file}`);
      emotionResults.push({ emotion, sentence: i + 1, ms, bytes });
    }
  }

  // -------------------------------------------------------------------------
  // 3) pipelining: OLD (sequential chunk0 then chunk1) vs NEW (readAloud's
  // concurrent prefetch) on a real 2-chunk message, same engine + settings.
  console.error("\n== pipelining: sequential (before) vs prefetch (after) ==");
  const longText = `${SENTENCES[1]} ${SENTENCES[2]} ${SENTENCES[0]} ${SENTENCES[1]} ${SENTENCES[2]}`;
  const engine = findTtsEngine("minimax");
  if (!engine) throw new Error("minimax engine not registered");

  // OLD: chunk 0 fully resolves, THEN chunk 1 starts (matches the pre-fix
  // engine, which declared no prefetchChunks capability at all).
  const seqStart = Date.now();
  const chunk0 = await engine.synthesize({ text: SENTENCES[1], voice: base.minimaxVoice, model: base.minimaxModel, settings: base, ensureTts, log });
  const afterChunk0Ms = Date.now() - seqStart;
  const chunk1 = await engine.synthesize({ text: SENTENCES[2], voice: base.minimaxVoice, model: base.minimaxModel, settings: base, ensureTts, log });
  const seqTotalMs = Date.now() - seqStart;
  await writeFile(join(OUT_DIR, "pipeline-old-chunk0.mp3"), chunk0.audio);
  await writeFile(join(OUT_DIR, "pipeline-old-chunk1.mp3"), chunk1.audio);
  console.error(`OLD sequential: chunk0 ready at ${afterChunk0Ms}ms, both ready at ${seqTotalMs}ms`);

  // NEW: readAloud() fires the chunk-1 prefetch concurrently with chunk 0's
  // own request (see prefetchFollowingChunks in read-aloud.ts).
  const preDir = join(OUT_DIR, "prefetch-cache");
  await mkdir(preDir, { recursive: true });
  const settings = { ...base, minimaxPrefetch: 1 };
  const preStart = Date.now();
  const first = await readAloud({ event: { author: "gaia", text: longText }, settings, ensureTts, cacheDir: preDir, log });
  const chunk0ReadyMs = Date.now() - preStart;
  // Poll the cache for chunk 1's background prefetch to land.
  let chunk1ReadyMs = -1;
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    try {
      const second = await readAloud({ event: { author: "gaia", text: longText }, settings, ensureTts, cacheDir: preDir, chunk: 1 });
      chunk1ReadyMs = Date.now() - preStart;
      await writeFile(join(OUT_DIR, "pipeline-new-chunk0.mp3"), first.audio);
      await writeFile(join(OUT_DIR, "pipeline-new-chunk1.mp3"), second.audio);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  console.error(`NEW prefetch: chunk0 ready at ${chunk0ReadyMs}ms, chunk1 (prefetched) ready at ${chunk1ReadyMs}ms`);

  const summary = {
    voice: base.minimaxVoice,
    defaultModel: base.minimaxModel,
    modelResults,
    emotionResults,
    pipelining: { sequentialOld: { afterChunk0Ms, seqTotalMs }, prefetchNew: { chunk0ReadyMs, chunk1ReadyMs } },
  };
  await writeFile(join(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2));
  console.error(`\nSummary written to ${join(OUT_DIR, "summary.json")}`);
}

main().catch((error) => {
  console.error("FAILED:", error instanceof Error ? error.message : String(error));
  process.exit(1);
});
