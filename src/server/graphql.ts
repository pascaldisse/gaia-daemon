// The GraphQL test surface: typed Query/Mutation wrappers over a slice of the
// gaia verb dispatcher (src/harness/tools-pi.ts createGaiaTool / src/cli.ts),
// exposed as plain HTTP so Pascal can drive requests from a browser via the
// bundled GraphiQL IDE. Off by default (gaiaGraphqlEnabled), a SEPARATE
// localhost-only port from the main daemon API (gaiaGraphqlPort) — this never
// shares a listener with server/http.ts, and `bash` is permanently excluded
// from the generic `verb` escape hatch: no arbitrary process execution over
// this surface, ever (security, not an oversight).
//
// Every resolver below calls the SAME service functions the CLI (src/cli.ts,
// src/services/cli-tools.ts) and the in-agent `gaia` tool
// (src/harness/tools-pi.ts) already call — searchWeb/fetchWeb, MemoryStore,
// bareWorkspaceRecall, compressCaryll/expandCaryll — never a re-implementation.
// web-search.ts/web-fetch.ts stay untouched (owned by the parallel web-refactor
// lane): only their exported functions are imported, exactly like cli.ts does.

import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createSchema, createYoga } from "graphql-yoga";
import { gaiaGraphqlPort } from "../core/config.js";
import { workspacePaths } from "../core/paths.js";
import { loadAgentDefinitions } from "../domain/agents.js";
import { CORE_MEMORY_FILE, MemoryStore } from "../domain/memory.js";
import { bareWorkspaceRecall, type MemorySearchHit } from "../domain/workspace-index.js";
import { globalAgentsPath } from "../domain/workspace.js";
import { compressCaryll, expandCaryll } from "../services/caryll.js";
import { fetchWeb, type WebFetchRequest, type WebFetchVideo } from "../services/web-fetch.js";
import { searchWeb, type WebSearchProvider } from "../services/web-search.js";

export interface GraphqlServerOptions {
  /** Workspace cwd (mirrors WebServerOptions.cwd) — resolves mem/recall agent
   * dirs and the recall workspace index; websearch/webfetch/verb(caryll) work
   * with no workspace at all. */
  cwd: string;
  /** Localhost-bind only — this is IRON, never read from GAIA_HOST. */
  host?: "127.0.0.1";
  port?: number;
}

function hasWorkspace(cwd: string): boolean {
  return existsSync(workspacePaths.dir(cwd));
}

/** Loads every global agent (+ this workspace's project overlay, when one
 * exists) and returns the one matching `agentId`, or throws a listing error —
 * same resolution loadAgentDefinitions gives the daemon/CLI, no shortcuts. */
async function resolveAgent(cwd: string, agentId: string) {
  const agents = await loadAgentDefinitions(globalAgentsPath(), workspacePaths.agentsOverrideDir(cwd));
  const agent = agents[agentId];
  if (!agent) throw new Error(`unknown agent: ${agentId} (available: ${Object.keys(agents).join(", ") || "none"})`);
  return agent;
}

const WEB_SEARCH_PROVIDERS = ["brave", "tavily", "serper"] as const;

function assertProvider(provider: string | null | undefined): WebSearchProvider | undefined {
  if (provider === null || provider === undefined) return undefined;
  if (!(WEB_SEARCH_PROVIDERS as readonly string[]).includes(provider)) {
    throw new Error(`provider must be one of: ${WEB_SEARCH_PROVIDERS.join(", ")}`);
  }
  return provider as WebSearchProvider;
}

interface MemFileInfoShape {
  file: string;
  chars: number;
  limit: number;
}

interface MemResultShape {
  content: string | null;
  files: MemFileInfoShape[] | null;
}

interface RecallHitShape {
  kind: string;
  id: string | null;
  text: string;
  snippet: string | null;
  ts: string;
  score: number;
  roomId: string | null;
}

function toRecallHit(hit: MemorySearchHit): RecallHitShape {
  return {
    kind: hit.kind,
    id: hit.id ?? null,
    text: hit.text,
    snippet: hit.snippet ?? null,
    ts: hit.ts,
    score: hit.score,
    roomId: hit.roomId ?? null,
  };
}

/** Verbs the generic `verb(verb, argsJson)` escape hatch will actually run.
 * `bash` is excluded on principle (see module doc); every other GaiaVerb
 * (read/write/edit/summon/resume/artifact) needs a live agent turn/room this
 * standalone HTTP surface does not have — they fail with a clear, typed error
 * rather than a silent no-op. Growing this list means wiring a real headless
 * context for that verb, never quietly widening the bash exclusion instead. */
const ALLOWED_GENERIC_VERBS = new Set(["web", "caryll", "mem", "recall"]);

