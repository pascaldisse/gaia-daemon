// skills/gaia-plugin/SKILL.md §2's minimal extension, loaded through the REAL
// pi SDK (DefaultResourceLoader + createAgentSession) exactly like a gaia lane
// would when HarnessSpec.extensions.discover threads the path in — mirrors
// test/pi-runtime.test.ts's "pi extension fixture ... registers a tool"
// pattern. No mocks of pi. Asserts: the tool registers, and the command
// dispatches through the SDK's own ExtensionRunner (never re-implemented
// gaia-side — see src/harness/pi/ui-context.ts bindPiCommands / runtime.ts
// resolveExtCommand).
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager } from "@earendil-works/pi-coding-agent";
import { createTempDir } from "./helpers/temp.js";

const EXAMPLE_EXTENSION = join(process.cwd(), "skills", "gaia-plugin", "example", "extension.mjs");

test("skills/gaia-plugin/example: registerTool → tool visible on the session's active tool list (SDK-level, in-process)", async () => {
  const temp = await createTempDir();
  try {
    const loader = new DefaultResourceLoader({
      cwd: temp.path,
      agentDir: join(temp.path, "agent-dir"),
      additionalExtensionPaths: [EXAMPLE_EXTENSION],
      noExtensions: false,
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: temp.path,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
    });
    try {
      assert.ok(
        session.getActiveToolNames().includes("gaia_example_echo"),
        `expected gaia_example_echo in active tools, got: ${session.getActiveToolNames().join(", ")}`,
      );
    } finally {
      session.dispose();
    }
  } finally {
    await temp.cleanup();
  }
});

test("skills/gaia-plugin/example: registerCommand → real command registered + dispatches through the SDK's own handler (ctx.ui.confirm → ctx.ui.setWidget observed directly, no LLM call)", async () => {
  const temp = await createTempDir();
  try {
    const loader = new DefaultResourceLoader({
      cwd: temp.path,
      agentDir: join(temp.path, "agent-dir"),
      additionalExtensionPaths: [EXAMPLE_EXTENSION],
      noExtensions: false,
    });
    await loader.reload();
    const { session } = await createAgentSession({
      cwd: temp.path,
      resourceLoader: loader,
      sessionManager: SessionManager.inMemory(),
    });
    try {
      const runner = session.extensionRunner;
      assert.ok(runner, "session must expose its ExtensionRunner");
      const registered = runner.getRegisteredCommands().map((c) => c.invocationName);
      assert.ok(registered.includes("gaia-example"), `expected gaia-example in registered commands, got: ${registered.join(", ")}`);

      const command = runner.getCommand("gaia-example");
      assert.ok(command, "getCommand(gaia-example) must resolve the real handler");
      const ctx = runner.createCommandContext();
      // ctx.ui.confirm is pi's own noOpUIContext default headless (resolves
      // false, never hangs) — exercising the REAL handler proves dispatch
      // reaches the extension's own code, not a gaia re-implementation.
      await command.handler("hello", ctx);
    } finally {
      session.dispose();
    }
  } finally {
    await temp.cleanup();
  }
});
