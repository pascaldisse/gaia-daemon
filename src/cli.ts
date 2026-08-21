#!/usr/bin/env bun
// The one entrypoint. Lightweight subcommands (mem/recall/summon, init, agent
// create) never pull in the web-server graph — heavy modules load lazily.

import { hardenPath } from "./core/env.js";
import { gaiaGraphqlEnabled } from "./core/config.js";
import { scaffoldGlobalAgent } from "./domain/agents.js";
import { globalAgentsPath, initWorkspace } from "./domain/workspace.js";
import { createUser, listUsers, removeUser } from "./domain/users.js";
import { searchWeb, type WebSearchProvider } from "./services/web-search.js";

// Before anything else: repair PATH so harness CLIs resolve no matter what
// launched us (terminal, native app shell, launchd). Children inherit it.
hardenPath();

function usage(): void {
  console.log(
    `gaia — local-first multi-agent room\n\nUsage:\n  gaia                         start the GAIA web UI\n  gaia init                    create project room files and seed global personas\n  gaia agent create <id> [name] create a global agent persona scaffold\n  gaia user create <username> <password> [display name]   create a human login\n  gaia user list|remove <id>   manage human logins\n  gaia setup list|activate|status|off   load a saved multi-agent setup into a room\n  gaia serve <room> [--port N] [--adapter id]   serve a monad room as one model\n  gaia mem|recall|artifact|summon … agent room tools (used inside a turn)\n  gaia resume <roomId> "<message>"   follow-up message into an existing sub-room\n  gaia dream [agent] [--apply] propose/apply a memory consolidation (user-triggered)\n  gaia caryll compress|expand|stats <file> [-o <out>]   lossless context compression\n  gaia web <query> [-n N] [--provider name]             web search; Brave → Tavily → Serper\n  GAIA_GRAPHQL_ENABLED=true gaia                         also serves GraphiQL/GraphQL at /graphql (GAIA_GRAPHQL_PORT, default 4780)\n  gaia --help                  show help`
  );
}

