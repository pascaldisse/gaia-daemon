// Schedules: the on-disk shape of .gaia/schedules.json + schedule-expression
// parsing (5-field cron, "every Nm/Nh/Nd" intervals, @aliases) and the
// due-computation. Pure — no I/O, no timers; the tick loop lives in
// services/scheduler.ts.
//
// Semantics (Hermes's local-cron design mapped onto rooms):
// - A job is DUE when a scheduled instant exists in (lastRunAt, now]. Missed
//   instants while the daemon was down collapse into ONE catch-up run.
// - lastRunAt is stamped at dispatch, so a job never double-fires and a fresh
//   job (no state) waits for its next scheduled instant instead of boot-firing.

// --- jobs (schedules.json) ---------------------------------------------------

export interface ScheduleJob {
  id: string;
  /** "every 30m" | 5-field cron ("0 9 * * 1-5") | @hourly/@daily/@weekly/@monthly. */
  schedule: string;
  prompt: string;
  /** Agent to run; unset = the workspace default agent. */
  agent?: string;
  /** Room to run in (or deliver to, when isolated); unset = the current room. */
  room?: string;
  /** true (default): fresh child room per run, result delivered to `room`.
   * false: the run is a normal message turn inside `room` itself. */
  isolated: boolean;
  /** Append the previous run's output to the prompt (default false). */
  chainOutput: boolean;
  enabled: boolean;
}

export interface ScheduleFile {
  /** Workspace kill-switch (default true). */
  enabled: boolean;
  jobs: ScheduleJob[];
}

const JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Tolerant parse of schedules.json: invalid/duplicate/unparseable jobs drop. */
export function parseScheduleFile(raw: unknown): ScheduleFile {
  const obj = isRecord(raw) ? raw : {};
  const enabled = obj.enabled !== false;
  const jobs: ScheduleJob[] = [];
  const seen = new Set<string>();
  for (const entry of Array.isArray(obj.jobs) ? obj.jobs : []) {
    if (!isRecord(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    const schedule = typeof entry.schedule === "string" ? entry.schedule.trim() : "";
    const prompt = typeof entry.prompt === "string" ? entry.prompt.trim() : "";
    if (!JOB_ID_PATTERN.test(id) || seen.has(id) || !prompt || !parseSchedule(schedule)) continue;
    seen.add(id);
    jobs.push({
      id,
      schedule,
      prompt,
      ...(typeof entry.agent === "string" && entry.agent.trim() ? { agent: entry.agent.trim().replace(/^@/, "") } : {}),
      ...(typeof entry.room === "string" && entry.room.trim() ? { room: entry.room.trim() } : {}),
      isolated: entry.isolated !== false,
      chainOutput: entry.chainOutput === true,
      enabled: entry.enabled !== false,
    });
  }
  return { enabled, jobs };
}

// --- run state (schedule-state.json) -----------------------------------------

export interface ScheduleRunRecord {
  /** Stamped at dispatch (BEFORE the run) — the at-most-once mark. */
  lastRunAt: string;
  /** Absent on a freshly-seen job (seeded lastRunAt, nothing ran yet). */
  status?: "running" | "complete" | "error" | "interrupted";
  /** Room the run executed in (child room when isolated). */
  runRoomId?: string;
  /** Room the result was/will be delivered to. */
  deliverRoomId?: string;
  agentId?: string;
  lastEndedAt?: string;
  lastOutput?: string;
  lastError?: string;
}

export type ScheduleState = Record<string, ScheduleRunRecord>;

export function parseScheduleState(raw: unknown): ScheduleState {
  if (!isRecord(raw)) return {};
  const state: ScheduleState = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!isRecord(value) || typeof value.lastRunAt !== "string") continue;
    state[id] = value as unknown as ScheduleRunRecord;
  }
  return state;
}

// --- schedule expressions ------------------------------------------------------

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

export type ParsedSchedule = { kind: "interval"; ms: number } | { kind: "cron"; fields: CronFields };

const CRON_ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
};

const INTERVAL_UNIT_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };

/** Longest catch-up/next-run search: one year of minutes. */
const CRON_HORIZON_MINUTES = 366 * 24 * 60;

