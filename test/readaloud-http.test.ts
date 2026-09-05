import { test, expect } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import "../src/harness/index.js";
import { startWebServer } from "../src/server/http.js";
import { initWorkspace } from "../src/domain/workspace.js";
import { RoomHandle } from "../src/domain/rooms.js";
import { registerTtsEngine, pcmToWav } from "../src/services/read-aloud.js";

// Full daemon + HTTP; deterministic PCM fixture, not provider/ear verification.
test("headless daemon: both TTS routes echo effective voice/model and isolate cached audio", async () => {
  const base = join(import.meta.dir, "../.gaia/readaloud-tests");
  await mkdir(base, { recursive: true });
  const dir = await mkdtemp(join(base, "http-"));
  const priorHome = process.env.GAIA_HOME;
  process.env.GAIA_HOME = join(dir, "home");
  let server: Awaited<ReturnType<typeof startWebServer>> | undefined;
  const calls: string[] = [];
  const pcm = (voice?: string) => { const b = Buffer.alloc(3200); for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(Math.round(5000 * Math.sin(i * (voice === "airy" ? 0.1 : 0.2))), i * 2); return b; };
  const engine = `http-cache-${dir.split("/").pop()}`;
  registerTtsEngine({
    id: engine, voices: ["airy", "mellow"], resolveVoice: v => v ?? "airy", resolveModel: m => m ?? "fixture-v1",
    synthesize: async ({ voice, model }) => { calls.push(`${voice}:${model}:batch`); return { audio: pcmToWav(pcm(voice), 16000), contentType: "audio/wav" }; },
    synthesizeStream: async ({ voice, model }) => { calls.push(`${voice}:${model}:stream`); return { format: { sampleRate: 16000, channels: 1, bitsPerSample: 16 }, frames: (async function* () { yield pcm(voice); })() }; },
  });
  try {
    const workspace = join(dir, "workspace");
    await mkdir(workspace, { recursive: true });
    await initWorkspace(workspace);
    await writeFile(join(process.env.GAIA_HOME!, "voice.json"), JSON.stringify({ ttsEngine: engine }));
    const room = await RoomHandle.open(workspace, "default");
    await room.appendEvent({ id: "tts-proof", author: "gaia", timestamp: new Date().toISOString(), text: "Same message for both voices." });
    server = await startWebServer({ cwd: workspace, host: "127.0.0.1", port: 0 });
    const added = await fetch(`${server.url}api/workspaces`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: workspace }) });
    expect(added.status).toBe(200);
    const record = await added.json() as any;
    const workspaceId = record.currentWorkspaceId;
    expect(typeof workspaceId).toBe("string");
    for (const route of ["read-aloud", "read-aloud/stream"]) {
      const hashes: string[] = [];
      for (const voice of ["airy", "mellow", "airy"]) {
        const response = await fetch(`${server.url}api/workspaces/${workspaceId}/rooms/default/${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ eventId: "tts-proof", voice, model: "fixture-v2" }) });
        expect(response.status).toBe(200);
        expect(response.headers.get("x-tts-voice")).toBe(voice);
        expect(response.headers.get("x-tts-model")).toBe("fixture-v2");
        expect(response.headers.get("cache-control")).toBe("no-store");
        const audio = Buffer.from(await response.arrayBuffer());
        expect(audio.length).toBeGreaterThan(0);
        const hash = createHash("sha256").update(audio).digest("hex");
        hashes.push(hash);
        console.log(`FIXTURE ${route} status=${response.status} voice=${response.headers.get("x-tts-voice")} model=${response.headers.get("x-tts-model")} bytes=${audio.length} sha256=${hash}`);
      }
      expect(hashes[0]).not.toBe(hashes[1]);
      expect(hashes[0]).toBe(hashes[2]);
    }
    expect(calls).toEqual(["airy:fixture-v2:batch", "mellow:fixture-v2:batch", "airy:fixture-v2:stream", "mellow:fixture-v2:stream"]);
  } finally {
    await server?.close();
    if (priorHome === undefined) delete process.env.GAIA_HOME; else process.env.GAIA_HOME = priorHome;
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
