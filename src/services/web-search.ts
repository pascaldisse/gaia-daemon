import { existsSync, readFileSync } from "node:fs";
import { globalPaths } from "../core/paths.js";

export const WEB_SEARCH_PROVIDERS = ["brave", "tavily", "serper"] as const;
export type WebSearchProvider = (typeof WEB_SEARCH_PROVIDERS)[number];

export interface WebSearchRequest {
  query: string;
  maxResults?: number;
  provider?: WebSearchProvider;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchResponse {
  provider: WebSearchProvider;
  results: WebSearchResult[];
}

export interface WebSearchOptions {
  fetch?: typeof globalThis.fetch;
  env?: Record<string, string | undefined>;
  secretsPath?: string;
  log?: (message: string) => void;
}

interface ProviderFailure {
  provider: WebSearchProvider;
  reason: string;
}

function parseSecrets(raw: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const [, name, rawValue] = match;
    const quoted = rawValue.match(/^(["'])(.*)\1$/)?.[2];
    values[name] = quoted ?? rawValue.replace(/\s+#.*$/, "");
  }
  return values;
}

/** Process env wins; ~/.gaia/secrets.env fills keys for CLI/app launches whose
 * parent did not source it. The file is read, never copied into process.env. */
export function webSearchCredentials(options: Pick<WebSearchOptions, "env" | "secretsPath"> = {}): Record<string, string | undefined> {
  const secretsPath = options.secretsPath ?? globalPaths.secrets();
  let secrets: Record<string, string> = {};
  try {
    if (existsSync(secretsPath)) secrets = parseSecrets(readFileSync(secretsPath, "utf8"));
  } catch {
    // An unreadable optional secret file behaves like an absent one; providers
    // with environment credentials remain usable.
  }
  const environment = options.env ?? process.env;
  const key = (name: string): string | undefined => environment[name]?.trim() || secrets[name]?.trim() || undefined;
  return {
    brave: key("BRAVE_API_KEY") ?? key("BRAVE_SEARCH_API_KEY"),
    tavily: key("TAVILY_API_KEY"),
    serper: key("SERPER_API_KEY"),
  };
}

function result(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normalizeBrave(data: unknown, maxResults: number): WebSearchResult[] {
  const web = result(result(data).web);
  const rows = Array.isArray(web.results) ? web.results : [];
  return rows.slice(0, maxResults).map((row) => {
    const item = result(row);
    return { title: text(item.title), url: text(item.url), snippet: text(item.description) };
  });
}

function normalizeTavily(data: unknown, maxResults: number): WebSearchResult[] {
  const rows = Array.isArray(result(data).results) ? result(data).results as unknown[] : [];
  return rows.slice(0, maxResults).map((row) => {
    const item = result(row);
    return { title: text(item.title), url: text(item.url), snippet: text(item.content) || text(item.snippet) };
  });
}

function normalizeSerper(data: unknown, maxResults: number): WebSearchResult[] {
  const rows = Array.isArray(result(data).organic) ? result(data).organic as unknown[] : [];
  return rows.slice(0, maxResults).map((row) => {
    const item = result(row);
    return { title: text(item.title), url: text(item.link), snippet: text(item.snippet) };
  });
}

async function responseJson(response: Response, provider: WebSearchProvider): Promise<unknown> {
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${provider}`);
  try {
    return await response.json();
  } catch {
    throw new Error(`Invalid JSON from ${provider}`);
  }
}

async function searchProvider(provider: WebSearchProvider, key: string, request: Required<Pick<WebSearchRequest, "query" | "maxResults">>, fetcher: typeof globalThis.fetch): Promise<WebSearchResult[]> {
  if (provider === "brave") {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", request.query);
    url.searchParams.set("count", String(Math.min(request.maxResults, 20)));
    const data = await responseJson(await fetcher(url, { headers: { Accept: "application/json", "X-Subscription-Token": key } }), provider);
    return normalizeBrave(data, request.maxResults);
  }
  if (provider === "tavily") {
    const data = await responseJson(await fetcher("https://api.tavily.com/search", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query: request.query, max_results: request.maxResults }),
    }), provider);
    return normalizeTavily(data, request.maxResults);
  }
  const data = await responseJson(await fetcher("https://google.serper.dev/search", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "X-API-KEY": key },
    body: JSON.stringify({ q: request.query }),
  }), provider);
  return normalizeSerper(data, request.maxResults);
}

/** Search in the fixed provider order Brave → Tavily → Serper. An explicit
 * provider opts out of fallback, useful for diagnosis and provider comparison. */
export async function searchWeb(request: WebSearchRequest, options: WebSearchOptions = {}): Promise<WebSearchResponse> {
  const query = request.query.trim();
  if (!query) throw new Error("web search requires a query");
  const requestedMax = request.maxResults ?? 5;
  const maxResults = Number.isFinite(requestedMax) ? Math.max(1, Math.min(Math.floor(requestedMax), 20)) : 5;
  const fetcher = options.fetch ?? globalThis.fetch;
  const credentials = webSearchCredentials(options);
  const providers = request.provider ? [request.provider] : WEB_SEARCH_PROVIDERS;
  const failures: ProviderFailure[] = [];

  for (const provider of providers) {
    const key = credentials[provider];
    if (!key) {
      failures.push({ provider, reason: "no API key" });
      continue;
    }
    try {
      const results = await searchProvider(provider, key, { query, maxResults }, fetcher);
      (options.log ?? console.info)(`[gaia:web] served by ${provider}`);
      return { provider, results };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      failures.push({ provider, reason });
      (options.log ?? console.warn)(`[gaia:web] ${provider} unavailable: ${reason}; trying next provider`);
    }
  }
  throw new Error(`web search unavailable: ${failures.map(({ provider, reason }) => `${provider} (${reason})`).join(", ")}`);
}
