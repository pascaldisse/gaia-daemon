// Autobiographical compaction: the fold is a memory the agent writes about
// itself, in its own voice, with its own model — not a 3rd-person checkpoint.
// Ideas + marker/instruction wording ported from connectome-host's
// AutobiographicalStrategy (@animalabs/context-manager 0.11.0, MIT, Anima
// Labs). Design + gap table: docs/connectome-memory.md.
//
// Summary layout (order IS the cache property — KV-stable fold):
//   <stable-prefix>  first N folded messages, verbatim, written ONCE, then
//                    carried byte-identical through every later fold
//   <recall-index>   append-only one-liners for the oldest material; old lines
//                    never rewritten, new lines only appended
//   <memory resolution="coarse">  older windows, brief
//   <memory resolution="detail">  newest folded window, detailed
// pi renders the summary right after the system prompt, so system + head +
// old index lines form a prefix that survives every compaction unchanged.
import type { Model } from "@earendil-works/pi-ai";
import { convertToLlm, serializeConversation } from "@earendil-works/pi-coding-agent";
import type { CompactionResult } from "@earendil-works/pi-coding-agent";
import { COMPACT_MEMORY_DEFAULTS, type CompactMemoryConfig } from "../../core/compact-memory.js";

/** connectome COMPRESSION_MARKER, verbatim: an in-band recurring event, not a
 * fresh instruction — the agent has seen this exact line before every fold. */
export const COMPRESSION_MARKER =
  "System: You will soon form a new memory, get ready. " +
  "The messages that follow are the slice of recent experience you are " +
  "about to compress. After them, write the memory in your own voice.";

/** connectome summarySystemPrompt, appended to the agent's OWN system prompt. */
export const MEMORY_FRAMING =
  "You are forming a memory of an earlier part of this conversation. The context you see is " +
  "continuous with your experience - what you read is what happened. Write authentically about what occurred.";

/** connectome summaryContextLabel: prior memory is replayed as the agent's own answer to this. */
export const RECALL_QUESTION = "What do you remember from earlier?";

const PREFIX_OPEN = "<stable-prefix>";
const PREFIX_CLOSE = "</stable-prefix>";
const INDEX_OPEN = "<recall-index>";
const INDEX_CLOSE = "</recall-index>";

export interface AutobioPreparation {
  firstKeptEntryId: string;
  tokensBefore: number;
  previousSummary?: string;
  messagesToSummarize: unknown[];
  turnPrefixMessages: unknown[];
  fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> };
}

export interface ParsedMemory {
  /** Exact bytes from PREFIX_OPEN through PREFIX_CLOSE, or undefined. */
  prefix?: string;
  /** Index lines, verbatim, in order. */
  index: string[];
  coarse?: string;
  detail?: string;
}

type WindowResolution = "line" | "coarse" | "detail";
interface FoldWindow {
  resolution: WindowResolution;
  /** Per-message serialized text (pi serializeConversation format). */
  texts: string[];
  firstTs?: number;
  lastTs?: number;
  targetTokens: number;
}

export interface FoldPlan {
  /** Newly pinned head (first fold only), else undefined. */
  newPrefixTexts?: string[];
  windows: FoldWindow[];
}

// ---------------------------------------------------------------- parsing

function section(text: string, open: string, close: string): { body: string; raw: string } | undefined {
  const start = text.indexOf(open);
  if (start < 0) return undefined;
  const end = text.indexOf(close, start + open.length);
  if (end < 0) return undefined;
  return { body: text.slice(start + open.length, end), raw: text.slice(start, end + close.length) };
}

function memoryBlock(text: string, resolution: "coarse" | "detail"): string | undefined {
  const match = new RegExp(`<memory resolution="${resolution}"[^>]*>\\n?([\\s\\S]*?)\\n?</memory>`).exec(text);
  return match?.[1]?.trim() || undefined;
}