async function dispatchGenericVerb(cwd: string, verb: string, args: Record<string, unknown>): Promise<unknown> {
  if (verb === "bash") throw new Error("gaia bash is excluded from the GraphQL surface (security)");
  if (!ALLOWED_GENERIC_VERBS.has(verb)) {
    throw new Error(`verb '${verb}' is not available over the GraphQL surface (needs a live room/agent turn)`);
  }
  if (verb === "web") {
    const query = typeof args.query === "string" ? args.query : "";
    if (query) {
      const provider = assertProvider(typeof args.provider === "string" ? args.provider : undefined);
      const maxResults = typeof args.maxResults === "number" ? args.maxResults : undefined;
      return searchWeb({ query, ...(maxResults === undefined ? {} : { maxResults }), ...(provider === undefined ? {} : { provider }) });
    }
    const url = typeof args.url === "string" ? args.url : "";
    if (!url) throw new Error("gaia web args require either { query } (search) or { url } (fetch).");
    const maxBytes = typeof args.maxBytes === "number" ? args.maxBytes : undefined;
    const transcript = typeof args.transcript === "boolean" ? args.transcript : undefined;
    const lang = typeof args.lang === "string" ? args.lang : undefined;
    const comments = typeof args.comments === "boolean" || typeof args.comments === "number" ? args.comments : undefined;
    return fetchWeb({
      url,
      ...(maxBytes === undefined ? {} : { maxBytes }),
      ...(transcript === undefined ? {} : { transcript }),
      ...(lang === undefined ? {} : { lang }),
      ...(comments === undefined ? {} : { comments }),
    });
  }
  if (verb === "caryll") {
    const action = args.action;
    const path = typeof args.path === "string" ? args.path : "";
    if ((action !== "compress" && action !== "expand" && action !== "stats") || !path) {
      throw new Error("gaia caryll args require { action: compress|expand|stats, path }.");
    }
    const { readFile } = await import("node:fs/promises");
    const source = await readFile(path, "utf8");
    if (action === "stats") return compressCaryll(source).stats;
    if (action === "compress") return compressCaryll(source).stats;
    return { bytes: Buffer.byteLength(expandCaryll(source)) };
  }
  if (verb === "mem") {
    const agentId = typeof args.agentId === "string" ? args.agentId : "";
    if (!agentId) throw new Error("gaia mem args require { agentId }.");
    const agent = await resolveAgent(cwd, agentId);
    const store = new MemoryStore();
    if (args.list === true) return store.listFiles(agent.memoryDir);
    const file = typeof args.file === "string" && args.file.trim() ? args.file.trim() : CORE_MEMORY_FILE;
    return store.readState(agent.memoryDir, file);
  }
  // recall
  const agentId = typeof args.agentId === "string" ? args.agentId : "";
  const query = typeof args.query === "string" ? args.query : "";
  if (!agentId || !query) throw new Error("gaia recall args require { agentId, query }.");
  if (!hasWorkspace(cwd)) throw new Error(`no GAIA workspace at ${cwd} (no .gaia/ dir) — recall needs a real workspace index`);
  const agent = await resolveAgent(cwd, agentId);
  const limit = typeof args.limit === "number" ? args.limit : undefined;
  return bareWorkspaceRecall(cwd, query, { agentId, memoryDir: agent.memoryDir, ...(limit === undefined ? {} : { limit }) });
}

const typeDefs = /* GraphQL */ `
  type WebSearchResultItem {
    title: String!
    url: String!
    snippet: String!
  }

  type WebSearchResult {
    provider: String!
    results: [WebSearchResultItem!]!
  }

  type WebFetchVideoComment {
    author: String!
    text: String!
    likes: Int
  }

  type WebFetchVideo {
    provider: String!
    videoId: String!
    lang: String!
    channel: String
    description: String
    transcript: String!
    entries: Int!
    truncated: Boolean!
    comments: [WebFetchVideoComment!]
    commentsUnavailable: String
  }

  type WebFetchResult {
    url: String!
    title: String!
    text: String!
    bytes: Int!
    truncated: Boolean!
    """Present when the url matched a registered video provider (currently YouTube)."""
    video: WebFetchVideo
  }

  type MemFileInfo {
    file: String!
    chars: Int!
    limit: Int!
  }

  type MemResult {
    content: String
    files: [MemFileInfo!]
  }

  type RecallHit {
    kind: String!
    id: String
    text: String!
    snippet: String
    ts: String!
    score: Float!
    roomId: String
  }

  type Query {
    """Web search; falls back Brave -> Tavily -> Serper (services/web-search.ts, unmodified)."""
    webSearch(query: String!, provider: String, maxResults: Int): WebSearchResult!
    """Fetch a URL's extracted readable text (services/web-fetch.ts, unmodified).
    Video urls (currently YouTube) additionally get a transcript by default and,
    opt-in, top-level comments -- see the 'video' field."""
    webFetch(url: String!, maxBytes: Int, transcript: Boolean, comments: Boolean): WebFetchResult!
    """Read a global agent's memory: one file (default MEMORY.md), or the file listing with 'list: true'."""
    mem(agentId: String!, file: String, list: Boolean): MemResult!
    """Bare workspace recall (lexical, no daemon-side reranker) against one agent's memory + this workspace's room history."""
    recall(agentId: String!, query: String!, limit: Int): [RecallHit!]!
  }

  type Mutation {
    """Generic escape hatch: dispatch { verb, argsJson } through the same verb
    table the gaia CLI/tool use, returning JSON.stringify(result). 'bash' is
    permanently excluded; verbs needing a live room/agent turn (read/write/edit/
    summon/resume/artifact) return a typed error, not a silent no-op."""
    verb(verb: String!, argsJson: String!): String!
  }
`;

