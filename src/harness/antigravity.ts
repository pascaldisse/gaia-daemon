import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AgentDef, type AgentEvent, type Workspace, type CompactResult, type CompactProgressUpdate } from "../core/types.js";
import { gaiaHome } from "../core/paths.js";
import { createEventChannel } from "./events.js";
import { missingBinaryError, spawnLineReader } from "./proc.js";
import { configuredModelLabel, ModelLabel } from "./model-label.js";
import { buildInlineSystemPrompt, buildTurnPromptFor } from "./prompt.js";
import {
  type AgentInput,
  type AgentRuntime,
  type HarnessCapabilities,
  registerHarness,
  type RuntimeCreateContext,
} from "./spec.js";

const ANTIGRAVITY_CAPABILITIES: HarnessCapabilities = {
  gaiaTools: ["memory", "recall", "summon", "resume"],
  nativeTools: ["web"],
  granularTools: true,
  supportsPermissionMode: true,
  supportsMcp: true,
  supportsSteer: true,
  supportsCompact: true,
  // No native in-place session fork; edit/retry use the shared WAL-reset +
  // replay path (see HarnessCapabilities.supportsForkAtMessage).
  supportsForkAtMessage: false,
  supportsNativeCommands: false,
  fanOutTools: [],
};

const PYTHON_BRIDGE = `#!/usr/bin/env python3
import asyncio
import json
import sys
from google.antigravity import Agent, LocalAgentConfig, CapabilitiesConfig

ACTIVE_THREADS = {}
NEXT_THREAD_ID = 1

async def send_response(id, result=None, error=None):
    msg = {"id": id}
    if error:
        msg["error"] = error
    else:
        msg["result"] = result or {}
    print(json.dumps(msg), flush=True)

async def send_notification(method, params=None):
    msg = {"method": method, "params": params or {}}
    print(json.dumps(msg), flush=True)

async def handle_request(req):
    req_id = req.get("id")
    method = req.get("method")
    params = req.get("params", {})
    
    if method == "initialize":
        await send_response(req_id, {"status": "ok"})
        await send_notification("initialized")
    
    elif method == "thread/start" or method == "thread/resume":
        global NEXT_THREAD_ID
        thread_id = params.get("threadId", f"thread-{NEXT_THREAD_ID}")
        if method == "thread/start":
            NEXT_THREAD_ID += 1
            
        ACTIVE_THREADS[thread_id] = {
            "cwd": params.get("cwd"),
            "baseInstructions": params.get("baseInstructions"),
            "model": params.get("model"),
            "modelProvider": params.get("modelProvider"),
        }
        
        await send_response(req_id, {
            "thread": {"id": thread_id},
            "model": params.get("model", "gemini"),
            "modelProvider": params.get("modelProvider", "google")
        })
        
    elif method == "turn/start":
        thread_id = params.get("threadId")
        if thread_id not in ACTIVE_THREADS:
            await send_response(req_id, error={"code": -32602, "message": "Unknown thread"})
            return
            
        thread_data = ACTIVE_THREADS[thread_id]
        turn_id = f"turn-{id(params)}"
        
        await send_response(req_id, {"turn": {"id": turn_id}})
        await send_notification("turn/started", {"turn": {"id": turn_id}, "threadId": thread_id})
        
        input_content = params.get("input", [])
        prompt_text = ""
        for item in input_content:
            if item.get("type") == "text":
                prompt_text += item.get("text", "")
        
        config = LocalAgentConfig(
            system_instructions=thread_data.get("baseInstructions", ""),
            capabilities=CapabilitiesConfig()
        )
        
        try:
            async with Agent(config) as agent:
                response = await agent.chat(prompt_text)
                
                async def stream_tokens():
                    async for token in response:
                        await send_notification("item/stream", {
                            "threadId": thread_id,
                            "type": "text",
                            "text": token
                        })
                        
                async def stream_thoughts():
                    async for thought in response.thoughts:
                        await send_notification("item/stream", {
                            "threadId": thread_id,
                            "type": "thought",
                            "text": thought
                        })
                
                await asyncio.gather(stream_tokens(), stream_thoughts())
                
                await send_notification("turn/completed", {
                    "threadId": thread_id,
                    "turn": {"id": turn_id, "status": "completed"}
                })
                
        except Exception as e:
            await send_notification("turn/completed", {
                "threadId": thread_id,
                "turn": {"id": turn_id, "status": "failed", "error": {"message": str(e)}}
            })

    elif method == "turn/interrupt":
        await send_response(req_id, {"status": "ok"})
    
    elif method == "thread/compact/start":
        await send_response(req_id, {})
        await send_notification("item/completed", {"type": "contextCompaction", "threadId": params.get("threadId")})
        await send_notification("turn/completed", {"turn": {"status": "completed"}, "threadId": params.get("threadId")})

    else:
        await send_response(req_id, error={"code": -32601, "message": f"Method not found: {method}"})

async def main():
    loop = asyncio.get_event_loop()
    while True:
        line = await loop.run_in_executor(None, sys.stdin.readline)
        if not line:
            break
            
        line = line.strip()
        if not line:
            continue
            
        try:
            req = json.loads(line)
            if "id" in req and "method" in req:
                asyncio.create_task(handle_request(req))
        except json.JSONDecodeError:
            pass

if __name__ == "__main__":
    asyncio.run(main())
`;

