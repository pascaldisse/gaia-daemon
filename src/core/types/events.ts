// The single vocabulary. Every layer speaks these types; no layer redefines
// them. On-disk shapes (transcript.jsonl lines, state.json, agent.json,
// .gaia/config.json) are v1-compatible: v2 adds optional fields, never
// requires them.

// ---------------------------------------------------------------------------
// Room events (transcript.jsonl lines)

export interface ToolDetail {
  id: string;
  toolName: string;
  status: "running" | "complete" | "error";
  args?: unknown;
  partialResult?: unknown;
  result?: unknown;
}

/** A provider-side model switch during a turn (capacity fallback, safety
 * reroute, model retirement). `reason` is the harness's human-readable
 * explanation, passed through verbatim. */
export interface ModelFallback {
  from: string;
  to: string;
  reason: string;
}

/** A file pasted into the composer and attached to a user message. The bytes
 * live durably under the room's files/ dir; `path` is the absolute location on
 * the daemon host (readable by every harness's tools), `name` the original
 * client-side filename shown in the UI. */
export interface MessageAttachment {
  name: string;
  mime: string;
  size: number;
  path: string;
}

/** One segment of an agent turn in the order it actually streamed. The harness
 * event stream interleaves prose, thinking, and tool calls (text → tool →
 * text → thinking → …); `MessageBlock[]` preserves that order so the UI renders
 * inline like a native agent transcript instead of the flattened
 * thinking→tools→text buckets. `text`/`thinking` carry their span inline;
 * `tool` references a `ToolDetail` in `EventDetails.tools[]` by id (the tool's
 * live status/args/result stay the single source of truth). Thinking can occur
 * more than once per turn, so multiple `thinking` blocks are expected. */
export interface SkillInvocation {
  /** Pi's canonical skill name, parsed from its expanded `<skill>` user message. */
  name: string;
  /** Pi's resolved SKILL.md path, carried verbatim from that message. */
  location: string;
  /** The Pi-expanded skill body; rendered only when its native-style chip opens. */
  content: string;
}

export type MessageBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  /** Pi's own `/skill:name` expansion, observed from its user-message event. */
  | { kind: "skill"; skill: SkillInvocation }
  | { kind: "tool"; id: string }
  /** A mid-turn user steer landed HERE in the stream. References the steer's
   * own user RoomEvent by id (the event stays the single source of truth for
   * the text, exactly like `tool` referencing `tools[]`); the UI renders that
   * message inline at this position and suppresses its standalone bubble. */
  | { kind: "steer"; id: string };

/** Runtime metadata for one agent message. v2 stores this ON the transcript
 * event at commit, so history never forgets what produced it. (v1 kept a
 * 50-entry LRU in state.json; those legacy entries are still read.) */
export interface EventDetails {
  model?: string;
  modelFallback?: ModelFallback;
  thinkingStarted?: boolean;
  thinking?: string;
  tools?: ToolDetail[];
  /** The turn's segments in stream order (see `MessageBlock`). Additive and
   * v1-compatible: events committed before this field existed have no `blocks`,
   * and the UI falls back to the bucketed thinking→tools→text layout. `thinking`
   * and `tools` above are still populated in full so non-ordered consumers
   * (prompt replay, read-aloud, summaries) are unaffected. */
  blocks?: MessageBlock[];
  /** This agent event is a summon worker's result landed back in the parent
   * room (see SummonDelivery). The UI renders it as a COLLAPSED, summon-labeled
   * block reusing the thinking/tool expander — not a plain agent message and
   * never a "user →" bubble. Absent on ordinary turns. */
  summonResult?: SummonResultMeta;
  /** Provenance for a `capability-denied` system event (ADV-021): a plugin
   * command's requiredCaps check rejected this room/agent pair BEFORE the
   * plugin's own contribution code ran (services/plugins/contracts.ts
   * `authorize`). Durable so a denial is auditable after the fact, not just a
   * transient toast — mirrors `summonResult` in shape/intent, one denial per
   * event. */
  pluginDenial?: PluginDenial;
}

