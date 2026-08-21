import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGaiaTool } from "../src/harness/tools-pi.js";
import { buildPiTools } from "../src/harness/tools.js";
import { MemoryStore } from "../src/domain/memory.js";
import type { AgentDef } from "../src/core/types.js";

function text(result: any): string {
  return result.content.filter((item: any) => item.type === "text").map((item: any) => item.text).join("\n");
}

async function writeTestPng(path: string): Promise<void> {
  const width = 1800;
  const height = 900;
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const i = (y * width + x) * 4;
    pixels[i] = x % 256;
    pixels[i + 1] = y % 256;
    pixels[i + 2] = (x + y) % 256;
    pixels[i + 3] = 255;
  }
  const image = new PhotonImage(pixels, width, height);
  try {
    await writeFile(path, image.get_bytes());
  } finally {
    image.free();
  }
}

function imageDimensions(item: any): [number, number] {
  const image = PhotonImage.new_from_byteslice(Buffer.from(item.data, "base64"));
  try {
    return [image.get_width(), image.get_height()];
  } finally {
    image.free();
  }
}

test("gaia-only tool dispatches every phase-one verb to its native implementation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gaia-tool-"));
  const memoryDir = join(dir, "memory");
  await mkdir(memoryDir);
  const file = join(dir, "note.txt");
  const caryll = join(dir, "caryll.txt");
  await writeFile(caryll, "same phrase repeats. same phrase repeats. same phrase repeats.\n");
  const calls: string[] = [];
  const agent = { id: "only-gaia", memoryDir, insight: "none" } as AgentDef;
  const onlyGaia = await buildPiTools(["gaia"], {
    memoryStore: new MemoryStore(),
    agent,
    roomId: "r1",
    roomDir: dir,
    workDir: dir,
    availableAgents: [{ id: "worker", label: "Worker" }],
    summonCreate: async ({ agentId, task }: { agentId: string; task: string }) => {
      calls.push(`summon:${agentId}:${task}`);
      return "summoned";
    },
    resumeCreate: async ({ roomId, message }: { roomId: string; message: string }) => {
      calls.push(`resume:${roomId}:${message}`);
      return "resumed";
    },
  });
  assert.equal(onlyGaia.length, 1, "agent is configured with ONLY gaia");
  const tool: any = onlyGaia[0];
  assert.equal(tool.name, "gaia");
  await tool.execute("w", { verb: "write", args: { path: file, content: "before" }, raw: true });
  assert.equal(await readFile(file, "utf8"), "before");
  assert.match(text(await tool.execute("r", { verb: "read", args: { path: file }, raw: true })), /before/);
  await tool.execute("e", { verb: "edit", args: { path: file, edits: [{ oldText: "before", newText: "after" }] }, raw: true });
  assert.equal(await readFile(file, "utf8"), "after");
  assert.match(text(await tool.execute("b", { verb: "bash", args: { command: "printf bash-ok" }, raw: true })), /bash-ok/);
  assert.match(text(await tool.execute("web", { verb: "web", args: { command: "printf web-curl-fallback" }, raw: true })), /web-curl-fallback/);
  // {url} dispatches to the fetch path (distinct from {query} search and the
  // curl escape hatch above) -- an invalid url proves routing without hitting
  // the network, matching runWebFetchVerb's own error message.
  assert.match(text(await tool.execute("web", { verb: "web", args: { url: "not a url" }, raw: true })), /ERROR: invalid url: not a url/);
  assert.match(text(await tool.execute("web", { verb: "web", args: { url: "file:///etc/passwd" }, raw: true })), /ERROR: unsupported url scheme: file:/);
  assert.match(text(await tool.execute("mem", { verb: "mem", args: { action: "list" }, raw: true })), /no memory files/);
  assert.match(text(await tool.execute("recall", { verb: "recall", args: { query: "nothing" }, raw: true })), /no matches|ERROR/);
  assert.equal(text(await tool.execute("summon", { verb: "summon", args: { agent: "worker", task: "map" }, raw: true })), "summoned");
  assert.equal(text(await tool.execute("resume", { verb: "resume", args: { roomId: "child", message: "steer" }, raw: true })), "resumed");
  assert.match(text(await tool.execute("c", { verb: "caryll", args: { action: "stats", path: caryll }, raw: true })), /caryll\.stats/);
  assert.deepEqual(calls, ["summon:worker:map", "resume:child:steer"]);
});

