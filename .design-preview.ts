process.env.GAIA_HOME = process.env.PREVIEW_HOME;
const ws = process.env.PREVIEW_WS as string;
const { initWorkspace, ensureWorkspaceRoom } = await import("./src/workspace/workspace-loader.ts");
await initWorkspace(ws);
// seed a couple extra rooms so tabs/tree have content
for (const r of ["ari", "build", "research"]) {
  await ensureWorkspaceRoom(ws, r);
}
const { startWebServer } = await import("./src/web/server.ts");
const server = await startWebServer({ cwd: ws, port: Number(process.env.PREVIEW_PORT ?? 8789) });
console.log("PREVIEW_URL " + server.url);
