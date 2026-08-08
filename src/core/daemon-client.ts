// Shared HTTP helpers for clients that talk to the running daemon's
// /api/harness/* endpoints with a bearer token: the in-process tool bridge
// (services/bridge.ts) and the `gaia` CLI harness (services/cli-tools.ts).
// Parse failures fall back to {} so a non-JSON body never throws — callers
// treat a missing/empty payload as an unconfirmed request.

export interface DaemonTarget {
  url: string;
  token: string;
}

export interface DaemonResponse {
  ok: boolean;
  status: number;
  payload: Record<string, unknown>;
}

async function daemonRequest(target: DaemonTarget, path: string, init: RequestInit): Promise<DaemonResponse> {
  const response = await fetch(`${target.url}${path}`, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${target.token}` },
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, payload };
}

/** GET `${target.url}${path}` with Bearer auth; parse the JSON reply. */
export function daemonGet(target: DaemonTarget, path: string): Promise<DaemonResponse> {
  return daemonRequest(target, path, { method: "GET" });
}

/** POST `body` as JSON to `${target.url}${path}` with Bearer auth; parse the JSON reply. */
export function daemonPost(target: DaemonTarget, path: string, body: unknown): Promise<DaemonResponse> {
  return daemonRequest(target, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
