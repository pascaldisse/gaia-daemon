// Pi-native compaction behavior and its one SDK hook.
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import { compact as generatePiCompaction } from "@earendil-works/pi-coding-agent";
import type {
  CompactionResult,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { NO_SESSION_TO_COMPACT, type CompactResult } from "../../core/types.js";
import { findModelWithAlias } from "../model-aliases.js";
import type { PiSessionLike } from "./session.js";
const FORCE_COMPACT_KEEP_RECENT_TOKENS = 2000;
const COMPACT_FALLBACK_MODEL = {
  provider: "anthropic",
  name: "claude-sonnet-5",
} as const;
interface MechanicalCompactionInput {
  firstKeptEntryId: string;
  tokensBefore: number;
  previousSummary?: string;
  messagesToSummarize: unknown[];
  turnPrefixMessages: unknown[];
  fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> };
}
type SessionMap = {
  get(roomId: string): { session: PiSessionLike } | undefined;
};
const COMPACTION_META_ENTRY_TYPES = new Set([
  "compaction",
  "branch_summary",
  "thinking_level_change",
  "model_change",
  "label",
  "session_info",
]);
export function newestContentEntryId(
  entries: Array<Record<string, unknown>>,
  fallback: string,
): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (!entry) continue;
    const type = String(entry.type ?? "");
    if (COMPACTION_META_ENTRY_TYPES.has(type)) continue;
    const role = String(
      (entry.role as string | undefined) ??
        ((entry.message as { role?: string } | undefined)?.role ?? ""),
    );
    if (/tool/i.test(type) || /tool/i.test(role)) continue;
    if (entry.id) return String(entry.id);
  }
  return fallback;
}
type Registry = {
  find(provider: string, name: string): Model<any> | undefined;
  getApiKeyAndHeaders(
    model: Model<any>,
  ): Promise<
    | {
        ok: true;
        apiKey?: string;
        headers?: Record<string, string>;
        env?: Record<string, string>;
      }
    | { ok: false; error: string }
  >;
};
export function mechanicalCompactionFallback(
  preparation: MechanicalCompactionInput,
  failureReason: string,
): CompactionResult {
  const modified = new Set<string>([
    ...preparation.fileOps.edited,
    ...preparation.fileOps.written,
  ]);
  const readFiles = [...preparation.fileOps.read]
    .filter((f) => !modified.has(f))
    .sort();
  const modifiedFiles = [...modified].sort();
  const fileTags = [
    readFiles.length
      ? `<read-files>\n${readFiles.join("\n")}\n</read-files>`
      : "",
    modifiedFiles.length
      ? `<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`
      : "",
  ].filter(Boolean);
  const droppedCount =
    preparation.messagesToSummarize.length +
    preparation.turnPrefixMessages.length;
  const chain = preparation.previousSummary
    ? `\n\n<previous-summary>\n${preparation.previousSummary}\n</previous-summary>`
    : "";
  return {
    summary:
      `## Mechanical compaction (no LLM summary)\n` +
      `LLM summarization was unavailable (${failureReason}), and the fallback model IS this session's own model so retrying would repeat the identical failing call. ` +
      `${droppedCount} message(s) (~${preparation.tokensBefore} tokens before compaction) dropped WITHOUT a generated narrative recap -- recent context past the cut point is still retained verbatim as usual; this note only replaces the AI-written summary of the discarded history.` +
      `${chain}${fileTags.length ? `\n\n${fileTags.join("\n\n")}` : ""}`,
    firstKeptEntryId: preparation.firstKeptEntryId,
    tokensBefore: preparation.tokensBefore,
    details: { readFiles, modifiedFiles },
  };
}
function loadCleanCompactionOverride(
  roomId: string,
  agentId: string,
): string | undefined {
  try {
    const p = join(homedir(), ".pi", "agent", "clean-summaries", "index.json");
    if (!existsSync(p)) return undefined;
    const entry = (
      JSON.parse(readFileSync(p, "utf8")) as Record<
        string,
        { default?: string; agents?: Record<string, string> }
      >
    )[roomId];
    if (!entry) return undefined;
    if (entry.agents && typeof entry.agents[agentId] === "string")
      return entry.agents[agentId];
    return typeof entry.default === "string" ? entry.default : undefined;
  } catch {
    return undefined;
  }
}
async function runCompactionFallback(
  event: {
    preparation: unknown;
    customInstructions?: string;
    signal: AbortSignal;
  },
  ctx: { modelRegistry: Registry },
  provider: string | undefined,
  name: string | undefined,
): Promise<{ compaction: CompactionResult } | undefined> {
  if (provider !== COMPACT_FALLBACK_MODEL.provider) return undefined;
  const self = name === COMPACT_FALLBACK_MODEL.name;
  const model = findModelWithAlias(
    ctx.modelRegistry,
    COMPACT_FALLBACK_MODEL.provider,
    COMPACT_FALLBACK_MODEL.name,
  );
  if (!model) {
    console.warn(
      `compact-fallback: ${COMPACT_FALLBACK_MODEL.name} not in registry, using session's own model`,
    );
    return undefined;
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  if (!auth.ok) {
    console.warn(
      `compact-fallback: no credentials for ${COMPACT_FALLBACK_MODEL.provider} (${auth.error}), using session's own model`,
    );
    return undefined;
  }
  try {
    return {
      compaction: await generatePiCompaction(
        event.preparation as Parameters<typeof generatePiCompaction>[0],
        model,
        auth.apiKey,
        auth.headers,
        event.customInstructions,
        event.signal,
        undefined,
        undefined,
        auth.env,
      ),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (self) {
      console.warn(
        `compact-fallback: ${COMPACT_FALLBACK_MODEL.name} summarization failed (${message}) -- session's own model IS the fallback model, a retry would be identical; degrading to mechanical compaction`,
      );
      return {
        compaction: mechanicalCompactionFallback(
          event.preparation as MechanicalCompactionInput,
          message,
        ),
      };
    }
    console.warn(
      `compact-fallback: ${COMPACT_FALLBACK_MODEL.name} summarization failed (${message}), using session's own model`,
    );
    return undefined;
  }
}
export class PiCompaction {
  private readonly drafts = new Map<string, CompactionResult>();
  private readonly operations = new Map<
    string,
    { kind: "draft" | "apply"; editedSummary?: string }
  >();
  constructor(
    private readonly sessions: SessionMap,
    private readonly restore: (
      roomId: string,
    ) => Promise<PiSessionLike | undefined>,
    private readonly agentId: string,
  ) {}
  async compact(roomId: string): Promise<CompactResult> {
    const session = await this.session(roomId);
    if (!session) return NO_SESSION_TO_COMPACT;
    try {
      return this.result(await this.native(session));
    } catch (error) {
      const noOp = this.noOp(error);
      if (noOp) return noOp;
      throw error;
    }
  }
  async draft(
    roomId: string,
  ): Promise<{ compacted: boolean; message: string; summary?: string }> {
    const session = await this.session(roomId);
    if (!session) return NO_SESSION_TO_COMPACT;
    this.drafts.delete(roomId);
    this.operations.set(roomId, { kind: "draft" });
    try {
      await this.native(session);
    } catch (error) {
      if (!this.cancelled(error)) {
        const noOp = this.noOp(error);
        if (!noOp) throw error;
        return noOp;
      }
    } finally {
      this.operations.delete(roomId);
    }
    const draft = this.drafts.get(roomId);
    if (!draft)
      throw new Error(
        "compaction draft was cancelled before a summary was captured",
      );
    return { compacted: false, message: "draft ready", summary: draft.summary };
  }
  async apply(roomId: string, editedSummary: string): Promise<CompactResult> {
    if (!this.drafts.has(roomId))
      throw new Error("no draft — run /compact --edit first");
    const session = await this.session(roomId);
    if (!session) {
      this.drafts.delete(roomId);
      return NO_SESSION_TO_COMPACT;
    }
    this.operations.set(roomId, { kind: "apply", editedSummary });
    try {
      return this.result(await this.native(session));
    } catch (error) {
      const noOp = this.noOp(error);
      if (noOp) return noOp;
      throw error;
    } finally {
      this.operations.delete(roomId);
      this.drafts.delete(roomId);
    }
  }
  extension(
    roomId: string,
    provider: string | undefined,
    name: string | undefined,
  ): ExtensionFactory {
    return (pi) => {
      pi.on("session_before_compact", async (event, ctx) => {
        const operation = this.operations.get(roomId);
        if (!operation) {
          const clean = loadCleanCompactionOverride(roomId, this.agentId);
          if (clean) {
            const sessionManager = (
              ctx as unknown as {
                sessionManager?: { getEntries?: () => unknown[] };
              }
            ).sessionManager;
            const newestFloor = newestContentEntryId(
              (sessionManager?.getEntries?.() ?? []) as Array<
                Record<string, unknown>
              >,
              event.preparation.firstKeptEntryId,
            );
            return {
              compaction: {
                summary: clean,
                firstKeptEntryId: newestFloor,
                tokensBefore: event.preparation.tokensBefore,
                details: this.details(event.preparation),
              },
            };
          }
          return runCompactionFallback(event, ctx, provider, name);
        }
        if (operation.kind === "apply")
          return {
            compaction: {
              summary: operation.editedSummary ?? "",
              firstKeptEntryId: event.preparation.firstKeptEntryId,
              tokensBefore: event.preparation.tokensBefore,
              details: this.details(event.preparation),
            },
          };
        try {
          if (!ctx.model) throw new Error("no model set for compaction");
          const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
          if (!auth.ok) throw new Error(auth.error);
          this.drafts.set(
            roomId,
            await generatePiCompaction(
              event.preparation,
              ctx.model,
              auth.apiKey,
              auth.headers,
              event.customInstructions,
              event.signal,
              undefined,
              undefined,
              auth.env,
            ),
          );
        } catch (error) {
          this.drafts.set(
            roomId,
            mechanicalCompactionFallback(
              event.preparation,
              error instanceof Error ? error.message : String(error),
            ),
          );
        }
        return { cancel: true };
      });
    };
  }
  private async session(roomId: string): Promise<PiSessionLike | undefined> {
    return this.sessions.get(roomId)?.session?.compact
      ? this.sessions.get(roomId)!.session
      : this.restore(roomId);
  }
  private result(result: {
    summary: string;
    tokensBefore: number;
    estimatedTokensAfter?: number;
  }): CompactResult {
    const after =
      result.estimatedTokensAfter !== undefined
        ? ` → ~${result.estimatedTokensAfter}`
        : "";
    return {
      compacted: true,
      message: `session compacted (${result.tokensBefore} tokens before${after}).`,
      ...(result.summary ? { summary: result.summary } : {}),
    };
  }
  private async native(
    session: PiSessionLike,
  ): Promise<{
    summary: string;
    tokensBefore: number;
    estimatedTokensAfter?: number;
  }> {
    try {
      return await session.compact!();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/too small/i.test(message) || !session.settingsManager) throw error;
      const original = session.settingsManager.getCompactionKeepRecentTokens();
      session.settingsManager.applyOverrides({
        compaction: { keepRecentTokens: FORCE_COMPACT_KEEP_RECENT_TOKENS },
      });
      try {
        return await session.compact!();
      } finally {
        session.settingsManager.applyOverrides({
          compaction: { keepRecentTokens: original },
        });
      }
    }
  }
  private noOp(error: unknown): CompactResult | undefined {
    const message = error instanceof Error ? error.message : String(error);
    return /already compacted|too small/i.test(message)
      ? {
          compacted: false,
          message: `nothing to compact — ${message.toLowerCase()}.`,
        }
      : undefined;
  }
  private cancelled(error: unknown): boolean {
    return /compaction cancelled/i.test(
      error instanceof Error ? error.message : String(error),
    );
  }
  private details(preparation: MechanicalCompactionInput): {
    readFiles: string[];
    modifiedFiles: string[];
  } {
    const modified = new Set<string>([
      ...preparation.fileOps.edited,
      ...preparation.fileOps.written,
    ]);
    return {
      readFiles: [...preparation.fileOps.read]
        .filter((file) => !modified.has(file))
        .sort(),
      modifiedFiles: [...modified].sort(),
    };
  }
}