function buildSchema(cwd: string) {
  return createSchema({
    typeDefs,
    resolvers: {
      Query: {
        webSearch: async (_root: unknown, args: { query: string; provider?: string | null; maxResults?: number | null }) => {
          const provider = assertProvider(args.provider);
          const maxResults = args.maxResults ?? undefined;
          const response = await searchWeb({ query: args.query, ...(maxResults === undefined ? {} : { maxResults }), ...(provider === undefined ? {} : { provider }) });
          return { provider: response.provider, results: response.results };
        },
        webFetch: async (_root: unknown, args: { url: string; maxBytes?: number | null; transcript?: boolean | null; comments?: boolean | null }): Promise<{ url: string; title: string; text: string; bytes: number; truncated: boolean; video: WebFetchVideo | null }> => {
          const maxBytes = args.maxBytes ?? undefined;
          const transcript = args.transcript ?? undefined;
          const comments = args.comments ?? undefined;
          const request: WebFetchRequest = {
            url: args.url,
            ...(maxBytes === undefined ? {} : { maxBytes }),
            ...(transcript === undefined ? {} : { transcript }),
            ...(comments === undefined ? {} : { comments }),
          };
          const response = await fetchWeb(request);
          return { ...response, video: response.video ?? null };
        },
        mem: async (_root: unknown, args: { agentId: string; file?: string | null; list?: boolean | null }): Promise<MemResultShape> => {
          const agent = await resolveAgent(cwd, args.agentId);
          const store = new MemoryStore();
          if (args.list) return { content: null, files: await store.listFiles(agent.memoryDir) };
          const file = args.file?.trim() || CORE_MEMORY_FILE;
          const state = await store.readState(agent.memoryDir, file);
          return { content: state.content, files: null };
        },
        recall: async (_root: unknown, args: { agentId: string; query: string; limit?: number | null }): Promise<RecallHitShape[]> => {
          if (!hasWorkspace(cwd)) throw new Error(`no GAIA workspace at ${cwd} (no .gaia/ dir) — recall needs a real workspace index`);
          const agent = await resolveAgent(cwd, args.agentId);
          const limit = args.limit ?? undefined;
          const hits = await bareWorkspaceRecall(cwd, args.query, { agentId: args.agentId, memoryDir: agent.memoryDir, ...(limit === undefined ? {} : { limit }) });
          return hits.map(toRecallHit);
        },
      },
      Mutation: {
        verb: async (_root: unknown, args: { verb: string; argsJson: string }): Promise<string> => {
          let parsedArgs: Record<string, unknown>;
          try {
            parsedArgs = JSON.parse(args.argsJson);
          } catch (error) {
            throw new Error(`argsJson must be valid JSON: ${error instanceof Error ? error.message : String(error)}`);
          }
          const result = await dispatchGenericVerb(cwd, args.verb, parsedArgs);
          return JSON.stringify(result);
        },
      },
    },
  });
}

export interface GraphqlServer {
  url: string;
  close(): Promise<void>;
}

/** Boots the standalone GraphQL surface (its own node:http listener, own
 * port) — never mounted on server/http.ts's server, never bound off
 * localhost. `options.port` defaults to gaiaGraphqlPort() (0 picks a free
 * port, used by tests). */
export async function startGraphqlServer(options: GraphqlServerOptions): Promise<GraphqlServer> {
  const host = "127.0.0.1"; // IRON: never GAIA_HOST-driven, never configurable off localhost.
  const port = options.port ?? gaiaGraphqlPort(options.cwd);
  const yoga = createYoga({
    schema: buildSchema(options.cwd),
    graphqlEndpoint: "/graphql",
    landingPage: false,
    // This is a local debug/test surface (off-by-default, localhost-only) --
    // Pascal wants the REAL resolver error in the browser ("unknown agent:
    // foo", "gaia bash is excluded", ...), not yoga's default production
    // "Unexpected error." mask. Never flip this on for anything internet-facing.
    maskedErrors: false,
  });
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    yoga(request, response);
  });
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => resolveListen());
  });
  const address = server.address();
  const boundPort = typeof address === "object" && address ? address.port : port;
  return {
    url: `http://${host}:${boundPort}/graphql`,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => (error ? rejectClose(error) : resolveClose()));
      }),
  };
}
