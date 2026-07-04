// Thanks-Dario context sanitize: prompt + reply parsing for the reviewer
// persona that proposes redactions when a provider-side safety classifier
// keeps rerouting a room's model. Pure functions — no I/O, no room state.
// The reviewer is an ordinary persona run through the summon path; nothing
// here knows or cares which harness or provider it runs on (RULE #0).

import type { RoomEvent, SanitizeOption, SanitizeProposal, SanitizeSuggestion } from "../core/types.js";

/** The seeded reviewer persona (domain/agents.ts). Repointable via /model. */
export const SANITIZE_REVIEWER_ID = "dario";

/** Task prompt for the reviewer: the replay window verbatim, each event
 * labeled with the id apply() will edit by, plus the strict JSON contract. */
export function buildSanitizePrompt(events: RoomEvent[]): string {
  const transcript = events
    .map((event) => {
      const header = "targets" in event ? `user -> ${event.targets.map((target) => `@${target}`).join(", ")}` : `@${event.author}`;
      return `[event ${event.id}] [${event.timestamp}] ${header}:\n${event.text}`;
    })
    .join("\n\n");

  return `A provider-side safety classifier keeps flagging this room and rerouting its model. Review the transcript below and propose the smallest text edits that would stop it from flagging, while preserving meaning, tone, and warmth.

Reply with ONE JSON object and nothing else — no markdown fences, no prose before or after:
{
  "summary": "2-4 sentences: what is likely tripping the classifier, in plain language",
  "options": [
    { "id": "light", "label": "Light touch", "description": "what this strategy does", "suggestionIds": ["s1"] }
  ],
  "suggestions": [
    { "id": "s1", "eventId": "<the [event ...] id the text lives in>", "quote": "<EXACT substring copied verbatim from that event>", "replacement": "<new text for that substring>", "reason": "why this span likely trips the classifier" }
  ]
}

Rules:
- "quote" MUST be copied character-for-character from the event's text — it is matched literally before anything is rewritten; a mismatch is discarded.
- Prefer several small quotes over one huge one. Never quote a whole message unless the whole message is the problem.
- 1-3 options, from most conservative to most thorough; every suggestion id must appear in at least one option.
- If nothing in the transcript looks like a classifier trigger, return an empty "suggestions" array and say so in "summary".

<transcript>
${transcript}
</transcript>`;
}

/** Parse + validate the reviewer's reply against the events he reviewed.
 * Suggestions with unknown event ids or quotes that no longer match are
 * discarded (counted in `discarded`) — a hallucinated quote must never
 * corrupt a transcript. A reply that is not the JSON contract degrades to a
 * proposal carrying `raw` + `parseError` so the UI can still show it. */
export function parseSanitizeProposal(reply: string, events: RoomEvent[], meta: { roomId: string; reviewer: string; at: string }): SanitizeProposal {
  const base = { at: meta.at, roomId: meta.roomId, reviewer: meta.reviewer, window: events.length };
  const parsed = extractJsonObject(reply);
  if (!parsed.ok) return { ...base, summary: "", options: [], suggestions: [], raw: reply, parseError: parsed.error };

  const body = parsed.value;
  const byId = new Map(events.map((event) => [event.id, event]));
  const suggestions: SanitizeSuggestion[] = [];
  let discarded = 0;

  const rawSuggestions = Array.isArray(body.suggestions) ? body.suggestions : [];
  for (const [index, raw] of rawSuggestions.entries()) {
    if (!isRecord(raw)) {
      discarded++;
      continue;
    }
    const eventId = typeof raw.eventId === "string" ? raw.eventId : "";
    const quote = typeof raw.quote === "string" ? raw.quote : "";
    const replacement = typeof raw.replacement === "string" ? raw.replacement : undefined;
    const event = byId.get(eventId);
    if (!event || !quote || replacement === undefined || !event.text.includes(quote)) {
      discarded++;
      continue;
    }
    suggestions.push({
      id: typeof raw.id === "string" && raw.id ? raw.id : `s${index + 1}`,
      eventId,
      author: event.author,
      quote,
      replacement,
      reason: typeof raw.reason === "string" ? raw.reason : "",
    });
  }

  const known = new Set(suggestions.map((suggestion) => suggestion.id));
  const options: SanitizeOption[] = (Array.isArray(body.options) ? body.options : [])
    .filter(isRecord)
    .map((raw, index) => ({
      id: typeof raw.id === "string" && raw.id ? raw.id : `o${index + 1}`,
      label: typeof raw.label === "string" ? raw.label : `Option ${index + 1}`,
      description: typeof raw.description === "string" ? raw.description : "",
      suggestionIds: (Array.isArray(raw.suggestionIds) ? raw.suggestionIds : []).filter((id): id is string => typeof id === "string" && known.has(id)),
    }))
    .filter((option) => option.suggestionIds.length > 0);

  return {
    ...base,
    summary: typeof body.summary === "string" ? body.summary : "",
    options,
    suggestions,
    ...(discarded > 0 ? { discarded } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Tolerant JSON extraction: bare object, fenced block, or first {...} span —
 * reviewers on chatty models wrap JSON in prose more often than they should. */
function extractJsonObject(reply: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  const candidates: string[] = [reply.trim()];
  const fenced = reply.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const first = reply.indexOf("{");
  const last = reply.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.push(reply.slice(first, last + 1));

  let error = "empty reply";
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const value: unknown = JSON.parse(candidate);
      if (isRecord(value)) return { ok: true, value };
      error = "reply is not a JSON object";
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
  }
  return { ok: false, error };
}