/** Parse a previous fold. A legacy (pi checkpoint) summary → all of it is detail. */
export function parseMemorySummary(summary: string | undefined): ParsedMemory {
  if (!summary?.trim()) return { index: [] };
  const prefix = section(summary, PREFIX_OPEN, PREFIX_CLOSE)?.raw;
  const indexBody = section(summary, INDEX_OPEN, INDEX_CLOSE)?.body;
  const index = indexBody ? indexBody.split("\n").filter((line) => line.trim()) : [];
  const coarse = memoryBlock(summary, "coarse");
  const detail = memoryBlock(summary, "detail");
  if (prefix || indexBody !== undefined || coarse || detail) return { prefix, index, coarse, detail };
  return { index: [], detail: stripFileTags(summary).trim() };
}

function stripFileTags(text: string): string {
  return text.replace(/<(read|modified)-files>[\s\S]*?<\/\1-files>/g, "");
}

// ---------------------------------------------------------------- planning

function serializeMessage(message: unknown): string {
  return serializeConversation(convertToLlm([message] as Parameters<typeof convertToLlm>[0]));
}

function timestampOf(message: unknown): number | undefined {
  const ts = (message as { timestamp?: unknown })?.timestamp;
  return typeof ts === "number" && Number.isFinite(ts) ? ts : undefined;
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…[+${text.length - max} chars]`;
}

/** Split folded messages into head (first fold only) + age windows. Pure. */
export function planFold(messages: unknown[], previous: ParsedMemory, config: CompactMemoryConfig = COMPACT_MEMORY_DEFAULTS): FoldPlan {
  const texts = messages.map(serializeMessage);
  const stamps = messages.map(timestampOf);
  let start = 0;
  let newPrefixTexts: string[] | undefined;
  // Head is pinned exactly once: only when no earlier fold owns a prefix AND
  // this fold starts at the true session start (no previous summary at all).
  if (!previous.prefix && !previous.detail && !previous.coarse && config.stablePrefixEvents > 0) {
    const headCount = Math.min(config.stablePrefixEvents, Math.max(0, texts.length - 1));
    newPrefixTexts = texts.slice(0, headCount).map((text) => clip(text, config.stablePrefixMaxChars));
    start = headCount;
  }
  const rest = texts.slice(start);
  const restStamps = stamps.slice(start);
  const count = config.adaptiveResolution ? Math.max(1, Math.min(config.resolutionWindows, rest.length)) : 1;
  const windows: FoldWindow[] = [];
  if (rest.length) {
    // Equal-CHAR windows (token-proportional), oldest first.
    const total = rest.reduce((sum, text) => sum + text.length, 0) || 1;
    let cursor = 0;
    for (let w = 0; w < count; w += 1) {
      const boundary = (total * (w + 1)) / count;
      const from = cursor;
      let acc = rest.slice(0, cursor).reduce((sum, text) => sum + text.length, 0);
      // Leave at least one message for every later window.
      const maxEnd = rest.length - (count - 1 - w);
      while (cursor < maxEnd && (cursor === from || acc + rest[cursor]!.length <= boundary || w === count - 1)) {
        acc += rest[cursor]!.length;
        cursor += 1;
      }
      const age = count - 1 - w; // 0 = newest
      const resolution: WindowResolution = age === 0 ? "detail" : w === 0 && count >= 3 ? "line" : "coarse";
      windows.push({
        resolution,
        texts: rest.slice(from, cursor),
        firstTs: restStamps.slice(from, cursor).find((ts) => ts !== undefined),
        lastTs: [...restStamps.slice(from, cursor)].reverse().find((ts) => ts !== undefined),
        targetTokens: Math.max(64, Math.round(config.detailTargetTokens / config.resolutionDecay ** age)),
      });
    }
  }
  return { ...(newPrefixTexts?.length ? { newPrefixTexts } : {}), windows };
}

// ---------------------------------------------------------------- recall index

const STOP = new Set("about above after again against because before being below between could doing during further having other should their there these those through under until which while would where there's that's what's assistant user thinking calls".split(" "));

/** Salient terms for a recall query: most frequent ≥5-char words, ties by first use. */
function recallTerms(text: string, limit = 4): string[] {
  const counts = new Map<string, { n: number; first: number }>();
  let position = 0;
  for (const word of text.toLowerCase().match(/[a-zà-ÿ0-9_./-]{5,}/g) ?? []) {
    position += 1;
    const clean = word.replace(/^[./-]+|[./-]+$/g, "");
    if (clean.length < 5 || STOP.has(clean) || /^\d+$/.test(clean)) continue;
    const hit = counts.get(clean);
    if (hit) hit.n += 1;
    else counts.set(clean, { n: 1, first: position });
  }
  return [...counts.entries()].sort((a, b) => b[1].n - a[1].n || a[1].first - b[1].first).slice(0, limit).map(([word]) => word);
}

function isoMinute(ts: number | undefined): string {
  return ts === undefined ? "?" : new Date(ts).toISOString().slice(0, 16).replace("T", " ");
}

/** Mechanical one-liner (no LLM): span · size · first ask · recall pointer. */
function indexLine(window: Pick<FoldWindow, "texts" | "firstTs" | "lastTs">, maxChars: number): string {
  const joined = window.texts.join("\n");
  const firstUser = window.texts.find((text) => text.startsWith("[User]:"))?.slice(7).trim() ?? window.texts[0] ?? "";
  const ask = firstUser.replace(/\s+/g, " ").slice(0, 90);
  const terms = recallTerms(joined);
  const line = `- ${isoMinute(window.firstTs)}→${isoMinute(window.lastTs)} · ${window.texts.length} msgs · "${ask}"${terms.length ? ` → recall "${terms.join(" ")}"` : ""}`;
  return line.length <= maxChars ? line : `${line.slice(0, maxChars - 1)}…`;
}

/** Demote a previous coarse memory to ONE index line (first sentence, bounded). */
function demoteToLine(memory: string, maxChars: number): string {
  const flat = memory.replace(/\s+/g, " ").trim();
  const sentence = /^(.+?[.!?])(\s|$)/.exec(flat)?.[1] ?? flat;
  const terms = recallTerms(memory);
  const line = `- earlier memory: ${sentence}${terms.length ? ` → recall "${terms.join(" ")}"` : ""}`;
  return line.length <= maxChars ? line : `${line.slice(0, maxChars - 1)}…`;
}

// ---------------------------------------------------------------- request

export interface VoicedRequest {
  systemPrompt: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  wantsCoarse: boolean;
}

function substantiveChars(texts: string[]): number {
  return texts.reduce((sum, text) => sum + text.replace(/^\[[^\]]+\]:\s*/, "").trim().length, 0);
}

/** connectome formatInstruction, generalized to the two-resolution output. */
function memoryInstruction(agentName: string, detailTokens: number, coarseTokens: number | undefined): string {
  const self = `You are ${agentName}; this memory is yours.`;
  const shared =
    "Speak in the first person from your own perspective (\"I …\"), never as an observer describing \"the assistant\". " +
    "Preserve concrete details — file paths, exact values, commit hashes, decisions, unresolved questions, the user's active asks. " +
    "Write it as you knew it then — no hindsight about how things turned out. " +
    "Memorize only what actually happened: a quiet stretch deserves a short memory; do not re-narrate what you already remember as if it happened again. " +
    "No preamble, no meta-commentary about summarizing.";
  if (coarseTokens === undefined) {
    return `${self} Write the memory of events since the most recent memory system notification, inside <detail>…</detail>. ${shared} Target ~${detailTokens} tokens.`;
  }
  return (
    `${self} Write TWO memories. First <coarse>…</coarse>: a brief memory (~${coarseTokens} tokens) folding what I already remember together with the EARLIER slice — themes, decisions, what stayed open. ` +
    `Then <detail>…</detail>: a detailed memory (~${detailTokens} tokens) of the MOST RECENT slice. ${shared}`
  );
}

function buildVoicedRequest(input: {
  agentName: string;
  agentSystemPrompt?: string;
  plan: FoldPlan;
  previous: ParsedMemory;
  config: CompactMemoryConfig;
}): VoicedRequest | undefined {
  const { plan, previous, config } = input;
  const detail = plan.windows.find((window) => window.resolution === "detail");
  const coarse = plan.windows.filter((window) => window.resolution === "coarse");
  const carried = [previous.coarse, previous.detail].filter((part): part is string => Boolean(part?.trim()));
  const coarseTexts = coarse.flatMap((window) => window.texts);
  const detailTexts = detail?.texts ?? [];
  const hasCoarse = substantiveChars(coarseTexts) >= config.minWindowChars || carried.length > 0;
  if (substantiveChars(detailTexts) < config.minWindowChars && !hasCoarse) return undefined;
  const coarseTokens = hasCoarse && config.adaptiveResolution
    ? coarse.reduce((sum, window) => Math.max(sum, window.targetTokens), 0) || Math.round(config.detailTargetTokens / config.resolutionDecay)
    : undefined;
  const system = [input.agentSystemPrompt?.trim(), MEMORY_FRAMING].filter(Boolean).join("\n\n");
  const messages: VoicedRequest["messages"] = [];
  if (carried.length) {
    // Prior memory replayed as MY OWN answer (connectome recall pair), not notes.
    messages.push({ role: "user", content: RECALL_QUESTION });
    messages.push({ role: "assistant", content: carried.join("\n\n") });
  }
  const slices = [
    ...(coarseTokens !== undefined && coarseTexts.length ? [`<earlier-slice>\n${coarseTexts.join("\n\n")}\n</earlier-slice>`] : []),
    `<recent-slice>\n${(coarseTokens === undefined ? [...coarseTexts, ...detailTexts] : detailTexts).join("\n\n")}\n</recent-slice>`,
  ];
  messages.push({
    role: "user",
    content: `${COMPRESSION_MARKER}\n\n${slices.join("\n\n")}\n\n${memoryInstruction(input.agentName, detail?.targetTokens ?? config.detailTargetTokens, coarseTokens)}`,
  });
  return { systemPrompt: system, messages, wantsCoarse: coarseTokens !== undefined };
}

/** connectome stripThinkingPreamble + tag extraction; untagged → all detail. */
function parseMemoryOutput(text: string, wantsCoarse: boolean): { coarse?: string; detail: string } {
  const unwrapped = text.replace(/^\s*<thinking>([\s\S]*)<\/thinking>\s*$/, "$1").replace(/<thinking>[\s\S]*?<\/thinking>/g, "").trim();
  const tag = (name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(unwrapped)?.[1]?.trim();
  const detail = tag("detail");
  const coarse = wantsCoarse ? tag("coarse") : undefined;
  if (detail) return { ...(coarse ? { coarse } : {}), detail };
  return { detail: unwrapped.replace(/<\/?(coarse|detail)>/g, "").trim() };
}

// ---------------------------------------------------------------- assembly

function renderPrefix(texts: string[]): string {
  return `${PREFIX_OPEN}\n${texts.join("\n\n")}\n${PREFIX_CLOSE}`;
}

function assembleMemorySummary(parts: {
  prefix?: string;
  index: string[];
  coarse?: string;
  detail?: string;
  agentName: string;
  fileTags?: string;
}): string {
  const blocks: string[] = [];
  if (parts.prefix) blocks.push(parts.prefix);
  if (parts.index.length) blocks.push(`${INDEX_OPEN}\n${parts.index.join("\n")}\n${INDEX_CLOSE}`);
  if (parts.coarse) blocks.push(`<memory resolution="coarse" by="${parts.agentName}">\n${parts.coarse}\n</memory>`);
  if (parts.detail) blocks.push(`<memory resolution="detail" by="${parts.agentName}">\n${parts.detail}\n</memory>`);
  return `${blocks.join("\n\n")}${parts.fileTags ?? ""}`;
}

function fileLists(fileOps: AutobioPreparation["fileOps"]): { readFiles: string[]; modifiedFiles: string[]; tags: string } {
  const modified = new Set([...fileOps.edited, ...fileOps.written]);
  const readFiles = [...fileOps.read].filter((file) => !modified.has(file)).sort();
  const modifiedFiles = [...modified].sort();
  const tags = [
    readFiles.length ? `<read-files>\n${readFiles.join("\n")}\n</read-files>` : "",
    modifiedFiles.length ? `<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>` : "",
  ].filter(Boolean);
  return { readFiles, modifiedFiles, tags: tags.length ? `\n\n${tags.join("\n\n")}` : "" };
}

// ---------------------------------------------------------------- entry

export type MemoryLlm = (model: Model<any>, request: VoicedRequest, options: { maxTokens: number; signal?: AbortSignal; reasoning?: string }) => Promise<string>;

export interface AutobioDeps {
  agentName: string;
  agentSystemPrompt?: string;
  /** Ordered candidates; first that returns non-empty text wins. */
  models: Array<Model<any>>;
  llm: MemoryLlm;
  config?: CompactMemoryConfig;
  signal?: AbortSignal;
  /** Resolved reasoning level ("off"/undefined = none requested). */
  reasoning?: string;
}

/** One fold. NEVER throws: model failure → mechanical fold; any other
 * failure (layout/parse) → last-resort fold that carries the previous
 * prefix + index byte-identical. */
export async function autobiographicalCompaction(preparation: AutobioPreparation, deps: AutobioDeps): Promise<CompactionResult> {
  try {
    return await foldOnce(preparation, deps);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`autobio-compaction: fold failed (${reason}); last-resort fold keeps prefix/index`);
    return lastResortFold(preparation, deps.agentName, reason);
  }
}

function lastResortFold(preparation: AutobioPreparation, agentName: string, reason: string): CompactionResult {
  const previousSummary = preparation.previousSummary ?? "";
  const prefix = section(previousSummary, PREFIX_OPEN, PREFIX_CLOSE)?.raw;
  const indexBody = section(previousSummary, INDEX_OPEN, INDEX_CLOSE)?.body;
  const index = indexBody ? indexBody.split("\n").filter((line) => line.trim()) : [];
  const prior = memoryBlock(previousSummary, "detail") ?? memoryBlock(previousSummary, "coarse")
    ?? (prefix || indexBody !== undefined ? undefined : stripFileTags(previousSummary).trim() || undefined);
  const folded = (preparation.messagesToSummarize?.length ?? 0) + (preparation.turnPrefixMessages?.length ?? 0);
  const detail = `(Mechanical fold — no recollection formed: ${reason.length > 240 ? `${reason.slice(0, 240)}…` : reason}. ${folded} messages folded; their raw record stays in the room transcript → recall it.)`;
  let files = { readFiles: [] as string[], modifiedFiles: [] as string[], tags: "" };
  try { files = fileLists(preparation.fileOps); } catch { /* keep empty */ }
  return {
    summary: assembleMemorySummary({ prefix, index, coarse: prior, detail, agentName, fileTags: files.tags }),
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    details: { readFiles: files.readFiles, modifiedFiles: files.modifiedFiles },
  };
}

async function foldOnce(preparation: AutobioPreparation, deps: AutobioDeps): Promise<CompactionResult> {
  const config = deps.config ?? COMPACT_MEMORY_DEFAULTS;
  const previous = parseMemorySummary(preparation.previousSummary);
  const folded = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
  const plan = planFold(folded, previous, config);
  const prefix = previous.prefix ?? (plan.newPrefixTexts ? renderPrefix(plan.newPrefixTexts) : undefined);
  // Append-only index: old lines verbatim, then demoted prior coarse, then new oldest windows.
  const index = [...previous.index];
  const request = buildVoicedRequest({ agentName: deps.agentName, agentSystemPrompt: deps.agentSystemPrompt, plan, previous, config });
  if (config.adaptiveResolution && previous.coarse && request?.wantsCoarse) {
    // prior coarse is re-folded into the new coarse by the model AND leaves a pointer line.
    index.push(demoteToLine(previous.coarse, config.indexLineChars));
  }
  for (const window of plan.windows) {
    if (window.resolution === "line") index.push(indexLine(window, config.indexLineChars));
  }
  let coarse: string | undefined;
  let detail: string | undefined;
  if (request) {
    const failures: string[] = [];
    for (const model of deps.models) {
      try {
        const text = await deps.llm(model, request, { maxTokens: config.maxOutputTokens, signal: deps.signal, ...(deps.reasoning && deps.reasoning !== "off" ? { reasoning: deps.reasoning } : {}) });
        const parsed = parseMemoryOutput(text, request.wantsCoarse);
        if (!parsed.detail) throw new Error("empty memory");
        ({ coarse, detail } = parsed);
        break;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        failures.push(`${model.provider}/${model.id}: ${reason.length > 240 ? `${reason.slice(0, 240)}…` : reason}`);
      }
    }
    if (detail === undefined) {
      // Mechanical degrade that STILL keeps prefix + index + prior memory, so a
      // failed fold never breaks the stable prefix.
      console.warn(`autobio-compaction: memory formation failed on every model (${failures.join("; ") || "no model"}); mechanical fold`);
      coarse = [previous.coarse, previous.detail].filter(Boolean).join("\n\n") || undefined;
      detail = `(Mechanical fold — no recollection formed: ${failures.join("; ") || "no model"}. ${folded.length} messages folded; their raw record stays in the room transcript → recall it.)`;
    }
  } else {
    // Thin fold: nothing substantive to remember — stub, no LLM (connectome thin-chunk guard).
    detail = `(A quiet stretch: ${folded.length} messages of routine traffic. Nothing happened worth remembering.)`;
    coarse = previous.coarse ?? previous.detail;
  }
  const files = fileLists(preparation.fileOps);
  return {
    summary: assembleMemorySummary({ prefix, index, coarse, detail, agentName: deps.agentName, fileTags: files.tags }),
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    details: { readFiles: files.readFiles, modifiedFiles: files.modifiedFiles },
  };
}

/** Default LLM transport: pi-ai completeSimple (same path consolidation uses). */
export function piMemoryLlm(auth: (model: Model<any>) => Promise<{ apiKey?: string; headers?: Record<string, string>; env?: Record<string, string> }>): MemoryLlm {
  return async (model, request, options) => {
    const { completeSimple } = await import("@earendil-works/pi-ai/compat");
    const credentials = await auth(model);
    const message = await completeSimple(
      model,
      {
        systemPrompt: request.systemPrompt,
        messages: request.messages.map((m) => m.role === "user"
          ? { role: "user" as const, content: m.content, timestamp: Date.now() }
          : { role: "assistant" as const, content: [{ type: "text" as const, text: m.content }], api: model.api, provider: model.provider, model: model.id, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" as const, timestamp: Date.now() }),
      },
      { maxTokens: Math.min(options.maxTokens, model.maxTokens > 0 ? model.maxTokens : options.maxTokens), ...(options.signal ? { signal: options.signal } : {}), ...(model.reasoning && options.reasoning ? { reasoning: options.reasoning as never } : {}), ...credentials },
    );
    if (message.stopReason === "error" || message.stopReason === "aborted") throw new Error(message.errorMessage ?? "memory model call failed");
    return message.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("");
  };
}