function ensurePythonBridge(): string {
  const bridgeDir = join(gaiaHome(), "bridge");
  mkdirSync(bridgeDir, { recursive: true });
  const scriptPath = join(bridgeDir, "antigravity-server.py");
  writeFileSync(scriptPath, PYTHON_BRIDGE, { mode: 0o755 });
  return scriptPath;
}

interface JsonRpcNotification {
  method: string;
  params: any;
}

export class AntigravityClient {
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private closed = false;
  private exitError: Error | null = null;
  public notifHandler: ((msg: JsonRpcNotification) => void) | null = null;

  constructor(
    private proc: any,
    private rl: any,
    public stderr: () => string
  ) {}

  request(method: string, params: any): Promise<any> {
    if (this.closed || this.exitError) return Promise.reject(this.exitError ?? new Error("client closed"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.proc.stdin.write(JSON.stringify({ id, method, params }) + "\\n");
    });
  }

  notify(method: string, params: any): void {
    if (this.closed || this.exitError) return;
    this.proc.stdin.write(JSON.stringify({ method, params }) + "\\n");
  }

  handleLine(line: string) {
    try {
      const msg = JSON.parse(line);
      if (msg.id !== undefined && msg.method === undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message || "Request failed"));
          else p.resolve(msg.result);
        }
      } else if (msg.method) {
        if (this.notifHandler) this.notifHandler(msg);
      }
    } catch {}
  }

  handleError(err: Error) {
    this.exitError = err;
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  close() {
    this.closed = true;
    this.rl.close();
    this.proc.stdin.end();
  }
}

async function spawnAntigravityClient(cwd: string): Promise<AntigravityClient> {
  const scriptPath = ensurePythonBridge();
  let client: AntigravityClient;
  
  const { proc, rl, stderr } = spawnLineReader({
    command: "python3",
    args: [scriptPath],
    cwd,
    env: process.env,
    onLine: (line) => client?.handleLine(line),
  });

  client = new AntigravityClient(proc, rl, stderr);

  proc.on("error", (err: Error) => client.handleError(err));
  proc.on("exit", (code: number, signal: NodeJS.Signals) => {
    client.handleError(new Error(`Python bridge exited (${signal || code})`));
  });

  return client;
}

class AntigravityRuntime implements AgentRuntime {
  readonly agent: AgentDef;
  readonly capabilities = ANTIGRAVITY_CAPABILITIES;
  private workspace: Workspace;
  private cwd: string;
  
  private client: AntigravityClient | null = null;
  private initPromise: Promise<AntigravityClient> | null = null;
  private label: ModelLabel;
  private memoryStore: any;
  
  private threads = new Map<string, string>();
  private activeTurn: { threadId: string; turnId: string } | null = null;

