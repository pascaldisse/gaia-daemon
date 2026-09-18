// Client-facing payload bound (whip 427, defect B).
//
// Room selection shipped the whole tail window verbatim. Capping the EVENT
// COUNT does nothing: the gaia-love astra room is 11.6 MB in TWO events, one of
// which carries 87 tool calls worth 11.5 MB of `details.tools`. The size class
// of a room snapshot is therefore set by tool PAYLOAD BYTES, not by how many
// messages are in the window, and that is what this module bounds.
//
// Applied only on the way OUT to a client (see RoomSnapshotMixin#displayEvents,
// the single funnel for getSnapshot + eventsBefore) — exactly like the render
// cap it sits beside. Storage, prompt replay, memory, recall and read-aloud keep
// reading RoomHandle#eventsFrom directly and still see every stored byte.
//
// Deliberately NOT applied to the live commit emit (room/turn-results.ts, which
// calls withRenderCapNotes directly): that client watched the payload stream in
// and already holds it, so capping there would DELETE output in front of the
// person who just watched it arrive. The bound belongs on re-reads of history.
//
// A capped value is never silently shortened: the tool carries `truncated` with
// its real byte size, so the UI can say so and fetch the full event on demand
// (GET .../rooms/:room/events/:eventId).

import type { EventDetails, RoomEvent, ToolDetail, ToolTruncation } from "../core/types.js";

export interface TransportCapLimits {
  /** Max serialized bytes of ONE tool payload (args/partialResult/result). */
  toolBytes: number;
  /** Max serialized bytes of one event's tool PAYLOADS. Tools are kept
   * newest-first — the tail of a turn is what a human is looking at — and
   * everything past the budget degrades to a header-only stub.
   *
   * A tool call is NEVER dropped, so the real ceiling is this budget plus one
   * stub (~100 bytes) per tool: 87 tools floor at ~9 KB whatever the payloads
   * were. That is the point — the turn's shape stays fully readable while its
   * bytes stop scaling with what the tools returned. */
  eventBytes: number;
}

function serializedSize(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value === "string") return value.length;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    // Cyclic/unserializable payloads can never reach a client anyway; treat them
    // as over-budget rather than throwing inside a snapshot read.
    return Number.MAX_SAFE_INTEGER;
  }
}

/** Head of a payload, as text. Objects preview as their JSON prefix — the UI
 * already renders unknown results through its generic text renderer. */
function preview(value: unknown, limit: number): string {
  const text = typeof value === "string" ? value : (() => { try { return JSON.stringify(value) ?? ""; } catch { return ""; } })();
  return text.slice(0, Math.max(0, limit));
}

/** Cap one tool's payload fields; returns the tool unchanged when it fits. */
function capTool(tool: ToolDetail, toolBytes: number): ToolDetail {
  const fields: ToolTruncation["fields"] = [];
  let bytes = 0;
  const next: ToolDetail = { ...tool };
  for (const field of ["args", "partialResult", "result"] as const) {
    const value = tool[field];
    if (value === undefined || value === null) continue;
    const size = serializedSize(value);
    if (size <= toolBytes) continue;
    next[field] = preview(value, toolBytes);
    fields.push(field);
    bytes += size;
  }
  if (fields.length === 0) return tool;
  next.truncated = { bytes, fields };
  return next;
}

/** Header-only form of a tool whose payload fell outside the event budget. */
function stubTool(tool: ToolDetail): ToolDetail {
  const fields: ToolTruncation["fields"] = [];
  let bytes = 0;
  for (const field of ["args", "partialResult", "result"] as const) {
    const value = tool[field];
    if (value === undefined || value === null) continue;
    fields.push(field);
    bytes += serializedSize(value);
  }
  const stub: ToolDetail = { id: tool.id, toolName: tool.toolName, status: tool.status };
  if (fields.length > 0) stub.truncated = { bytes, fields };
  return stub;
}

function capTools(tools: ToolDetail[], limits: TransportCapLimits): ToolDetail[] | undefined {
  let budget = limits.eventBytes;
  let changed = false;
  const capped: ToolDetail[] = new Array(tools.length);
  // Newest-first: a truncated turn must keep the tool a human is currently
  // looking at, which is the one that ran last.
  for (let i = tools.length - 1; i >= 0; i--) {
    const tool = tools[i]!;
    const next = budget > 0 ? capTool(tool, limits.toolBytes) : stubTool(tool);
    const size = serializedSize(next);
    if (size > budget) {
      const stub = stubTool(tool);
      capped[i] = stub;
      budget -= serializedSize(stub);
      if (stub !== tool) changed = true;
      continue;
    }
    budget -= size;
    capped[i] = next;
    if (next !== tool) changed = true;
  }
  return changed ? capped : undefined;
}

/** Bound one client-facing event. Returns the same object when nothing was
 * over budget, so an unchanged transcript costs no allocation. */
export function capEventForTransport(event: RoomEvent, limits: TransportCapLimits): RoomEvent {
  if (!("details" in event) || !event.details) return event;
  const details = event.details as EventDetails;
  if (!details.tools?.length) return event;
  const tools = capTools(details.tools, limits);
  if (!tools) return event;
  return { ...event, details: { ...details, tools } } as RoomEvent;
}

/** Bound a whole client-facing window. */
export function capEventsForTransport(events: RoomEvent[], limits: TransportCapLimits): RoomEvent[] {
  return events.map((event) => capEventForTransport(event, limits));
}
