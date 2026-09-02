// ---------------------------------------------------------------------------
// Thanks-Dario context sanitize (services/sanitize.ts)

/** One proposed rewrite of a past transcript event's text. `quote` must be an
 * exact substring of the event's current text — apply validates it, so a
 * hallucinated quote is skipped instead of corrupting the transcript. */
export interface SanitizeSuggestion {
  id: string;
  eventId: string;
  /** Author of the event being edited (display context for the review UI). */
  author: string;
  /** The original text this edit replaces. For a `whole`-message rewrite this
   *  is the entire event text; for a span edit it is the exact substring. */
  quote: string;
  replacement: string;
  reason: string;
  /** True when `quote` is the WHOLE message and `replacement` rewrites it end
   *  to end — the aggressive default, so no residual trigger word survives a
   *  surgical span-swap. The apply path is identical (quote→replacement); this
   *  only tells the UI to render it as a full-message rewrite. */
  whole?: boolean;
}

/** A named strategy grouping a subset of the suggestions (e.g. "light touch"
 * vs "full scrub") — the review UI preselects the chosen option's set. */
export interface SanitizeOption {
  id: string;
  label: string;
  description: string;
  suggestionIds: string[];
}

/** A reviewer's full proposal for a room, persisted as sanitize.json in the
 * room dir so a dismissed popup can be reopened. Nothing in it is applied
 * until the human approves specific suggestions. */
export interface SanitizeProposal {
  at: string;
  roomId: string;
  reviewer: string;
  /** How many transcript events the reviewer saw. */
  window: number;
  summary: string;
  options: SanitizeOption[];
  suggestions: SanitizeSuggestion[];
  /** Suggestions discarded at parse time (unknown event or stale quote). */
  discarded?: number;
  /** Raw reviewer reply, kept when it did not parse as the JSON contract. */
  raw?: string;
  parseError?: string;
  appliedAt?: string;
}

/** Lightweight sanitize state carried on the room snapshot. */
export interface SanitizeStatus {
  at: string;
  suggestions: number;
  appliedAt?: string;
}

