// whistle -- Cactus Whistle, a 16.9 MB on-device speech-to-text model
// (cactuscompute.com/blog/whistle): 7 languages, ~10 ms first token, CPU only.
// Runs through Cactus's prebuilt native `needle` engine -- no Python, no keys,
// no network after the one-time asset download. ~50 ms per short clip, warm.
//
// registerSttEngine({ id: "whistle", ... }) happens in transcribe.ts (RULE #0:
// engine is DATA, the shared path never branches on engine id) -- this file
// only exports the pure transcribe function.
//
// Assets (cached in <gaia home>/cache/bin/whistle/, fetched once, single-flight):
//   needle        engine binary, HF Cactus-Compute/needle3/<platform>/needle
//   whistle.cact  weights,       HF Cactus-Compute/whistle/whistle.cact
// Whistle caps a pass at 30 s -> longer clips are cut into 28 s segments and the
// per-segment transcripts joined (a hard cut can split a word at a boundary).
import { chmodSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globalPaths } from "../core/paths.js";
import type { SttContext, SttResult } from "./transcribe.js";
import { runProcess } from "./stt-process.js";

const ENGINE_REPO = "https://huggingface.co/Cactus-Compute/needle3/resolve/main";
const WEIGHTS_URL = "https://huggingface.co/Cactus-Compute/whistle/resolve/main/whistle.cact";
// process.platform-process.arch -> needle3 platform folder (the Windows/mobile/
// wasm folders exist upstream but gaia's daemon never runs there).
const PLATFORM_FOLDERS: Record<string, string> = {
  "darwin-arm64": "macos-arm64",
  "linux-x64": "linux-x86_64",
  "linux-arm64": "linux-arm64",
};
// Languages the model knows (ISO 639-1). Anything else -> auto-detect.
export const WHISTLE_LANGUAGES = new Set(["en", "de", "fr", "es", "it", "nl", "pl"]);
const SEGMENT_SECONDS = 28;
const WHISTLE_TIMEOUT_MS = 120_000;

export function whistleLanguage(language: string | undefined): string {
  const code = (language ?? "").trim().toLowerCase().split("-")[0];
  return WHISTLE_LANGUAGES.has(code) ? code : "";
}

function assetDir(): string {
  return join(globalPaths.cacheBinDir(), "whistle");
}

async function download(url: string, target: string, executable: boolean, signal: AbortSignal): Promise<void> {
  const response = await fetch(url, { signal, redirect: "follow" });
  if (!response.ok) throw new Error(`Whistle asset download failed (${response.status}): ${url}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 100_000) throw new Error(`Whistle asset suspiciously small (${bytes.length} B): ${url}`);
  const tmp = `${target}.${process.pid}.part`;
  await writeFile(tmp, bytes);
  if (executable) chmodSync(tmp, 0o755);
  await rename(tmp, target); // atomic: a half-written asset is never visible
}

let assetsInFlight: Promise<{ engine: string; weights: string }> | null = null;

/** Ensure engine + weights are cached; returns their paths. Single-flight. */
export function whistleAssets(log: (message: string) => void): Promise<{ engine: string; weights: string }> {
  if (!assetsInFlight) {
    assetsInFlight = (async () => {
      const folder = PLATFORM_FOLDERS[`${process.platform}-${process.arch}`];
      if (!folder) throw new Error(`STT engine "whistle" has no engine build for ${process.platform}-${process.arch}`);
      const dir = assetDir();
      await mkdir(dir, { recursive: true });
      const engine = join(dir, "needle");
      const weights = join(dir, "whistle.cact");
      const signal = AbortSignal.timeout(600_000);
      if (!existsSync(engine)) {
        log("whistle STT: downloading engine (first run, ~1 MB)\u2026");
        await download(`${ENGINE_REPO}/${folder}/needle`, engine, true, signal);
      }
      if (!existsSync(weights)) {
        log("whistle STT: downloading model (first run, ~17 MB)\u2026");
        await download(WEIGHTS_URL, weights, false, signal);
      }
      return { engine, weights };
    })().catch((error) => {
      assetsInFlight = null; // a failed fetch is retried by the next clip
      throw error;
    });
  }
  return assetsInFlight;
}

function parseNeedleJson(stdout: string): string {
  const line = stdout.split("\n").map((l) => l.trim()).filter((l) => l.startsWith("{")).pop();
  if (!line) throw new Error(`Whistle returned no JSON: ${stdout.slice(0, 200)}`);
  const data = JSON.parse(line) as { text?: unknown };
  return typeof data.text === "string" ? data.text.trim() : "";
}

export async function whistleTranscribe(context: SttContext): Promise<SttResult> {
  const signal = context.signal ?? AbortSignal.timeout(WHISTLE_TIMEOUT_MS);
  const { engine, weights } = await whistleAssets(context.log);
  const work = await mkdtemp(join(tmpdir(), "gaia-stt-whistle-"));
  try {
    // ffmpeg content-probes the container, so the extension-less temp name
    // decodes the webm/mp4/wav/... clips the composer and uploads produce.
    const input = join(work, "clip.input");
    await writeFile(input, context.audio.data);
    const decode = await runProcess([
      "ffmpeg", "-hide_banner", "-loglevel", "error", "-i", input,
      "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le",
      "-f", "segment", "-segment_time", String(SEGMENT_SECONDS), "-reset_timestamps", "1",
      join(work, "seg-%04d.wav"),
    ], signal);
    const segments = (await readdir(work)).filter((f) => /^seg-\d+\.wav$/.test(f)).sort();
    if (decode.code !== 0 || !segments.length) {
      throw new Error(`ffmpeg could not decode the clip: ${decode.stderr.slice(0, 400)}`);
    }
    const language = whistleLanguage(context.language);
    const texts: string[] = [];
    for (const segment of segments) {
      const result = await runProcess([
        engine, "--model", weights, "--audio", join(work, segment),
        ...(language ? ["--audio-language", language] : []),
      ], signal);
      if (result.code !== 0) {
        throw new Error(`Whistle failed (${result.code}): ${(result.stderr || result.stdout).trim().slice(0, 400)}`);
      }
      const text = parseNeedleJson(result.stdout);
      if (text) texts.push(text);
    }
    return { text: texts.join(" ") };
  } finally {
    rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
