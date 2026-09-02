// Telegram bridge package. The standalone bridge reaches it only through the
// typed channel contribution registered from this manifest package.

export const TELEGRAM_MAX_MESSAGE_LEN = 4096;

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function parseTelegramUpdate(raw) {
  const update = record(raw);
  const message = record(update?.message);
  const chat = record(message?.chat);
  const from = record(message?.from);
  if (typeof update?.update_id !== "number" || !Number.isFinite(update.update_id)
    || typeof chat?.id !== "number" || !Number.isFinite(chat.id)
    || typeof message?.text !== "string" || !message.text.trim()) return null;
  const fromLabel = (typeof from?.username === "string" && from.username.trim())
    || [from?.first_name, from?.last_name].filter((part) => typeof part === "string" && part.trim()).join(" ").trim()
    || (typeof from?.id === "number" ? String(from.id) : "telegram");
  return { updateId: update.update_id, chatId: chat.id, fromLabel, text: message.text };
}

function nextOffset(updates, previous) {
  let maximum = previous - 1;
  for (const raw of updates) {
    const update = record(raw);
    if (typeof update?.update_id === "number" && update.update_id > maximum) maximum = update.update_id;
  }
  return maximum + 1;
}

function formatOutgoing(event, bridgeUserId) {
  const value = record(event);
  if (typeof value?.author !== "string" || typeof value.text !== "string") return null;
  if (value.redacted || value.author === "user" || value.author === "system" || value.humanId === bridgeUserId) return null;
  const text = value.text.trim();
  return text ? `[@${value.author}] ${text}` : null;
}

function split(text, maxLength = TELEGRAM_MAX_MESSAGE_LEN) {
  if (text.length <= maxLength) return [text];
  const chunks = [];
  let rest = text;
  while (rest.length > maxLength) {
    let cut = rest.lastIndexOf("\n", maxLength);
    if (cut < maxLength * 0.5) cut = maxLength;
    chunks.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}

export function register() {
  return {
    contributions: {
      channels: [{
        name: "telegram",
        handle: (_context, request) => {
          if (request.direction === "incoming") {
            const payload = record(request.payload);
            if (Array.isArray(payload?.updates) && typeof payload.offset === "number") {
              return { handled: true, payload: { offset: nextOffset(payload.updates, payload.offset) } };
            }
            const parsed = parseTelegramUpdate(request.payload);
            return parsed ? { handled: true, payload: parsed } : { handled: false };
          }
          const payload = record(request.payload);
          const text = formatOutgoing(payload?.event, payload?.bridgeUserId);
          return text === null ? { handled: false } : { handled: true, payload: { chunks: split(text) } };
        },
      }],
    },
  };
}
