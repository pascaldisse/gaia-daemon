// `gaia setup …` — the offline CLI surface for the setup system. Reads/writes the
// workspace directly (no running daemon needed); a daemon that is already serving
// the room picks up the change on its next reload / room reselect.

import { loadWorkspace } from "../workspace/workspace-loader.js";
import { activateSetup, deactivateMonad, discoverSetups, readRoomMonad } from "./setup-loader.js";

const USAGE = `Usage:
  gaia setup list                    list available setups
  gaia setup activate <id> [room]    load a setup into a room (default: the workspace's current room)
  gaia setup status [room]           show a room's active setup
  gaia setup off [room]              clear the monad from a room`;

/** Dispatches `gaia setup …`. Returns a process exit code. */
export async function runSetupCli(args: string[], cwd = process.cwd()): Promise<number> {
  const sub = args[0];

  let workspace;
  try {
    workspace = await loadWorkspace(cwd);
  } catch (error) {
    console.error(`gaia: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const currentRoom = workspace.config.room;

  if (!sub || sub === "list") {
    const setups = await discoverSetups(workspace.rootDir);
    if (setups.length === 0) {
      console.log("No setups found (looked in setups/, ~/.gaia/setups/, .gaia/setups/).");
      return 0;
    }
    for (const setup of setups) {
      console.log(`${setup.id}${setup.displayName && setup.displayName !== setup.id ? ` — ${setup.displayName}` : ""} [${setup.source}]`);
      if (setup.description) console.log(`  ${setup.description}`);
    }
    return 0;
  }

  if (sub === "activate") {
    const id = args[1];
    const room = args[2] ?? currentRoom;
    if (!id) {
      console.error(USAGE);
      return 1;
    }
    try {
      const result = await activateSetup(workspace, id, room);
      const pool = result.monad.slots.map((slot) => `@${slot.agentId}${slot.defaultRole ? `(${slot.defaultRole})` : ""}`).join(" · ");
      console.log(`Activated '${result.setupId}' into room '${room}'.`);
      console.log(`  policy: ${result.monad.policy}   maxTurns: ${result.monad.maxTurns}   coordinator: @${result.monad.coordinatorAgentId}`);
      console.log(`  pool: ${pool}`);
      if (result.placedRoles.length > 0) console.log(`  roles placed: ${result.placedRoles.join(", ")}`);
      console.log(`Send a message to room '${room}' to run the monad; each step appears as a child room.`);
      return 0;
    } catch (error) {
      console.error(`gaia: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }

  if (sub === "status") {
    const room = args[1] ?? currentRoom;
    const monad = await readRoomMonad(workspace, room);
    if (!monad) {
      console.log(`Room '${room}' is not a monad room.`);
      return 0;
    }
    const pool = monad.slots.map((slot) => `@${slot.agentId}${slot.defaultRole ? `(${slot.defaultRole})` : ""}`).join(" · ");
    console.log(`Room '${room}' — policy: ${monad.policy}, maxTurns: ${monad.maxTurns}, coordinator: @${monad.coordinatorAgentId ?? monad.slots[0]?.agentId}`);
    console.log(`  pool: ${pool}`);
    return 0;
  }

  if (sub === "off") {
    const room = args[1] ?? currentRoom;
    const cleared = await deactivateMonad(workspace, room);
    console.log(cleared ? `Cleared the monad from room '${room}'.` : `Room '${room}' had no active monad.`);
    return 0;
  }

  console.error(`Unknown setup subcommand: ${sub}\n\n${USAGE}`);
  return 1;
}
