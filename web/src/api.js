// Fetch wrapper: JSON in/out, server error text surfaced as an Error.

// Reverse-proxy mount prefix (Caddy `handle_path /gaia/*` etc). Baked into
// index.html/pet.html by the server (src/server/http.ts serveStatic) only
// when GAIA_BASE_PATH is set; "" (root-mounted) everywhere else, matching
// today's behavior exactly. Every absolute ("/...") request path in the web
// client must route through this — see apiUrl() below.
export const BASE_PATH = /** @type {{ __GAIA_BASE_PATH__?: string }} */ (/** @type {unknown} */ (window)).__GAIA_BASE_PATH__ ?? "";

/** Prefix an absolute app path ("/api/...") with the mount prefix. Use this
 * anywhere a URL is built for fetch/EventSource/WebSocket/sendBeacon/element
 * src outside of api() itself. @param {string} path @returns {string} */
export function apiUrl(path) {
  return `${BASE_PATH}${path}`;
}

/**
 * @param {string} path
 * @param {RequestInit} [options]
 * @returns {Promise<any>}
 */
export async function api(path, options = {}) {
  const response = await fetch(apiUrl(path), {
    ...options,
    headers: { "content-type": "application/json", ...(options.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `Request failed: ${response.status}`);
  return body;
}
