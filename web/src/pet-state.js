/** @typedef {"idle"|"running-right"|"running-left"|"waving"|"jumping"|"failed"|"waiting"|"running"|"review"} PetState */
/** @typedef {{ row: number, timings: readonly number[] }} PetAnimation */
/** @typedef {{ kind?: "first-awake", isLoading?: boolean, level?: "warning"|"danger"|"success"|"info" }} PetActivity */

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

/** Pure Codex notification/activity → mascot reducer. @param {PetActivity|null|undefined} activity @returns {PetState} */
export function statusToPetState(activity) {
  if (activity?.kind === "first-awake") return "waving";
  if (activity?.isLoading) return "running";
  if (activity?.level === "warning") return "waiting";
  if (activity?.level === "danger") return "failed";
  if (activity?.level === "success") return "review";
  return "idle";
}
