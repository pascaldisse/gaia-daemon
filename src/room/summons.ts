import { existsSync } from "node:fs";
import { mkdir, readFile, appendFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { newId } from "../lib/ids.js";
import { readJsonFile, writeJsonFile } from "../lib/fs.js";

export interface SummonSession {
  id: string;
  roomId: string;
  agentId: string;
  harness: string;
  prompt: string;
  status: "running" | "complete" | "error" | "cancelled";
  startedAt: string;
  endedAt?: string;
  summary?: string;
  logPath: string;
}

export type SummonEvent =
  | { type: "model-info"; provider: string; modelId: string; subscription: boolean }
  | { type: "text-delta"; delta: string }
  | { type: "thinking-start" }
  | { type: "thinking-delta"; delta: string }
  | { type: "thinking-end"; content?: string }
  | { type: "tool-start"; toolName: string; toolCallId?: string; args?: unknown }
  | { type: "tool-update"; toolName: string; toolCallId?: string; partialResult?: unknown }
  | { type: "tool-end"; toolName: string; toolCallId?: string; result?: unknown; isError: boolean };

export function summonDir(roomsDir: string, roomId: string, summonId: string): string {
  return join(roomsDir, roomId, "summons", summonId);
}

function sessionPath(dir: string): string {
  return join(dir, "session.json");
}

function eventsPath(dir: string): string {
  return join(dir, "events.jsonl");
}

function resultPath(dir: string): string {
  return join(dir, "result.md");
}

export async function createSummonSession(params: {
  roomsDir: string;
  roomId: string;
  agentId: string;
  harness: string;
  prompt: string;
}): Promise<SummonSession> {
  const id = newId("summon");
  const dir = summonDir(params.roomsDir, params.roomId, id);
  await mkdir(dir, { recursive: true });

  const session: SummonSession = {
    id,
    roomId: params.roomId,
    agentId: params.agentId,
    harness: params.harness,
    prompt: params.prompt,
    status: "running",
    startedAt: new Date().toISOString(),
    logPath: dir,
  };

  await writeJsonFile(sessionPath(dir), session);
  return session;
}

export async function updateSummonSession(dir: string, patch: Partial<Pick<SummonSession, "status" | "endedAt" | "summary">>): Promise<SummonSession> {
  const session = (await readJsonFile(sessionPath(dir))) as SummonSession | undefined;
  if (!session) throw new Error(`Summon session not found at ${dir}`);
  Object.assign(session, patch);
  await writeJsonFile(sessionPath(dir), session);
  return session;
}

export async function appendSummonEvent(dir: string, event: SummonEvent): Promise<void> {
  await mkdir(dir, { recursive: true });
  await appendFile(eventsPath(dir), `${JSON.stringify(event)}\n`, "utf8");
}

export async function writeSummonResult(dir: string, text: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(resultPath(dir), text, "utf8");
}

export async function readSummonSession(dir: string): Promise<SummonSession | undefined> {
  return (await readJsonFile(sessionPath(dir))) as SummonSession | undefined;
}

export async function readSummonEvents(dir: string): Promise<SummonEvent[]> {
  const path = eventsPath(dir);
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  if (!text.trim()) return [];
  return text
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line) as SummonEvent;
      } catch {
        return undefined;
      }
    })
    .filter((event): event is SummonEvent => Boolean(event));
}

export async function readSummonResult(dir: string): Promise<string> {
  const path = resultPath(dir);
  if (!existsSync(path)) return "";
  return readFile(path, "utf8");
}

export async function listSummonSessions(roomsDir: string, roomId: string): Promise<SummonSession[]> {
  const base = join(roomsDir, roomId, "summons");
  if (!existsSync(base)) return [];
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(base, { withFileTypes: true });
  const sessions: SummonSession[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const session = await readSummonSession(join(base, entry.name));
    if (session) sessions.push(session);
  }
  return sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