function parseCronField(expr: string, min: number, max: number, alias?: (n: number) => number): Set<number> | undefined {
  const out = new Set<number>();
  for (const part of expr.split(",")) {
    const stepMatch = part.match(/^([^/]+)(?:\/(\d+))?$/);
    if (!stepMatch) return undefined;
    const [, rangeExpr, stepRaw] = stepMatch;
    const step = stepRaw ? Number.parseInt(stepRaw, 10) : 1;
    if (!Number.isInteger(step) || step < 1) return undefined;
    let lo: number;
    let hi: number;
    if (rangeExpr === "*") {
      lo = min;
      hi = max;
    } else {
      const rangeMatch = rangeExpr.match(/^(\d+)(?:-(\d+))?$/);
      if (!rangeMatch) return undefined;
      lo = Number.parseInt(rangeMatch[1], 10);
      hi = rangeMatch[2] !== undefined ? Number.parseInt(rangeMatch[2], 10) : lo;
      if (alias) {
        lo = alias(lo);
        hi = alias(hi);
      }
      if (lo < min || hi > max || lo > hi) return undefined;
    }
    for (let n = lo; n <= hi; n += step) out.add(n);
  }
  return out.size > 0 ? out : undefined;
}

/** Parse a schedule expression; undefined when it isn't one we understand. */
export function parseSchedule(expr: string): ParsedSchedule | undefined {
  const trimmed = expr.trim().toLowerCase();

  const interval = trimmed.match(/^every\s+(\d+)\s*(m|min|minute|minutes|h|hr|hour|hours|d|day|days)$/);
  if (interval) {
    const n = Number.parseInt(interval[1], 10);
    if (!Number.isInteger(n) || n < 1) return undefined;
    return { kind: "interval", ms: n * INTERVAL_UNIT_MS[interval[2][0]] };
  }

  const cron = CRON_ALIASES[trimmed] ?? trimmed;
  const parts = cron.split(/\s+/);
  if (parts.length !== 5) return undefined;
  const minute = parseCronField(parts[0], 0, 59);
  const hour = parseCronField(parts[1], 0, 23);
  const dom = parseCronField(parts[2], 1, 31);
  const month = parseCronField(parts[3], 1, 12);
  // 0 and 7 both mean Sunday.
  const dow = parseCronField(parts[4], 0, 7, (n) => (n === 7 ? 0 : n));
  if (!minute || !hour || !dom || !month || !dow) return undefined;
  return {
    kind: "cron",
    fields: { minute, hour, dom, month, dow, domRestricted: parts[2] !== "*", dowRestricted: parts[4] !== "*" },
  };
}

function cronMatches(fields: CronFields, date: Date): boolean {
  if (!fields.minute.has(date.getMinutes()) || !fields.hour.has(date.getHours()) || !fields.month.has(date.getMonth() + 1)) return false;
  const domOk = fields.dom.has(date.getDate());
  const dowOk = fields.dow.has(date.getDay());
  // Vixie-cron day rule: when BOTH day fields are restricted, either may match.
  if (fields.domRestricted && fields.dowRestricted) return domOk || dowOk;
  return domOk && dowOk;
}

function truncateToMinute(date: Date): Date {
  const out = new Date(date.getTime());
  out.setSeconds(0, 0);
  return out;
}

/** First cron instant at or after `from` (local time), within the horizon. */
export function nextCronMatch(fields: CronFields, from: Date): Date | undefined {
  const cursor = truncateToMinute(from);
  if (cursor.getTime() < from.getTime()) cursor.setTime(cursor.getTime() + 60_000);
  for (let i = 0; i < CRON_HORIZON_MINUTES; i++) {
    if (cronMatches(fields, cursor)) return new Date(cursor.getTime());
    cursor.setTime(cursor.getTime() + 60_000);
  }
  return undefined;
}

/** Next instant this schedule fires after lastRunAt (display + due-check). */
export function nextRunAt(parsed: ParsedSchedule, lastRunAt: string): Date | undefined {
  const last = Date.parse(lastRunAt);
  if (!Number.isFinite(last)) return undefined;
  if (parsed.kind === "interval") return new Date(last + parsed.ms);
  // First cron instant strictly after the dispatch's own minute — a run at
  // 09:00:30 must not re-match 09:00, but an every-minute job gets 09:01.
  const start = truncateToMinute(new Date(last));
  start.setTime(start.getTime() + 60_000);
  return nextCronMatch(parsed.fields, start);
}

/** Due = a scheduled instant exists in (lastRunAt, now]. */
export function isDue(parsed: ParsedSchedule, lastRunAt: string, now: Date): boolean {
  const next = nextRunAt(parsed, lastRunAt);
  return Boolean(next && next.getTime() <= now.getTime());
}