test("gaia image read: default renders low detail with original-coordinate 3x3 legend", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gaia-image-"));
  const file = join(dir, "grid.png");
  await writeTestPng(file);
  const tool: any = createGaiaTool({ memoryStore: new MemoryStore(), agent: { id: "a", memoryDir: dir } as AgentDef, roomId: "r", roomDir: dir, workDir: dir });
  const result = await tool.execute("image", { verb: "read", args: { path: file }, raw: true });
  assert.match(text(result), /1800×900 → sent 768×384 \(detail=low, resize factor 0\.4267×\)/);
  assert.match(text(result), /grid 3×3 · A1 B1 C1 \/ A2 B2 C2 \/ A3 B3 C3/);
  assert.match(text(result), /A1=\(0,0,600,300\).*B2=\(600,300,600,300\).*C3=\(1200,600,600,300\)/);
  const images = result.content.filter((item: any) => item.type === "image");
  assert.equal(images.length, 1);
  assert.deepEqual(imageDimensions(images[0]), [768, 384]);
});

test("gaia image read: region B2 returns original crop plus always-on thumbnail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gaia-image-"));
  const file = join(dir, "grid.png");
  await writeTestPng(file);
  const tool: any = createGaiaTool({ memoryStore: new MemoryStore(), agent: { id: "a", memoryDir: dir } as AgentDef, roomId: "r", roomDir: dir, workDir: dir });
  const result = await tool.execute("image-region", { verb: "read", args: { path: file, region: "B2", detail: "high" }, raw: true });
  assert.match(text(result), /crop B2 of 3×3, orig rect \(600,300,600,300\) → sent 600×300 \(detail=high\)/);
  const images = result.content.filter((item: any) => item.type === "image");
  assert.equal(images.length, 2);
  assert.deepEqual(imageDimensions(images[0]), [768, 384], "global thumbnail comes first");
  assert.deepEqual(imageDimensions(images[1]), [600, 300], "crop never upscales beyond original");
});

test("gaia image read: native:true bypasses the GAIA renderer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gaia-image-"));
  const file = join(dir, "grid.png");
  await writeTestPng(file);
  const tool: any = createGaiaTool({ memoryStore: new MemoryStore(), agent: { id: "a", memoryDir: dir } as AgentDef, roomId: "r", roomDir: dir, workDir: dir });
  const result = await tool.execute("native-image", { verb: "read", args: { path: file, native: true }, raw: true });
  assert.doesNotMatch(text(result), /grid 3×3|resize factor|zoom: read/);
  assert.equal(result.content.filter((item: any) => item.type === "image").length, 1);
});

test("gaia image read: non-images stay on Pi native read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gaia-image-"));
  const file = join(dir, "note.txt");
  await writeFile(file, "native text\n");
  const tool: any = createGaiaTool({ memoryStore: new MemoryStore(), agent: { id: "a", memoryDir: dir } as AgentDef, roomId: "r", roomDir: dir, workDir: dir });
  const result = await tool.execute("text", { verb: "read", args: { path: file }, raw: true });
  assert.equal(text(result), "native text\n");
  assert.equal(result.content.filter((item: any) => item.type === "image").length, 0);
});

test("gaia image read: malformed detail is rejected with a precise corrective error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gaia-image-"));
  const tool: any = createGaiaTool({ memoryStore: new MemoryStore(), agent: { id: "a", memoryDir: dir } as AgentDef, roomId: "r", roomDir: dir, workDir: dir });
  const result = await tool.execute("bad-detail", { verb: "read", args: { path: "missing.png", detail: "ultra" }, raw: true });
  assert.match(text(result), /^ERROR: gaia read args invalid/);
  assert.match(text(result), /detail/);
  assert.match(text(result), /low.*med.*high.*full/);
});

test("gaia edit verb: valid call validates and dispatches to the native edit tool", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gaia-schema-"));
  const file = join(dir, "note.txt");
  await writeFile(file, "before");
  const tool: any = createGaiaTool({ memoryStore: new MemoryStore(), agent: { id: "a", memoryDir: dir } as AgentDef, roomId: "r", roomDir: dir, workDir: dir });
  const result = await tool.execute("e", { verb: "edit", args: { path: file, edits: [{ oldText: "before", newText: "after" }] }, raw: true });
  assert.equal(await readFile(file, "utf8"), "after");
  assert.doesNotMatch(text(result), /^ERROR/);
});

