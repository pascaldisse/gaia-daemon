import test from "node:test";
import assert from "node:assert/strict";
import { isDue, nextRunAt, parseSchedule, parseScheduleFile, parseScheduleState } from "../src/domain/schedules.js";

// Local-time helper: cron matching is local, so tests build local Dates.
function at(year: number, month: number, day: number, hour: number, minute: number, second = 0): Date {
  return new Date(year, month - 1, day, hour, minute, second);
}

test("parseSchedule: intervals, aliases, cron, and rejects", () => {
  assert.deepEqual(parseSchedule("every 30m"), { kind: "interval", ms: 30 * 60_000 });
  assert.deepEqual(parseSchedule("every 2 hours"), { kind: "interval", ms: 2 * 3_600_000 });
  assert.deepEqual(parseSchedule("Every 1d"), { kind: "interval", ms: 86_400_000 });

  assert.equal(parseSchedule("@daily")?.kind, "cron");
  assert.equal(parseSchedule("0 9 * * 1-5")?.kind, "cron");
  assert.equal(parseSchedule("*/15 * * * *")?.kind, "cron");

  assert.equal(parseSchedule(""), undefined);
  assert.equal(parseSchedule("every 0m"), undefined);
  assert.equal(parseSchedule("whenever"), undefined);
  assert.equal(parseSchedule("61 * * * *"), undefined); // minute out of range
  assert.equal(parseSchedule("* * * *"), undefined); // four fields
});

test("cron nextRunAt: fields, ranges, steps, and the 0/7 Sunday alias", () => {
  const daily9 = parseSchedule("0 9 * * *")!;
  // Last dispatch 08:00 → next is 09:00 the same day.
  assert.deepEqual(nextRunAt(daily9, at(2026, 7, 1, 8, 0).toISOString()), at(2026, 7, 1, 9, 0));
  // Last dispatch 09:00:20 (the run itself) → next is TOMORROW 09:00.
  assert.deepEqual(nextRunAt(daily9, at(2026, 7, 1, 9, 0, 20).toISOString()), at(2026, 7, 2, 9, 0));

  const weekdays = parseSchedule("30 18 * * 1-5")!;
  // Friday 2026-07-03 19:00 → next is Monday 2026-07-06 18:30.
  assert.deepEqual(nextRunAt(weekdays, at(2026, 7, 3, 19, 0).toISOString()), at(2026, 7, 6, 18, 30));

  const sundayAs7 = parseSchedule("0 12 * * 7")!;
  // 2026-07-05 is a Sunday.
  assert.deepEqual(nextRunAt(sundayAs7, at(2026, 7, 1, 0, 0).toISOString()), at(2026, 7, 5, 12, 0));

  const everyQuarterHour = parseSchedule("*/15 * * * *")!;
  assert.deepEqual(nextRunAt(everyQuarterHour, at(2026, 7, 1, 10, 16).toISOString()), at(2026, 7, 1, 10, 30));
});

test("cron day rule: dom+dow both restricted → either matches (vixie)", () => {
  // 13th OR Friday. From Wed 2026-07-08: Friday 2026-07-10 comes first.
  const spooky = parseSchedule("0 0 13 * 5")!;
  assert.deepEqual(nextRunAt(spooky, at(2026, 7, 8, 1, 0).toISOString()), at(2026, 7, 10, 0, 0));
  // From Sat 2026-07-11: the 13th (a Monday) beats next Friday the 17th.
  assert.deepEqual(nextRunAt(spooky, at(2026, 7, 11, 1, 0).toISOString()), at(2026, 7, 13, 0, 0));
});

test("isDue: catch-up collapses missed instants into one run", () => {
  const daily9 = parseSchedule("0 9 * * *")!;
  const lastWeek = at(2026, 6, 24, 9, 0, 30).toISOString();
  // A week of missed 09:00s → due exactly once; the dispatch stamps lastRunAt.
  assert.equal(isDue(daily9, lastWeek, at(2026, 7, 1, 8, 0)), true);
  assert.equal(isDue(daily9, at(2026, 7, 1, 8, 0, 5).toISOString(), at(2026, 7, 1, 8, 30)), false);

  const every30 = parseSchedule("every 30m")!;
  assert.equal(isDue(every30, at(2026, 7, 1, 8, 0).toISOString(), at(2026, 7, 1, 8, 29)), false);
  assert.equal(isDue(every30, at(2026, 7, 1, 8, 0).toISOString(), at(2026, 7, 1, 8, 30)), true);
});

test("parseScheduleFile: tolerant — invalid, duplicate, unparseable jobs drop", () => {
  const file = parseScheduleFile({
    jobs: [
      { id: "ok", schedule: "@daily", prompt: "do the thing", agent: "@gaia", room: "default" },
      { id: "ok", schedule: "@daily", prompt: "duplicate id" },
      { id: "bad schedule", schedule: "sometimes", prompt: "x" },
      { id: "no-prompt", schedule: "@daily" },
      { id: "../evil", schedule: "@daily", prompt: "x" },
      "not-an-object",
      { id: "second", schedule: "every 15m", prompt: "poll it", isolated: false, chainOutput: true, enabled: false },
    ],
  });
  assert.equal(file.enabled, true);
  assert.deepEqual(
    file.jobs.map((job) => job.id),
    ["ok", "second"],
  );
  // Defaults: isolated on, chaining off, enabled on; @ stripped from agent.
  assert.deepEqual(file.jobs[0], {
    id: "ok",
    schedule: "@daily",
    prompt: "do the thing",
    agent: "gaia",
    room: "default",
    isolated: true,
    chainOutput: false,
    enabled: true,
  });
  assert.equal(file.jobs[1].isolated, false);
  assert.equal(file.jobs[1].chainOutput, true);
  assert.equal(file.jobs[1].enabled, false);

  assert.equal(parseScheduleFile({ enabled: false, jobs: [] }).enabled, false);
  assert.deepEqual(parseScheduleFile(undefined), { enabled: true, jobs: [] });
});

test("parseScheduleState: entries without lastRunAt drop", () => {
  const state = parseScheduleState({
    good: { lastRunAt: "2026-07-01T09:00:00Z", status: "complete" },
    bad: { status: "running" },
    weird: "nope",
  });
  assert.deepEqual(Object.keys(state), ["good"]);
});