/** One capability-broker rejection's durable provenance, carried on the
 * synthesized system event's `EventDetails.pluginDenial` (see AgentRoomEvent
 * `kind: "capability-denied"`). `capability` is every requiredCaps entry that
 * was missing, comma-joined (services/capabilities/broker.ts
 * CapabilityDeniedError#missing) — usually one, occasionally several. */
export interface PluginDenial {
  pluginId: string;
  capability: string;
  agentId: string;
  reason: string;
}

/** Provenance carried on a summon worker's result note so the UI can render a
 * collapsed "↩︎ summon <room> finished / ⚠️ FAILED" header without baking it
 * into the message text. */
export interface SummonResultMeta {
  /** The child (worker) room whose turn produced this result — open it to
   * inspect the full run. */
  childRoomId: string;
  /** The worker turn errored (vs. finished cleanly). */
  failed: boolean;
}

/** The in-flight agent reply's accumulated view, mirrored on the snapshot so a
 * client that (re)subscribes mid-turn — e.g. after switching rooms — renders the
 * running turn immediately (text + thinking + tools so far) instead of a blank
 * until it commits. Ephemeral in-memory only: present while a turn streams,
 * cleared on commit/failure/cancel. Durability of the reply text is separate
 * (PendingTurn.partialReply on disk). Keyed by the reserved commit `eventId`, so
 * the moment the room-event with that id lands, the client drops this. */
export interface LiveTurn {
  eventId: string;
  taskId: string;
  agentId: string;
  startedAt: string;
  text: string;
  details: EventDetails;
  /** True while the harness is mid upstream-stall retry — a socket dropped
   * mid-stream and it's reconnecting. Set on an `upstream-stall` notice, cleared
   * the moment any real output resumes (see applyLiveTurn). Rides the snapshot so
   * a client (re)subscribing mid-stall renders the "reconnecting…" bubble state
   * instead of a frozen one; ephemeral in-memory only, like the rest of this. */
  stalled?: boolean;
}

export interface UserRoomEvent {
  id: string;
  timestamp: string;
  author: "user";
  targets: string[];
  text: string;
  channel?: string; // "voice" for spoken turns
  attachments?: MessageAttachment[];
  /** Text was rewritten by a sanitize apply; the original line lives in
   * redactions.jsonl beside the transcript. */
  redacted?: boolean;
  /** Which logged-in human posted this (domain/users.ts). Absent = the default
   * single-implicit-user path (macOS app, mobile, edge-token-only deploys) —
   * author stays the literal "user" either way, this is purely additive
   * display/attribution metadata for multi-human rooms. */
  humanId?: string;
  humanLabel?: string;
}

/** `plugin-reply` = a manifest-registry command's durable reply (ADV-021: was
 * transient-only). `capability-denied` = the same path's broker rejection,
 * carrying `EventDetails.pluginDenial`. */
export type RoomEventKind = "compact-complete" | "turn-failed" | "plugin-reply" | "capability-denied";

export interface AgentRoomEvent {
  id: string;
  timestamp: string;
  author: string; // agent id
  text: string;
  /** Optional persisted rendering discriminator for system/special transcript rows. */
  kind?: RoomEventKind;
  channel?: string;
  details?: EventDetails;
  /** Text was rewritten by a sanitize apply; the original line lives in
   * redactions.jsonl beside the transcript. */
  redacted?: boolean;
  /** Generic display-time cap a command-plugin resolved at commit time (see
   * services/plugins.ts CommandPlugin.renderCap) — `text` above is ALWAYS the
   * agent's FULL, untruncated reply; storage/memory/hooks/agent-context read
   * `text` directly and never lose a byte. This field is the ONLY place
   * enforcement lives; every display surface (live emit, snapshot fetch,
   * read-aloud) derives the shown text from `text` + `renderCap` via
   * domain/render-cap.ts#displayEventText, on demand, never by mutating the
   * stored event. `note`, when present, backs a SEPARATE synthesized
   * SYSTEM-authored chrome event shown alongside this one (see
   * RoomService#withRenderCapNotes) — never merged into `text`: no plugin may
   * ever inject words into what an agent apparently said. */
  renderCap?: { maxLines: number; note?: string };
}

export type RoomEvent = UserRoomEvent | AgentRoomEvent;