test("gaia edit verb: malformed args (missing newText) are rejected BEFORE dispatch with a precise, path-qualified corrective error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gaia-schema-"));
  const file = join(dir, "note.txt");
  await writeFile(file, "before");
  const tool: any = createGaiaTool({ memoryStore: new MemoryStore(), agent: { id: "a", memoryDir: dir } as AgentDef, roomId: "r", roomDir: dir, workDir: dir });
  const result = await tool.execute("e", { verb: "edit", args: { path: file, edits: [{ oldText: "before" }] }, raw: true });
  const message = text(result);
  assert.match(message, /^ERROR: gaia edit args invalid/);
  assert.match(message, /edits\/0/);
  assert.match(message, /newText/);
  // Never dispatched to the native edit tool: file on disk is untouched.
  assert.equal(await readFile(file, "utf8"), "before");
});

test("gaia edit verb: malformed args (path wrong type) are rejected with a precise error naming the field", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gaia-schema-"));
  const tool: any = createGaiaTool({ memoryStore: new MemoryStore(), agent: { id: "a", memoryDir: dir } as AgentDef, roomId: "r", roomDir: dir, workDir: dir });
  const result = await tool.execute("e", { verb: "edit", args: { path: 42, edits: [{ oldText: "a", newText: "b" }] }, raw: true });
  const message = text(result);
  assert.match(message, /^ERROR: gaia edit args invalid/);
  assert.match(message, /path/);
});

test("gaia tool's outer schema: verb enum lists every registered verb, and args stays a generic object at the schema root (Anthropic legacy-schema-flattening compat)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gaia-schema-shape-"));
  const tool: any = createGaiaTool({ memoryStore: new MemoryStore(), agent: { id: "a", memoryDir: dir } as AgentDef, roomId: "r", roomDir: dir, workDir: dir });
  const schema = tool.parameters as any;
  assert.equal(schema.type, "object");
  assert.deepEqual(schema.required, ["verb", "args"]);
  assert.equal(schema.properties.args.type, "object");
  assert.deepEqual(schema.properties.verb.enum, ["bash", "read", "write", "edit", "web", "summon", "resume", "mem", "recall", "artifact", "caryll"]);
  // Per-verb typed branches ride as allOf/if-then — sibling to (never replacing)
  // the top-level properties, so a consumer that only reads schema.properties/
  // schema.required (pi-ai's Anthropic non-strict legacyInputSchema path) still
  // sees a correct, non-empty object schema.
  assert.ok(Array.isArray(schema.allOf) && schema.allOf.length >= 7);
  const editBranch = schema.allOf.find((entry: any) => entry.if.properties.verb.const === "edit");
  assert.ok(editBranch, "edit has a typed allOf/if-then branch");
  assert.deepEqual(editBranch.then.properties.args.required, ["path", "edits"]);
  const readBranch = schema.allOf.find((entry: any) => entry.if.properties.verb.const === "read");
  assert.ok(readBranch, "read has a typed allOf/if-then branch");
  assert.deepEqual(readBranch.then.properties.args.properties.detail.enum, ["low", "med", "high", "full"]);
  assert.equal(readBranch.then.properties.args.properties.region.pattern, "^[A-C][1-3]$");
  assert.equal(readBranch.then.properties.args.properties.native.type, "boolean");
});

test("gaia formats above the configurable threshold in deterministic gaiago and raw bypasses it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gaia-format-"));
  const tool: any = createGaiaTool({ memoryStore: new MemoryStore(), agent: { id: "a", memoryDir: dir } as AgentDef, roomId: "r", roomDir: dir, workDir: dir });
  const formatted = text(await tool.execute("f", { verb: "bash", args: { command: "printf 'one\\n\\n two\\n'" }, compress_above_bytes: 0 }));
  assert.match(formatted, /^真 bash · 行=2/);
  assert.match(formatted, /1→one\n2→two/);
  const raw = text(await tool.execute("raw", { verb: "bash", args: { command: "printf one" }, compress_above_bytes: 0, raw: true }));
  assert.equal(raw, "one");
});
