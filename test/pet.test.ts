import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_PET_NAME, loadPet } from "../src/server/pet.js";
import { PET_ANIMATIONS, statusToPetState } from "../web/src/pet-state.js";

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "gaia-pets-"));
  const dir = join(root, DEFAULT_PET_NAME);
  await mkdir(dir);
  await writeFile(
    join(dir, "pet.json"),
    JSON.stringify({
      id: DEFAULT_PET_NAME,
      displayName: "Gaia",
      description: "A test pet.",
      spritesheetPath: "spritesheet.webp",
    }),
  );
  await writeFile(join(dir, "spritesheet.webp"), "webp");
  return root;
}

test("loadPet uses the configurable default and validates the package", async () => {
  const root = await fixture();
  try {
    const pet = await loadPet(undefined, root);
    assert.equal(pet.manifest.id, DEFAULT_PET_NAME);
    assert.equal(pet.manifest.spritesheetPath, "spritesheet.webp");
    assert.equal(pet.spritesheetFile, await realpath(join(root, DEFAULT_PET_NAME, "spritesheet.webp")));
    await assert.rejects(() => loadPet("../escape", root), /Invalid pet name/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("loadPet rejects a spritesheet outside its package", async () => {
  const root = await fixture();
  try {
    await writeFile(
      join(root, DEFAULT_PET_NAME, "pet.json"),
      JSON.stringify({ id: "gaia", displayName: "Gaia", description: "A test pet.", spritesheetPath: "../outside.webp" }),
    );
    await writeFile(join(root, "outside.webp"), "webp");
    await assert.rejects(() => loadPet(DEFAULT_PET_NAME, root), /must stay inside/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("status reducer matches Codex notification precedence", () => {
  assert.equal(statusToPetState(null), "idle");
  assert.equal(statusToPetState({ level: "info" }), "idle");
  assert.equal(statusToPetState({ kind: "first-awake", isLoading: true, level: "danger" }), "waving");
  assert.equal(statusToPetState({ isLoading: true, level: "danger" }), "running");
  assert.equal(statusToPetState({ level: "warning" }), "waiting");
  assert.equal(statusToPetState({ level: "danger" }), "failed");
  assert.equal(statusToPetState({ level: "success" }), "review");
});

test("animation table preserves all nine rows, frame counts, and unequal timings", () => {
  assert.deepEqual(
    Object.entries(PET_ANIMATIONS).map(([state, animation]) => [state, animation.row, animation.timings.length, animation.timings.at(-1)]),
    [
      ["idle", 0, 6, 320],
      ["running-right", 1, 8, 220],
      ["running-left", 2, 8, 220],
      ["waving", 3, 4, 280],
      ["jumping", 4, 5, 280],
      ["failed", 5, 8, 240],
      ["waiting", 6, 6, 260],
      ["running", 7, 6, 220],
      ["review", 8, 6, 280],
    ],
  );
  assert.deepEqual(PET_ANIMATIONS.idle.timings, [280, 110, 110, 140, 140, 320]);
});
