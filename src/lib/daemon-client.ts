// One POST helper for the two clients that talk to the running daemon's
// /api/harness/* endpoints with a bearer token: the in-process tool bridge
// (runtime/bridge-deps.ts) and the `gaia` CLI harness (cli-harness.ts). It
// returns the rich result; each caller derives what it needs (the CLI wants a
// flat {ok, text}). Parse failures fall back to {} so a non-JSON body never
// throws — callers treat a missing/empty payload as an unconfirmed write.

export interface DaemonTarget {
  url: string;
  token: string;
}

export interface DaemonResponse {
  ok: boolean;
  status: number;
  payload: Record<string, unknown>;
}

/** POST `body` as JSON to `${target.url}${path}` with Bearer auth; parse the JSON reply. */
export async function daemonPost(target: DaemonTarget, path: string, body: unknown): Promise<DaemonResponse> {
  const response = await fetch(`${target.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${target.token}` },
    body: JSON.stringify(body),
  });
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { ok: response.ok, status: response.status, payload };
}
