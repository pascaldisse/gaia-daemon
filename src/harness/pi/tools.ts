// Pi-only provider transport adaptation; shared layers receive only spec data.
type FetchFn = typeof globalThis.fetch;
const redirects = new Map<string, string>();
let fetchWrapped = false;
export function rewriteProviderUrl(url: string, table: Map<string, string> = redirects): string | undefined {
  for (const [from, to] of table) if (url === from || url.startsWith(`${from}/`)) return to + url.slice(from.length);
  return undefined;
}
export function redirectProviderFetch(realBaseUrl: string, proxyUrl: string): void {
  redirects.set(realBaseUrl.replace(/\/+$/, ""), proxyUrl.replace(/\/+$/, ""));
  if (fetchWrapped) return;
  fetchWrapped = true;
  const original: FetchFn = globalThis.fetch.bind(globalThis);
  globalThis.fetch = ((input: Parameters<FetchFn>[0], init?: Parameters<FetchFn>[1]) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : undefined;
    const rewritten = url !== undefined ? rewriteProviderUrl(url) : undefined;
    return rewritten !== undefined ? original(rewritten, init) : original(input, init);
  }) as FetchFn;
}
