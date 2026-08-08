// Import a claude.ai data export (conversations.json + memories.json +
// projects/) into a GAIA agent and workspace:
//   - with --room <id>: every conversation becomes transcript history in ONE
//     room, oldest first, with the importing agent's cursor advanced past it
//     (history is recalled, never replayed into a prompt)
//   - with --per-chat: every conversation becomes its OWN room
//     (claude-YYYYMMDD-<slug>) with the chat's title + import date on room
//     state — the sidebar groups these into a collapsed archive section
//   - every conversation also becomes one episode in the agent's episodic log
//   - the claude.ai memory blob becomes semantic facts (source: consolidator)
//     plus on-demand topic files; project prompts/memories become topic files
//
// Usage:
//   tsx scripts/import-claude-export.ts --export <dir> --workspace <dir> \
//     --agent <id> (--room <id> | --per-chat) [--set-default] [--force]
//
// Re-running without --force refuses to touch a non-empty transcript or
// facts/episodes log (per-chat mode skips already-imported rooms); --force
// rewrites the imported artifacts from scratch.

import { existsSync } from "node:fs";
import { readFile, readdir, utimes } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULTS } from "../src/core/config.js";
import { agentPaths, workspacePaths } from "../src/core/paths.js";
import { newId } from "../src/core/ids.js";
import { writeJsonAtomic, writeText } from "../src/core/store.js";
import type { AgentRoomEvent, RoomEvent, UserRoomEvent } from "../src/core/types.js";
import { scaffoldGlobalAgent } from "../src/domain/agents.js";
import { appendEpisode } from "../src/domain/episodes.js";
import { appendFactOp } from "../src/domain/facts.js";
import { newRoomEventId, normalizeRoomState } from "../src/domain/rooms.js";
import {
  ensureWorkspaceRoom,
  globalAgentsPath,
  initWorkspace,
  setWorkspaceDefaultAgent,
  setWorkspaceRoom,
} from "../src/domain/workspace.js";

interface ExportMessage {
  uuid: string;
  text?: string;
  content?: Array<{ type?: string; text?: string; thinking?: string }>;
  sender: "human" | "assistant";
  created_at: string;
}

interface ExportConversation {
  uuid: string;
  name: string;
  created_at: string;
  updated_at: string;
  chat_messages: ExportMessage[];
}

interface ExportProject {
  uuid: string;
  name: string;
  description?: string;
  prompt_template?: string;
}

function arg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function has(flag: string): boolean {
  return process.argv.includes(flag);
}

function fail(message: string): never {
  console.error(`import-claude-export: ${message}`);
  process.exit(1);
}

/** Visible text only. The export's `text` field concatenates thinking with
 * the visible reply, so content blocks are authoritative when present. */
function messageText(message: ExportMessage): string {
  const blocks = message.content ?? [];
  if (blocks.length > 0) {
    return blocks
      .filter((block) => block.type === "text" && block.text?.trim())
      .map((block) => block.text?.trim())
      .join("\n\n");
  }
  return message.text?.trim() ?? "";
}

/** Thinking blocks, kept separate so they land in EventDetails.thinking —
 * the same place the live harnesses commit them — not in the visible text. */
function messageThinking(message: ExportMessage): string {
  return (message.content ?? [])
    .filter((block) => block.type === "thinking" && block.thinking?.trim())
    .map((block) => block.thinking?.trim())
    .join("\n\n");
}

/** Slice a markdown blob into topic files under the 10K on-demand cap,
 * cutting at paragraph boundaries. */
function splitForTopicFiles(text: string, limit = 9_500): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n\n+/)) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    if (candidate.length > limit && current) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) chunks.push(current);
  return chunks;
}

/** A conversation converted to room events (oldest first). The marker line
 * only makes sense in single-room mode, where chats need a visible boundary;
 * a per-chat room's title already carries it. */
function conversationEvents(conversation: ExportConversation, agentId: string, withMarker: boolean): RoomEvent[] {
  const messages = [...conversation.chat_messages].sort((a, b) => a.created_at.localeCompare(b.created_at));
  const withText = messages
    .map((message) => ({
      message,
      text: messageText(message),
      thinking: message.sender === "assistant" ? messageThinking(message) : "",
    }))
    .filter((entry) => entry.text || entry.thinking);
  if (withText.length === 0) return [];
  const events: RoomEvent[] = [];
  if (withMarker) {
    const marker: UserRoomEvent = {
      id: newRoomEventId(),
      timestamp: conversation.created_at,
      author: "user",
      targets: [],
      text: `— imported chat: "${conversation.name || "untitled"}" (${conversation.created_at.slice(0, 10)}) —`,
    };
    events.push(marker);
  }
  for (const { message, text, thinking } of withText) {
    if (message.sender === "human") {
      const event: UserRoomEvent = { id: newRoomEventId(), timestamp: message.created_at, author: "user", targets: [agentId], text };
      events.push(event);
    } else {
      const event: AgentRoomEvent = {
        id: newRoomEventId(),
        timestamp: message.created_at,
        author: agentId,
        text,
        ...(thinking ? { details: { thinkingStarted: true, thinking } } : {}),
      };
      events.push(event);
    }
  }
  return events;
}