async function runWebCli(args: string[]): Promise<void> {
  let provider: WebSearchProvider | undefined;
  let maxResults: number | undefined;
  const queryParts: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--provider") {
      const value = args[++index];
      if (value !== "brave" && value !== "tavily" && value !== "serper") throw new Error("web --provider must be brave, tavily, or serper");
      provider = value;
    } else if (arg === "-n" || arg === "--max-results") {
      const value = Number.parseInt(args[++index] ?? "", 10);
      if (!Number.isInteger(value) || value < 1) throw new Error("web -n must be a positive integer");
      maxResults = value;
    } else {
      queryParts.push(arg);
    }
  }
  const query = queryParts.join(" ").trim();
  if (!query) throw new Error("Usage: gaia web <query> [-n N] [--provider brave|tavily|serper]");
  const response = await searchWeb({ query, ...(maxResults === undefined ? {} : { maxResults }), ...(provider === undefined ? {} : { provider }) });
  console.log(`Provider: ${response.provider}`);
  for (const [index, item] of response.results.entries()) {
    console.log(`--- Result ${index + 1} ---`);
    console.log(`Title: ${item.title}`);
    console.log(`Link: ${item.url}`);
    console.log(`Snippet: ${item.snippet}`);
    console.log("");
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(2);

  // Hidden: the shared confinement entrypoint. Parsed from rawArgs so flags
  // meant for the CHILD (after `--`) are never touched by the --dev filter.
  if (rawArgs[0] === "__sandbox-exec") {
    const { runSandboxExec } = await import("./harness/sandbox/cli.js");
    process.exitCode = await runSandboxExec(rawArgs.slice(1));
    return;
  }

  if (rawArgs.includes("--dev")) {
    console.warn("[gaia] --dev is retired: dev mode was deleted 2026-07-11; running normally.");
  }
  const args = rawArgs.filter((arg) => arg !== "--dev");
  if (args.includes("--help") || args.includes("-h")) {
    usage();
    return;
  }

  // Hidden: the per-(room, agent) runner subprocess the daemon spawns for
  // every harness. Long-lived; speaks the runner protocol over stdio.
  if (args[0] === "__run-agent") {
    const { runAgentRunner } = await import("./harness/runner.js");
    await runAgentRunner();
    return;
  }

  if (args[0] === "web") {
    try {
      await runWebCli(args.slice(1));
    } catch (error) {
      console.error(`gaia web: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
    return;
  }

  if (args[0] === "mem" || args[0] === "memory" || args[0] === "recall" || args[0] === "artifact" || args[0] === "summon" || args[0] === "resume" || args[0] === "caryll" || args[0] === "dream") {
    const { runHarnessCommand } = await import("./services/cli-tools.js");
    process.exitCode = await runHarnessCommand(args);
    return;
  }

  if (args[0] === "setup") {
    const { runSetupCli } = await import("./services/setups.js");
    process.exitCode = await runSetupCli(args.slice(1));
    return;
  }

  if (args[0] === "serve") {
    const { runServeCli } = await import("./services/setups.js");
    process.exitCode = await runServeCli(args.slice(1));
    return;
  }

  if (args[0] === "agent" && args[1] === "create") {
    const id = args[2];
    const displayName = args.slice(3).join(" ").trim() || undefined;
    if (!id) {
      console.error("Usage: gaia agent create <id> [display name]");
      process.exitCode = 1;
      return;
    }
    try {
      const result = await scaffoldGlobalAgent(globalAgentsPath(), id, { displayName });
      console.log(`Agent created: ${result.agentDir}`);
      console.log(`Config: ${result.configPath}`);
      console.log(`Soul: ${result.soulPath}`);
      console.log(`Memory: ${result.memoryDir}`);
      console.log(`Roles: ${result.rolesDir}`);
    } catch (error) {
      console.error(`gaia: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
    return;
  }

  if (args[0] === "user") {
    const sub = args[1];
    try {
      if (sub === "create") {
        const [username, password, ...rest] = args.slice(2);
        if (!username || !password) {
          console.error("Usage: gaia user create <username> <password> [display name]");
          process.exitCode = 1;
          return;
        }
        const user = createUser(username, password, rest.join(" ").trim() || undefined);
        console.log(`User created: ${user.id} (${user.username})`);
        return;
      }
      if (sub === "list") {
        for (const user of listUsers()) console.log(`${user.id}\t${user.username}\t${user.displayName}`);
        return;
      }
      if (sub === "remove") {
        const id = args[2];
        if (!id) {
          console.error("Usage: gaia user remove <id>");
          process.exitCode = 1;
          return;
        }
        console.log(removeUser(id) ? `User removed: ${id}` : `No such user: ${id}`);
        return;
      }
      console.error("Usage: gaia user create|list|remove ...");
      process.exitCode = 1;
    } catch (error) {
      console.error(`gaia: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
    return;
  }

  if (args[0] === "init") {
    const result = await initWorkspace(process.cwd());
    console.log(`Project workspace ready: ${result.workspaceDir}`);
    console.log(`Global personas ready: ${result.globalAgentsDir}`);
    return;
  }

  if (args.length > 0) {
    usage();
    process.exitCode = 1;
    return;
  }

  try {
    // Register every harness + sandbox backend + routing policy exactly once,
    // then start the server.
    await import("./harness/index.js");
    await import("./services/policies/index.js");
    const { startWebServer } = await import("./server/http.js");
    const server = await startWebServer({ cwd: process.cwd() });
    console.log(`GAIA web UI: ${server.url}`);
    // GraphQL test surface: off by default, separate localhost-only port —
    // see src/server/graphql.ts module doc. GAIA_GRAPHQL_ENABLED=true to arm.
    // The specifier is a runtime-only variable (not an inline string literal)
    // on purpose: graphql.ts pulls in graphql-yoga, whose types otherwise leak
    // into this whole tsc program the moment tsc can statically resolve a
    // dynamic import() target — verified live 2026-08-21 (see
    // tsconfig.json's exclude comment + src/server/graphql.tsconfig.json).
    const graphqlModulePath = "./server/graphql.js";
    const graphql = gaiaGraphqlEnabled() ? await (await import(graphqlModulePath)).startGraphqlServer({ cwd: process.cwd() }) : undefined;
    if (graphql) console.log(`GAIA GraphQL test surface: ${graphql.url}`);
    console.log("Press Ctrl+C to stop.");
    await new Promise<void>((resolve) => {
      const stop = (): void => {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        void Promise.all([server.close(), graphql ? graphql.close() : Promise.resolve()]).finally(resolve);
      };
      process.on("SIGINT", stop);
      process.on("SIGTERM", stop);
    });
  } catch (error) {
    console.error(`gaia: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

await main();
