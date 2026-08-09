import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RoomHandle } from "../../src/domain/rooms.js";
import { withSqliteImmediateLock } from "../../src/core/sqlite.js";

const args = process.argv.slice(2);
if (args[0] === "hold-lock") {
  const [, lockPath, barrierDir] = args;
  if (!lockPath || !barrierDir) throw new Error("usage: room-update-racer hold-lock <lock-path> <barrier-dir>");
  await withSqliteImmediateLock(lockPath, async () => {
    await writeFile(join(barrierDir, "locked"), "", "utf8");
    await new Promise<void>(() => {});
  });
} else {
  const [workspaceRoot, agentId, barrierDir] = args;
  if (!workspaceRoot || !agentId || !barrierDir) throw new Error("usage: room-update-racer <workspace-root> <agent-id> <barrier-dir>");
  const room = await RoomHandle.open(workspaceRoot, "default");
  await writeFile(join(barrierDir, `${agentId}.ready`), "", "utf8");
  while (!existsSync(join(barrierDir, "release"))) await Bun.sleep(2);
  await room.updateState((state) => {
    state.agentCursors[agentId] = 1;
  });
}