/** Deterministic per-chat room id: claude-YYYYMMDD-<slug>, suffixed on
 * collision. Conversations are processed in created_at order, so suffixes are
 * stable across re-runs (re-importing finds the same ids and skips them). */
function importRoomId(conversation: ExportConversation, used: Set<string>): string {
  const date = conversation.created_at.slice(0, 10).replace(/-/g, "");
  const slug =
    (conversation.name || "untitled")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "untitled";
  const base = `claude-${date}-${slug}`;
  let candidate = base;
  let n = 2;
  while (used.has(candidate)) candidate = `${base}-${n++}`;
  used.add(candidate);
  return candidate;
}

/** One fact per paragraph, carrying its `**Section**` heading as context. */
function factsFromMemoryBlob(blob: string): string[] {
  const facts: string[] = [];
  let section = "";
  for (const paragraph of blob.split(/\n\n+/)) {
    const trimmed = paragraph.trim();
    if (!trimmed) continue;
    const heading = /^\*{1,2}(.+?)\*{1,2}$/.exec(trimmed);
    if (heading && trimmed.length < 80) {
      section = heading[1].replace(/^\*+|\*+$/g, "").trim();
      continue;
    }
    facts.push(section ? `[${section}] ${trimmed}` : trimmed);
  }
  return facts;
}

