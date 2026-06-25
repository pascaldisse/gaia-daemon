// Subprocess-side egress redirect for the credential proxy. Runs inside the
// agent-runner, where a proxied Pi turn must reach the loopback proxy instead of
// the real provider — WITHOUT changing the model's baseUrl (Pi keys per-provider
// request compatibility off the baseUrl string, e.g. `deepseek.com`, so rewriting
// it would silently change the request shape). So we leave the model untouched and
// rewrite the HTTP egress: Pi calls `new OpenAI({ baseURL: realProviderUrl })`
// with no custom fetch, so it uses globalThis.fetch — we wrap that and re-point
// only the provider origin at the proxy mount. The per-turn token Pi attaches as
// the bearer rides along; the daemon swaps it for the real key.

type FetchFn = typeof globalThis.fetch;

// realBaseUrl (trailing slash trimmed) -> proxy mount (trailing slash trimmed).
const redirects = new Map<string, string>();
let installed = false;

/** Rewrite a request URL if it targets a redirected provider origin, else return
 *  undefined. Pure + exported so the path math is unit-testable without patching
 *  the global. The api-relative suffix is preserved verbatim, so the daemon can
 *  re-join it onto the real provider base URL. */
export function rewriteProviderUrl(url: string, table: Map<string, string> = redirects): string | undefined {
  for (const [from, to] of table) {
    if (url === from || url.startsWith(`${from}/`)) return to + url.slice(from.length);
  }
  return undefined;
}

/** Register a provider origin to redirect, installing the global wrapper once.
 *  Idempotent and additive: multiple providers can be redirected in one process. */
export function redirectProviderFetch(realBaseUrl: string, proxyUrl: string): void {
  redirects.set(realBaseUrl.replace(/\/+$/, ""), proxyUrl.replace(/\/+$/, ""));
  if (installed) return;
  installed = true;
  const original: FetchFn = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : undefined;
    const rewritten = url !== undefined ? rewriteProviderUrl(url) : undefined;
    return rewritten !== undefined ? original(rewritten, init) : original(input, init);
  }) as FetchFn;
}
