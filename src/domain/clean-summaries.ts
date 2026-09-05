import { readFileSync } from "node:fs";
import { mkdir, readFile, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { writeJsonAtomic } from "../core/store.js";

type CleanSummaryEntry = { default?: string; agents?: Record<string, string> };
type CleanSummaryIndex = Record<string, CleanSummaryEntry>;
export function cleanSummaryIndexPath(): string {
  return join(homedir(), ".pi", "agent", "clean-summaries", "index.json");
}
export function loadCleanCompactionOverride(roomId: string, agentId: string, indexPath = cleanSummaryIndexPath()): string | undefined {
  try {
    const index = JSON.parse(readFileSync(indexPath, "utf8")) as CleanSummaryIndex;
    const entry = Object.hasOwn(index, roomId) ? index[roomId] : undefined;
    if (!entry) return undefined;
    const summary = entry.agents && Object.hasOwn(entry.agents, agentId) ? entry.agents[agentId] : entry.default;
    return typeof summary === "string" ? summary : undefined;
  } catch { return undefined; }
}
export async function registerCleanSummary(roomId: string, agentId: string, summary: string, indexPath = cleanSummaryIndexPath()): Promise<void> {
  if (!summary.trim()) throw new Error("clean summary must not be empty");
  await mkdir(dirname(indexPath), { recursive: true });
  const lock = `${indexPath}.lock`;
  // Cross-process exclusion; contention/stale lock → visible failure, never lost registrations.
  await mkdir(lock);
  try {
    let index: CleanSummaryIndex = {};
    try { index = JSON.parse(await readFile(indexPath, "utf8")) as CleanSummaryIndex; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!index || typeof index !== "object" || Array.isArray(index)) throw new Error("invalid clean-summary index");
    const entry = Object.hasOwn(index, roomId) ? index[roomId] : undefined;
    await writeJsonAtomic(indexPath, { ...index, [roomId]: { ...entry, agents: { ...entry?.agents, [agentId]: summary } } });
    console.warn(`compact-clean: registered room=${roomId} agent=${agentId} index=${indexPath}`);
  } finally { await rmdir(lock); }
}
