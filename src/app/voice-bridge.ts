// Bridges unmute's LLM protocol onto GAIA agent turns. unmute treats GAIA as
// an OpenAI-compatible chat-completions server: each voice turn arrives as the
// last user message of a /v1/chat/completions request. GAIA ignores unmute's
// own system prompt and history - the room transcript and the agent's Pi
// session are the source of truth - and only extracts what the user just said.

// Markers unmute inserts into its chat history (see unmute/llm/llm_utils.py).
const UNMUTE_GREETING_MESSAGE = "Hello.";
const UNMUTE_SILENCE_MARKER = "...";

export type VoiceTurnKind = "greeting" | "silence" | "user";

export interface VoiceTurn {
  kind: VoiceTurnKind;
  // What the user actually said ("" for greeting/silence turns).
  userText: string;
  // The message to run the agent turn with.
  agentMessage: string;
}

interface ChatMessage {
  role: string;
  content: string;
}

function chatMessages(body: unknown): ChatMessage[] {
  if (!body || typeof body !== "object") return [];
  const messages = (body as { messages?: unknown }).messages;
  if (!Array.isArray(messages)) return [];
  return messages.filter(
    (message): message is ChatMessage =>
      Boolean(message) &&
      typeof message === "object" &&
      typeof (message as ChatMessage).role === "string" &&
      typeof (message as ChatMessage).content === "string",
  );
}

export function isStreamingRequest(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  return (body as { stream?: unknown }).stream === true;
}

/**
 * Classifies the newest user message of an unmute chat-completions request.
 * unmute opens every call with a synthetic "Hello." user turn (the agent
 * greets first) and inserts "..." when the user has been silent for a while;
 * neither is something the user said, so they become prompts to the agent
 * rather than room transcript entries.
 */
export function classifyVoiceTurn(body: unknown): VoiceTurn | undefined {
  const messages = chatMessages(body);
  const userMessages = messages.filter((message) => message.role === "user");
  const last = userMessages.at(-1);
  if (!last) return undefined;

  const content = last.content.trim();
  if (content === UNMUTE_GREETING_MESSAGE && userMessages.length === 1) {
    return {
      kind: "greeting",
      userText: "",
      agentMessage: "(A voice call with you just started. Greet the user briefly in your own voice and invite them to talk.)",
    };
  }
  if (content === UNMUTE_SILENCE_MARKER) {
    return {
      kind: "silence",
      userText: "",
      agentMessage: "(The user on the voice call has been silent for a while. Briefly check in, pick the conversation back up, or comfortably let the silence be - vary it.)",
    };
  }
  return { kind: "user", userText: content, agentMessage: content };
}

const COMPLETION_MODEL = "gaia";

export function modelListPayload(): unknown {
  // unmute autoselects its model from this list when KYUTAI_LLM_MODEL is not
  // set; it requires exactly one entry.
  return { object: "list", data: [{ id: COMPLETION_MODEL, object: "model", created: 0, owned_by: "gaia" }] };
}

export function completionChunk(id: string, delta: string | undefined, finishReason: "stop" | null): string {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: COMPLETION_MODEL,
    choices: [
      {
        index: 0,
        delta: delta !== undefined ? { role: "assistant", content: delta } : {},
        finish_reason: finishReason,
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

export function completionDone(): string {
  return "data: [DONE]\n\n";
}

export function completionPayload(id: string, text: string): unknown {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: COMPLETION_MODEL,
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
  };
}

export function newCompletionId(): string {
  return `chatcmpl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