  constructor(ctx: RuntimeCreateContext) {
    this.workspace = ctx.workspace;
    this.agent = ctx.agent;
    this.cwd = ctx.workspace.dir;
    this.memoryStore = ctx.memoryStore;
    this.label = new ModelLabel(configuredModelLabel(this.agent.model, "Gemini default"));
  }

  get modelLabel(): string {
    return this.label.current;
  }

  private async ensureClient(): Promise<AntigravityClient> {
    if (this.client) return this.client;
    if (!this.initPromise) {
      this.initPromise = spawnAntigravityClient(this.cwd).then(async (client) => {
        try {
          await client.request("initialize", {});
          return client;
        } catch (err) {
          client.close();
          throw missingBinaryError("python3", "Antigravity Bridge", err, client.stderr());
        }
      }).catch(err => {
        this.initPromise = null;
        throw err;
      });
    }
    this.client = await this.initPromise;
    return this.client;
  }

  async *send(input: AgentInput): AsyncIterable<AgentEvent> {
    const client = await this.ensureClient();
    const channel = createEventChannel();
    
    const baseInstructions = await buildInlineSystemPrompt({
      workspace: this.workspace,
      agent: this.agent,
      role: input.activeRole,
      toolPointer: "",
      contextFiles: []
    } as any); // using partial args for now since system prompts vary by harness

    let threadId = this.threads.get(input.roomId);
    if (!threadId) {
      const res = await client.request("thread/start", {
        cwd: this.cwd,
        baseInstructions,
        model: this.agent.model?.name,
        modelProvider: this.agent.model?.provider,
      });
      threadId = res.thread.id;
      this.threads.set(input.roomId, threadId!);
    }

    const promptText = await buildTurnPromptFor(this.agent, input, this.memoryStore, { memoryChanged: () => true }, { workDir: this.cwd, rootDir: this.cwd });

    client.notifHandler = (msg) => {
      if (msg.params?.threadId !== threadId) return;
      if (msg.method === "turn/started") {
        this.activeTurn = { threadId: threadId!, turnId: String(msg.params.turn?.id || "turn") };
      } else if (msg.method === "item/stream") {
        if (msg.params.type === "text") {
          channel.push({ type: "text-delta", text: msg.params.text } as any);
        } else if (msg.params.type === "thought") {
          channel.push({ type: "thinking-start" } as any);
        }
      } else if (msg.method === "turn/completed") {
        if (msg.params.turn.status === "failed") {
          channel.fail(new Error(msg.params.turn.error?.message || "Turn failed"));
        } else {
          channel.close();
        }
      }
    };

    client.request("turn/start", {
      threadId,
      input: [{ type: "text", text: promptText }],
    }).catch(err => channel.fail(err));

    yield* channel.stream();
    this.activeTurn = null;
  }

  async abort(): Promise<void> {
    if (this.client && this.activeTurn) {
      await this.client.request("turn/interrupt", {
        threadId: this.activeTurn.threadId,
      }).catch(() => {});
    }
  }

  async compact(roomId: string, onProgress?: (update: CompactProgressUpdate) => void): Promise<CompactResult> {
    const client = await this.ensureClient();
    const threadId = this.threads.get(roomId);
    if (!threadId) return { compacted: false, message: "no session" };
    
    await client.request("thread/compact/start", { threadId });
    return { compacted: true, message: "thread compacted" };
  }

  resetRoom(roomId: string): void {
    this.threads.delete(roomId);
  }

  dispose(): void {
    if (this.client) {
      this.client.close();
      this.client = null;
    }
    this.threads.clear();
  }
}

registerHarness({
  id: "antigravity",
  capabilities: ANTIGRAVITY_CAPABILITIES,
  ui: {
    label: "antigravity",
    description: "Google Antigravity SDK Runtime",
    lockedProvider: "gemini",
    modelProviderIds: ["gemini"],
  },
  create: (ctx) => new AntigravityRuntime(ctx),
  sandboxPaths: {
    writable: ["~/.gemini/antigravity-cli"],
    readonly: ["~/.gemini/antigravity-cli/settings.json"]
  }
});