async function main(): Promise<void> {
  const exportDir = arg("--export") ?? fail("--export <dir> is required");
  const workspaceDir = arg("--workspace") ?? fail("--workspace <dir> is required");
  const agentId = arg("--agent") ?? fail("--agent <id> is required");
  const perChat = has("--per-chat");
  const singleRoomId = arg("--room");
  if (perChat === Boolean(singleRoomId)) fail("exactly one of --room <id> or --per-chat is required");
  const force = has("--force");

  const conversationsPath = join(exportDir, "conversations.json");
  if (!existsSync(conversationsPath)) fail(`not a claude.ai export (missing conversations.json): ${exportDir}`);

  // --- agent ----------------------------------------------------------------
  const agentDir = join(globalAgentsPath(), agentId);
  if (!existsSync(agentDir)) {
    await scaffoldGlobalAgent(globalAgentsPath(), agentId, {
      tools: ["read", "edit", "write", "memory", "recall", "summon"],
    });
    console.log(`scaffolded agent ${agentId} at ${agentDir}`);
  }
  const memoryDir = agentPaths.memoryDir(agentDir);

  // --- workspace + room(s) ------------------------------------------------------
  await initWorkspace(workspaceDir);
  const conversations = (JSON.parse(await readFile(conversationsPath, "utf8")) as ExportConversation[])
    .filter((conversation) => conversation.chat_messages.length > 0)
    .sort((a, b) => a.created_at.localeCompare(b.created_at));

  // Leave the last transcript window "unseen" so the agent's FIRST live turn
  // gets the tail of the imported history injected as room context (a fresh
  // harness session starts blank otherwise — recall alone surfaces fragments
  // by relevance, not the actual last exchange). Everything older stays
  // behind the cursor: recalled, never replayed.
  const config = await readFile(workspacePaths.config(workspaceDir), "utf8").then(
    (raw) => JSON.parse(raw) as { transcriptWindow?: number },
    () => ({}) as { transcriptWindow?: number },
  );
  const window = config.transcriptWindow ?? DEFAULTS.transcriptWindow;

  // Which room each conversation's episode points at (per-chat: its own room).
  const roomIdFor = new Map<string, string>();
  const fallbackRoomId = singleRoomId ?? "imported";

  if (singleRoomId) {
    await ensureWorkspaceRoom(workspaceDir, singleRoomId);
    const transcriptPath = workspacePaths.transcript(workspaceDir, singleRoomId);
    const existingTranscript = await readFile(transcriptPath, "utf8");
    if (existingTranscript.trim() && !force) fail(`room ${singleRoomId} already has history (use --force to rewrite): ${transcriptPath}`);

    const events: RoomEvent[] = [];
    for (const conversation of conversations) events.push(...conversationEvents(conversation, agentId, true));

    await writeText(transcriptPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
    const state = normalizeRoomState(undefined);
    state.agentCursors[agentId] = Math.max(0, events.length - window);
    await writeJsonAtomic(workspacePaths.roomState(workspaceDir, singleRoomId), state);
    await setWorkspaceRoom(workspaceDir, singleRoomId);
    console.log(`room ${singleRoomId}: ${events.length} events from ${conversations.length} conversations`);
  } else {
    const used = new Set<string>();
    let imported = 0;
    let skipped = 0;
    for (const conversation of conversations) {
      const events = conversationEvents(conversation, agentId, false);
      if (events.length === 0) continue;
      const roomId = importRoomId(conversation, used);
      roomIdFor.set(conversation.uuid, roomId);
      await ensureWorkspaceRoom(workspaceDir, roomId);
      const transcriptPath = workspacePaths.transcript(workspaceDir, roomId);
      const existingTranscript = await readFile(transcriptPath, "utf8");
      if (existingTranscript.trim() && !force) {
        skipped += 1;
        continue;
      }
      const state = normalizeRoomState(undefined);
      state.title = conversation.name || "untitled";
      state.imported = conversation.created_at;
      state.agentCursors[agentId] = Math.max(0, events.length - window);
      await writeText(transcriptPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
      // Stamp the chat's own last-activity time onto the transcript: the
      // rooms list sorts by mtime (a chat list), so archives sit at their
      // historical position instead of flooding the top on import day.
      const activity = new Date(conversation.updated_at || conversation.created_at);
      if (!Number.isNaN(activity.getTime())) await utimes(transcriptPath, activity, activity);
      await writeJsonAtomic(workspacePaths.roomState(workspaceDir, roomId), state);
      imported += 1;
    }
    console.log(`rooms: ${imported} imported, ${skipped} already present (skipped)`);
  }
  if (has("--set-default")) await setWorkspaceDefaultAgent(workspaceDir, agentId);

  // --- episodes: one per conversation ----------------------------------------
  const episodesPath = join(memoryDir, "episodes.jsonl");
  if (existsSync(episodesPath) && !force) {
    console.log("episodes.jsonl already exists, skipping (use --force to rewrite)");
  } else {
    await writeText(episodesPath, "");
    for (const conversation of conversations) {
      const messages = [...conversation.chat_messages].sort((a, b) => a.created_at.localeCompare(b.created_at));
      const firstUser = messages.find((message) => message.sender === "human" && messageText(message));
      const lastAssistant = [...messages].reverse().find((message) => message.sender === "assistant" && messageText(message));
      if (!firstUser) continue;
      await appendEpisode(memoryDir, {
        id: newId("ep"),
        ts: conversation.updated_at,
        roomId: roomIdFor.get(conversation.uuid) ?? fallbackRoomId,
        agentId,
        task: `${conversation.name || "untitled"}: ${messageText(firstUser)}`,
        reply: lastAssistant ? messageText(lastAssistant) : "",
        outcome: "complete",
        channel: "text",
      });
    }
    console.log(`episodes: ${conversations.length} imported`);
  }

  // --- facts + topic files from memories.json --------------------------------
  const memoriesPath = join(exportDir, "memories.json");
  if (existsSync(memoriesPath)) {
    const memories = JSON.parse(await readFile(memoriesPath, "utf8")) as Array<{
      conversations_memory?: string;
      project_memories?: Record<string, string>;
    }>;
    const blob = memories[0]?.conversations_memory ?? "";
    const projectMemories = memories[0]?.project_memories ?? {};

    const factsPath = join(memoryDir, "facts.jsonl");
    if (existsSync(factsPath) && (await readFile(factsPath, "utf8")).trim() && !force) {
      console.log("facts.jsonl already has entries, skipping (use --force to rewrite)");
    } else {
      await writeText(factsPath, "");
      const now = new Date().toISOString();
      let written = 0;
      for (const text of [...factsFromMemoryBlob(blob), ...Object.values(projectMemories).flatMap(factsFromMemoryBlob)]) {
        const result = await appendFactOp(memoryDir, { op: "add", id: newId("fact"), ts: now, text, source: "consolidator", validFrom: now });
        if (result.ok) written += 1;
        else console.warn(`fact skipped: ${result.message}`);
      }
      console.log(`facts: ${written} imported`);
    }

    const chunks = splitForTopicFiles(blob);
    for (const [index, chunk] of chunks.entries()) {
      const suffix = chunks.length > 1 ? `-${index + 1}` : "";
      await writeText(join(memoryDir, `claude-ai-memory${suffix}.md`), `# claude.ai memory (imported)\n\n${chunk}\n`);
    }
    console.log(`topic files: ${chunks.length} from conversations_memory`);
  }

  // --- topic files from projects/ ---------------------------------------------
  const projectsDir = join(exportDir, "projects");
  if (existsSync(projectsDir)) {
    const memories = existsSync(memoriesPath)
      ? ((JSON.parse(await readFile(memoriesPath, "utf8")) as Array<{ project_memories?: Record<string, string> }>)[0]?.project_memories ?? {})
      : {};
    for (const file of await readdir(projectsDir)) {
      if (!file.endsWith(".json")) continue;
      const project = JSON.parse(await readFile(join(projectsDir, file), "utf8")) as ExportProject;
      const memory = memories[project.uuid] ?? "";
      const prompt = project.prompt_template?.trim() ?? "";
      if (!memory && !prompt) continue;
      const slug = (project.name || project.uuid).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
      const sections = [
        `# claude.ai project: ${project.name || project.uuid} (imported)`,
        prompt ? `## Project system prompt\n\n${prompt}` : "",
        memory ? `## Project memory\n\n${memory}` : "",
      ].filter(Boolean);
      await writeText(join(memoryDir, `claude-ai-project-${slug}.md`), `${sections.join("\n\n")}\n`);
      console.log(`topic file: claude-ai-project-${slug}.md`);
    }
  }

  console.log("done");
}

await main();
