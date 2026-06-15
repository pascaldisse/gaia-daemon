import { state } from "./state.ts";

export async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Request failed: ${response.status}`);
  return body;
}

function roomApiPath(suffix = "") {
  const snapshot = state.snapshot;
  if (!snapshot) throw new Error("No workspace loaded");
  return `/api/workspaces/${encodeURIComponent(snapshot.workspace.id)}/rooms/${encodeURIComponent(snapshot.room.id)}${suffix}`;
}

export async function fetchSummon(summonId) {
  return api(roomApiPath(`/summons/${encodeURIComponent(summonId)}`));
}

export async function cancelSummon(summonId) {
  return api(roomApiPath(`/summons/${encodeURIComponent(summonId)}/cancel`), {
    method: "POST",
    body: JSON.stringify({}),
  });
}
