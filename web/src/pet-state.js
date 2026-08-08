/** @typedef {"idle"|"running-right"|"running-left"|"waving"|"jumping"|"failed"|"waiting"|"running"|"review"} PetState */
/** @typedef {{ row: number, timings: readonly number[] }} PetAnimation */
/** @typedef {import("./types.js").PetProgress} PetProgress */
/** @typedef {{ label: string, state: PetState }} PetProgressView */

/** Codex's fixed 8×9 atlas contract, in row order. */
export const PET_ANIMATIONS = /** @type {Readonly<Record<PetState, PetAnimation>>} */ ({
  idle: { row: 0, timings: [280, 110, 110, 140, 140, 320] },
  "running-right": { row: 1, timings: [120, 120, 120, 120, 120, 120, 120, 220] },
  "running-left": { row: 2, timings: [120, 120, 120, 120, 120, 120, 120, 220] },
  waving: { row: 3, timings: [140, 140, 140, 280] },
  jumping: { row: 4, timings: [140, 140, 140, 140, 280] },
  failed: { row: 5, timings: [140, 140, 140, 140, 140, 140, 140, 240] },
  waiting: { row: 6, timings: [150, 150, 150, 150, 150, 260] },
  running: { row: 7, timings: [120, 120, 120, 120, 120, 220] },
  review: { row: 8, timings: [150, 150, 150, 150, 150, 280] },
});

/** Uniform daemon progress → native window bubble + sprite state.
 * @param {Pick<PetProgress, "status"|"toolName">} progress @returns {PetProgressView} */
export function petProgressView(progress) {
  switch (progress.status) {
    case "thinking":
      return { label: "Thinking", state: "waiting" };
    case "tool":
      return { label: progress.toolName?.trim() || "Working", state: "running" };
    case "working":
      return { label: "Working", state: "running" };
    case "failed":
      return { label: "Failed", state: "failed" };
    case "done":
      return { label: "Done", state: "review" };
  }
}
