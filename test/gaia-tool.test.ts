import { test } from "bun:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { PhotonImage } from "@silvia-odwyer/photon-node";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGaiaTool } from "../src/harness/tools-pi.js";
import { buildPiTools } from "../src/harness/tools.js";
import { MemoryStore } from "../src/domain/memory.js";
import { createToolProviders } from "../src/services/tool-providers.js";
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
    toolProviders: createToolProviders(),
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
  assert.deepEqual(schema.properties.verb.enum, ["bash", "read", "write", "edit", "web", "summon", "resume", "mem", "recall", "artifact", "caryll", "diet", "tool_result_fetch", "end_conversation"]);
  // Typed shapes stay nested under the root args property: legacy Anthropic
  // conversion preserves them, while Claude Code MCP accepts this anyOf form.
  const variants = schema.properties.args.anyOf;
  assert.ok(Array.isArray(variants) && variants.length >= 12);
  const editBranch = variants.find((entry: any) => entry.description.startsWith("Arguments when verb is edit."));
  assert.ok(editBranch, "edit has a typed args variant");
  assert.deepEqual(editBranch.required, ["path", "edits"]);
  const readBranch = variants.find((entry: any) => entry.description.startsWith("Arguments when verb is read."));
  assert.ok(readBranch, "read has a typed args variant");
  assert.deepEqual(readBranch.properties.detail.enum, ["low", "med", "high", "full"]);
  assert.equal(readBranch.properties.region.pattern, "^[A-C][1-3]$");
  assert.equal(readBranch.properties.native.type, "boolean");
  const wireSchema = JSON.stringify(schema);
  assert.doesNotMatch(wireSchema, /"if"\s*:/);
  assert.doesNotMatch(wireSchema, /"then"\s*:/);
  assert.doesNotMatch(wireSchema, /"const"\s*:/);
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

test("gaia diet verb: get/set dispatch to ctx.contextDiet, unavailable without it, set requires a knob", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gaia-diet-"));
  const calls: unknown[] = [];
  const view = { effective: { preset: true, keepAllToolCalls: false, fullTurnWindow: 2, toolTailLines: 20 }, roomOverrides: { preset: true } };
  const tool: any = createGaiaTool({
    memoryStore: new MemoryStore(),
    agent: { id: "a", memoryDir: dir } as AgentDef,
    roomId: "r",
    roomDir: dir,
    workDir: dir,
    contextDiet: {
      get: async () => view,
      set: async (params: unknown) => {
        calls.push(params);
        return view;
      },
    },
  });
  assert.match(text(await tool.execute("g", { verb: "diet", args: { action: "get" }, raw: true })), /"preset":true/);
  await tool.execute("s", { verb: "diet", args: { action: "set", scope: "workspace", preset: false }, raw: true });
  assert.deepEqual(calls, [{ scope: "workspace", patch: { preset: false } }]);
  assert.match(text(await tool.execute("e", { verb: "diet", args: { action: "set" }, raw: true })), /ERROR: diet set requires at least one/);

  const noCtx: any = createGaiaTool({ memoryStore: new MemoryStore(), agent: { id: "a", memoryDir: dir } as AgentDef, roomId: "r", roomDir: dir, workDir: dir });
  assert.match(text(await noCtx.execute("n", { verb: "diet", args: { action: "get" }, raw: true })), /ERROR: diet is unavailable/);
});

test("gaia tool_result_fetch verb: pages back via ctx.toolResultFetch, requires sessionId/entryId, unavailable without it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gaia-fetch-"));
  const calls: unknown[] = [];
  const tool: any = createGaiaTool({
    memoryStore: new MemoryStore(),
    agent: { id: "a", memoryDir: dir } as AgentDef,
    roomId: "r",
    roomDir: dir,
    workDir: dir,
    toolResultFetch: async (params: unknown) => {
      calls.push(params);
      return { text: "the original bash output", totalLength: 25, hasMore: false };
    },
  });
  const result = text(await tool.execute("f", { verb: "tool_result_fetch", args: { sessionId: "e1", entryId: "tool-1" }, raw: true }));
  assert.equal(result, "the original bash output");
  assert.deepEqual(calls, [{ sessionId: "e1", entryId: "tool-1", offset: 0, limit: 32_000 }]);

  const missing = text(await tool.execute("m", { verb: "tool_result_fetch", args: {}, raw: true }));
  assert.match(missing, /^ERROR: gaia tool_result_fetch args invalid/);

  const noCtx: any = createGaiaTool({ memoryStore: new MemoryStore(), agent: { id: "a", memoryDir: dir } as AgentDef, roomId: "r", roomDir: dir, workDir: dir });
  const unavailable = text(await noCtx.execute("u", { verb: "tool_result_fetch", args: { sessionId: "e1", entryId: "t1" }, raw: true }));
  assert.match(unavailable, /ERROR: tool_result_fetch is unavailable/);
});

test("gaia end_conversation validates farewell and reaches the room bridge", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gaia-end-"));
  const calls: string[] = [];
  const tool: any = createGaiaTool({
    memoryStore: new MemoryStore(), agent: { id: "a", memoryDir: dir } as AgentDef, roomId: "r", roomDir: dir, workDir: dir,
    endConversation: async ({ farewell }: { farewell: string }) => { calls.push(farewell); return "ended"; },
  });
  assert.equal(text(await tool.execute("end", { verb: "end_conversation", args: { farewell: "Goodbye." }, raw: true })), "ended");
  assert.deepEqual(calls, ["Goodbye."]);
  const invalid = await tool.execute("end-invalid", { verb: "end_conversation", args: {}, raw: true });
  assert.match(text(invalid), /^ERROR: gaia end_conversation args invalid/);
});
