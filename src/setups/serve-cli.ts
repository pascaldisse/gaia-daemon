// `gaia serve <room>` — expose a monad room as a single model over a wire
// protocol (default: OpenAI-compatible). A request's last user message runs
// through the MonadEngine and the one final answer comes back. The steps run as
// real summons through an in-process coordinator, exactly as in the daemon — so
// "answer as one" on the outside, inspectable child rooms underneath.

import { GaiaController } from "../app/gaia-controller.js";
import { MonadEngine } from "../app/monad-engine.js";
import { SummonCoordinator } from "../app/summon-coordinator.js";
import { MemoryStore } from "../memory/memory-store.js";
import { resolveAgentRole } from "../roles/roles.js";
import { serveAdapterFor } from "../runtime/monad/index.js";
import type { ChatMessage } from "../runtime/monad/types.js";
import { ensureWorkspaceRoom, loadWorkspace } from "../workspace/workspace-loader.js";
import { readRoomMonad } from "./setup-loader.js";

const USAGE = `Usage: gaia serve <room> [--port N] [--host H] [--adapter id]`;

function parse(args: string[]): { room?: string; port: number; host: string; adapter: string } {
  let room: string | undefined;
  let port = 8799;
  let host = "127.0.0.1";
  let adapter = "openai-compatible";
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--port") port = Number.parseInt(args[++i] ?? "", 10);
    else if (arg === "--host") host = args[++i] ?? host;
    else if (arg === "--adapter") adapter = args[++i] ?? adapter;
    else if (!arg.startsWith("--") && !room) room = arg;
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) port = 8799;
  return { room, port, host, adapter };
}

function lastUserMessage(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return messages[i].content;
  }
  return messages.length > 0 ? messages[messages.length - 1].content : "";
}

/** Dispatches `gaia serve …`. Returns a process exit code (long-running on success). */
export async function runServeCli(args: string[], cwd = process.cwd()): Promise<number> {
  const { room, port, host, adapter: adapterId } = parse(args);
  if (!room) {
    console.error(USAGE);
    return 1;
  }

  let workspace;
  try {
    workspace = await loadWorkspace(cwd);
  } catch (error) {
    console.error(`gaia: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const monad = await readRoomMonad(workspace, room);
  if (!monad) {
    console.error(`gaia: room '${room}' is not a monad room. Run \`gaia setup activate <id> ${room}\` first.`);
    return 1;
  }

  let adapter;
  try {
    adapter = serveAdapterFor(adapterId);
  } catch (error) {
    console.error(`gaia: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  // Minimal headless host: a per-child-room controller factory + a summon
  // coordinator, the same wiring the web server builds (without HTTP bridge —
  // worker steps run; memory-write/nested-summon inside a step are unavailable).
  const controllers = new Map<string, GaiaController>();
  const memoryStore = new MemoryStore();
  let coordinator: SummonCoordinator;
  const controllerForRoom = async (roomId: string): Promise<GaiaController> => {
    const existing = controllers.get(roomId);
    if (existing) return existing;
    await ensureWorkspaceRoom(cwd, roomId);
    const controller = new GaiaController({ workspaceId: "serve", workspace, roomId, memoryStore, summonHost: coordinator });
    await controller.init();
    controllers.set(roomId, controller);
    return controller;
  };
  coordinator = new SummonCoordinator(workspace, cwd, controllerForRoom, workspace.config.maxSummonsPerRoom ?? 8);

  await ensureWorkspaceRoom(cwd, room);

  const run = async (messages: ChatMessage[]): Promise<string> => {
    const engine = new MonadEngine({
      config: monad,
      parentRoomId: room,
      dispatch: (agentId, task) => coordinator.summonAndWait(room, agentId, task),
      resolveRolePrompt: async (agentId, role) => {
        const agent = workspace.agents[agentId];
        if (!agent) return "";
        return (await resolveAgentRole(agent, role))?.prompt ?? "";
      },
    });
    const result = await engine.run(lastUserMessage(messages));
    return result.final;
  };

  const handle = await adapter.start({ host, port, run });
  console.log(`gaia serve — monad room '${room}' as one model via ${adapterId}`);
  console.log(`  endpoint: ${handle.url}`);
  console.log(`  policy: ${monad.policy}   pool: ${monad.slots.map((slot) => `@${slot.agentId}`).join(" · ")}`);
  console.log("Press Ctrl+C to stop.");

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
      for (const controller of controllers.values()) controller.dispose();
      void handle.stop().finally(resolve);
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return 0;
}
