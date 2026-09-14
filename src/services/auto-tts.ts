import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { env } from "../core/env.js";
import type { UiEvent } from "../core/types.js";
import { readAppSettings } from "./app-settings.js";
import { claudeVoiceHealth, readAloud, speakableText, type ReadAloudRequest, type ReadAloudResult } from "./read-aloud.js";

type CommittedReply = Extract<UiEvent, { type: "room-event" }>;

interface AutoTtsDeps {
  request(reply: CommittedReply): Promise<ReadAloudRequest | undefined>;
  log(message: string): void;
  enabled?: () => Promise<boolean>;
  healthy?: (url: string) => Promise<boolean>;
  readAloud?: typeof readAloud;
  play?: (result: ReadAloudResult, signal: AbortSignal) => Promise<void>;
}

// Audio sink only; synthesis/transport/cache → existing readAloud.
export async function playAutoTtsAudio(
  result: ReadAloudResult,
  signal: AbortSignal,
  command = env("GAIA_AUTO_TTS_PLAYER") ?? (process.platform === "darwin" ? "afplay" : "aplay"),
  tempRoot = tmpdir(),
): Promise<void> {
  signal.throwIfAborted();
  const dir = await mkdtemp(join(tempRoot, "gaia-auto-tts-"));
  try {
    const path = join(dir, "speech.wav");
    await writeFile(path, result.audio);
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(command, [path], { stdio: "ignore", signal });
      child.once("error", reject);
      child.once("close", (code) => code === 0 ? resolve() : reject(new Error(`audio player exited ${code}`)));
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// One daemon-wide FIFO; completion includes playback, not merely synthesis.
export class AutoTtsQueue {
  private tail: Promise<void> = Promise.resolve();
  private readonly aborter = new AbortController();
  private readonly enabled: () => Promise<boolean>;

  constructor(private readonly deps: AutoTtsDeps) {
    this.enabled = deps.enabled ?? (async () => (await readAppSettings()).general.autoTts);
  }

  enqueue(event: UiEvent): Promise<void> {
    if (this.aborter.signal.aborted || event.type !== "room-event") return Promise.resolve();
    const reply = event.event;
    if (["user", "system", "tool"].includes(reply.author) || ("kind" in reply && reply.kind) || !reply.text.trim()) return Promise.resolve();
    // Capture eligibility now; an off-setting reply cannot become queued later.
    const eligible = Promise.resolve().then(this.enabled).catch((error) => { this.log(error); return false; });
    this.tail = this.tail.then(async () => {
      if (!await eligible || this.aborter.signal.aborted || !await this.enabled()) return;
      const text = speakableText(reply.text);
      if (!text) return;
      const request = await this.deps.request(event);
      if (!request) return;
      const healthy = this.deps.healthy ?? (async (url: string) => {
        const health = await claudeVoiceHealth(url.replace(/\/+$/, ""));
        return health.ok && health.ready;
      });
      const speak = this.deps.readAloud ?? readAloud;
      const play = this.deps.play ?? playAutoTtsAudio;
      for (let chunk = 0, chunks = 1; chunk < chunks; chunk++) {
        if (this.aborter.signal.aborted || !await this.enabled()) return;
        if (!await healthy(request.settings.claudeVoiceUrl)) {
          this.log(`skipped ${event.roomId}/${reply.id}: claude-voice not healthy`);
          return;
        }
        const result = await speak({ ...request, event: { author: reply.author, text }, chunk });
        chunks = result.chunks;
        if (this.aborter.signal.aborted || !await this.enabled()) return;
        await play(result, this.aborter.signal);
      }
    }).catch((error) => this.log(error));
    return this.tail;
  }

  dispose(): void {
    this.aborter.abort();
  }

  private log(error: unknown): void {
    try {
      this.deps.log(`auto-tts: ${error instanceof Error ? error.message : String(error)}`);
    } catch { /* Logging must not reject the reply path or poison the FIFO. */ }
  }
}
