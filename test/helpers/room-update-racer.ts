import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RoomHandle } from "../../src/domain/rooms.js";

const [workspaceRoot, agentId, barrierDir] = process.argv.slice(2);
if (!workspaceRoot || !agentId || !barrierDir) throw new Error("usage: room-update-racer <workspace-root> <agent-id> <barrier-dir>");

const room = await RoomHandle.open(workspaceRoot, "default");
await writeFile(join(barrierDir, `${agentId}.ready`), "", "utf8");
while (!existsSync(join(barrierDir, "release"))) await Bun.sleep(2);
await room.updateState((state) => {
  state.agentCursors[agentId] = 1;
});
