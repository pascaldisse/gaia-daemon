import { readFile } from "node:fs/promises";
import { globalPaths } from "../../core/paths.js";
import { writeJsonAtomic } from "../../core/store.js";
import type { RoomEvent, RoomEventKind, Task, UiEvent } from "../../core/types.js";
import type { RoomHandle } from "../../domain/rooms.js";
import type { SlashCommand } from "../commands.js";
import { sttEngineIds } from "../transcribe.js";
import { readVoiceSettings } from "../voice.js";

export type CommandReply = string | { text: string; kind?: RoomEventKind; author?: string };
export type RoomCommand = SlashCommand;
export type CommandHandler = (command: RoomCommand) => Promise<CommandReply>;

export interface RoomCommandExecutionContext {
  readonly room: RoomHandle;
  readonly roomId: string;
  readonly workspaceId: string;
  emit(event: UiEvent): void;
  taskCancelled(task: Task): boolean;
  settleTask(task: Task, status: "complete" | "error" | "cancelled", error?: unknown): void;
}

const TRANSCRIPT_STRUCTURAL_COMMANDS = new Set(["clear", "fork", "rewind"]);
let reloadDaemon: (() => void | Promise<void>) | undefined;

export function configureRoomServiceReload(callback: (() => void | Promise<void>) | undefined): void {
  reloadDaemon = callback;
}

export async function runCommand(
  context: RoomCommandExecutionContext,
  task: Task,
  command: RoomCommand,
  handler: CommandHandler | undefined,
): Promise<void> {
  try {
    const reply = handler ? await handler(command) : "Unknown command. Try /help.";
    const text = typeof reply === "string" ? reply : reply.text;
    const author = typeof reply === "string" ? "system" : (reply.author ?? "system");
    const event: RoomEvent = {
      id: `${author === "system" ? "system" : "cmd"}_${task.id}`,
      timestamp: new Date().toISOString(),
      author,
      text,
      ...(typeof reply === "string" || !reply.kind ? {} : { kind: reply.kind }),
    };
    if (!TRANSCRIPT_STRUCTURAL_COMMANDS.has(command.type)) await context.room.appendEvent(event);
    context.emit({ type: "room-event", workspaceId: context.workspaceId, roomId: context.roomId, event });
    if (!context.taskCancelled(task)) context.settleTask(task, "complete");
  } catch (error) {
    if (!context.taskCancelled(task)) context.settleTask(task, "error", error);
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

async function readVoiceSettingsDocument(): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(globalPaths.voiceSettings(), "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return {};
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("voice.json is malformed; fix it before switching engines");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("voice.json must contain a JSON object");
  }
  const document: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) document[key] = value;
  return document;
}

export async function runSttCommand(engine?: string, alias?: "tts"): Promise<string> {
  const available = sttEngineIds();
  const aliasNote = alias ? " `/tts` controls voice input here; `/stt` is the canonical name." : "";
  if (engine && !available.includes(engine)) {
    return `Unknown STT engine "${engine}". Available: ${available.join(", ")}.${aliasNote}`;
  }
  try {
    const document = await readVoiceSettingsDocument();
    if (engine) {
      await writeJsonAtomic(globalPaths.voiceSettings(), { ...document, sttEngine: engine });
      return `Speech-to-text engine switched to ${engine}. Available: ${available.join(", ")}.${aliasNote}`;
    }
    const current = (await readVoiceSettings()).sttEngine;
    return `Speech-to-text engine: ${current}. Available: ${available.join(", ")}. Use /stt <engine> or /tts <engine>.${aliasNote}`;
  } catch (error) {
    return `Could not ${engine ? "switch" : "read"} the STT engine: ${error instanceof Error ? error.message : String(error)}`;
  }
}

export function runReloadCommand(context: Pick<RoomCommandExecutionContext, "roomId" | "workspaceId">): string {
  const reload = reloadDaemon;
  if (!reload) return "Reload is unavailable in this process.";
  console.log(`[gaia] ${new Date().toISOString()} /reload command issued in room ${context.roomId} (workspace ${context.workspaceId})`);
  setTimeout(() => {
    void reload();
  }, 0);
  return "reloading daemon — in-flight turns resume after restart.";
}
