// Native Codex-pet shell bridge. There is intentionally no browser overlay and
// no localStorage preference: RoomState bindings are the only source of truth,
// pets are off when that map is empty, and iOS/browser clients do nothing.

import { invoke, isNative } from "./native.js";

/** @typedef {import("./types.js").PetBinding} PetBinding */
/** @typedef {import("./types.js").PetProgress} PetProgress */

/** Apply a complete snapshot for one workspace. Rust reconciles only that
 * workspace, so snapshots from several open GAIA windows cannot remove each
 * other's pets. @param {string} workspaceId @param {PetBinding[]} bindings */
export async function syncNativePets(workspaceId, bindings) {
  if (!isNative()) return;
  await invoke("sync_pets", { workspaceId, bindings });
}

/** Forward one globally-delivered, room+agent-scoped progress event to the
 * matching native pet window. @param {PetProgress} progress */
export async function forwardNativePetProgress(progress) {
  if (!isNative()) return;
  await invoke("pet_progress", { progress });
}
