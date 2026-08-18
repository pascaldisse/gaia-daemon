// Pure helpers for the Telegram <-> GAIA room bridge (scripts/telegram-bridge.mjs).
// Deliberately dependency-free and side-effect-free so they're unit-testable
// without a real bot token or a running daemon; the script wires them to
// actual network calls. AGENTS.md: channel bridges are plugins/standalone
// processes, never core — this bridge is a separate script that talks to the
// daemon purely over its existing public HTTP + SSE API (as an ordinary
// logged-in human, via domain/users.ts), no daemon source changes at all.

/** Telegram's hard cap on a single sendMessage's text. */
export const TELEGRAM_MAX_MESSAGE_LEN = 4096;

export interface TelegramInbound {
  chatId: number;
  text: string;
  /** Telegram username if set, else first+last name, else the numeric id as a string. */
  fromLabel: string;
  updateId: number;
}

/** One raw item from Telegram's getUpdates result array. Null = not a plain
 * text message this bridge handles (edits, non-text media, channel posts,
 * etc — never crash the poll loop over an update shape it doesn't know). */
export function parseTelegramUpdate(raw: unknown): TelegramInbound | null {
  if (!isRecord(raw)) return null;
  const updateId = raw.update_id;
  if (typeof updateId !== "number") return null;
  const message = raw.message;
  if (!isRecord(message)) return null;
  const chat = message.chat;
  if (!isRecord(chat) || typeof chat.id !== "number") return null;
  const text = message.text;
  if (typeof text !== "string" || !text.trim()) return null;
  const from = isRecord(message.from) ? message.from : undefined;
  const fromLabel =
    (typeof from?.username === "string" && from.username.trim()) ||
    [from?.first_name, from?.last_name].filter((v) => typeof v === "string" && v.trim()).join(" ").trim() ||
    (typeof from?.id === "number" ? String(from.id) : "telegram");
  return { chatId: chat.id, text, fromLabel, updateId };
}

/** getUpdates' `offset` param for the NEXT poll: one past the highest
 * update_id seen, so Telegram drops everything already delivered. Given no
 * updates, returns the previous offset unchanged (nothing to advance past). */
export function nextOffset(updates: readonly { update_id: number }[], previousOffset: number): number {
  let max = previousOffset - 1;
  for (const update of updates) if (update.update_id > max) max = update.update_id;
  return max + 1;
}

/** A GAIA room-event -> Telegram text, or null to skip (system/redacted noise,
 * empty text, or the human-authored echo — the bridge posts human messages
 * into the room ITSELF, so it must never re-send its own bridged message back
 * out as if an agent replied to it). `bridgeHumanId` is the bridge's own
 * domain/users.ts id (see telegram-bridge.mjs) so its own posts never loop. */
export function formatOutgoingForTelegram(
  event: { author: string; text: string; redacted?: boolean; humanId?: string },
  bridgeHumanId: string
): string | null {
  if (event.redacted) return null;
  if (event.author === "user") return null; // human messages never echo back
  if (event.author === "system") return null;
  if (event.humanId === bridgeHumanId) return null; // defensive, in case author semantics change
  const text = event.text.trim();
  if (!text) return null;
  return `[@${event.author}] ${text}`;
}

/** Telegram rejects a sendMessage over TELEGRAM_MAX_MESSAGE_LEN outright —
 * split on line boundaries where possible so a chunk never lands mid-word. */
export function splitForTelegram(text: string, maxLen: number = TELEGRAM_MAX_MESSAGE_LEN): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > maxLen) {
    let cut = rest.lastIndexOf("\n", maxLen);
    if (cut < maxLen * 0.5) cut = maxLen; // no reasonable line break — hard cut
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
