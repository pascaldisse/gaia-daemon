import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { workspacePaths } from "../src/core/paths.js";
import { readJson } from "../src/core/store.js";
import type { ArtifactManifest } from "../src/domain/artifacts.js";
import { createArtifact, listArtifacts, readArtifact, updateArtifact } from "../src/services/artifacts.js";
import { createTempDir } from "./helpers/temp.js";

test("room artifact ledger supports create, read, update, and list", async (t) => {
  const temp = await createTempDir("gaia-artifacts-");
  t.after(() => temp.cleanup());
  const location = { rootDir: temp.path, roomId: "room-a" };

  assert.deepEqual(await listArtifacts(location), []);

  const created = await createArtifact(
    location,
    { name: "Landing page", kind: "html", mediaType: "text/html", payload: "<h1>Hello</h1>" },
    { id: () => "artifact_fixed", now: () => "2026-08-05T10:00:00.000Z" },
  );
  assert.deepEqual(created, {
    version: 1,
    artifactId: "artifact_fixed",
    roomId: "room-a",
    name: "Landing page",
    kind: "html",
    mediaType: "text/html",
    bytes: 14,
    sha256: "e2c6c0ea7c7900c31f953e48d30d5e839801ab90630d751e7c8426ed5859da47",
    createdAt: "2026-08-05T10:00:00.000Z",
    updatedAt: "2026-08-05T10:00:00.000Z",
  });

  const manifestPath = workspacePaths.roomArtifactManifest(temp.path, "room-a", "artifact_fixed");
  const payloadPath = workspacePaths.roomArtifactPayload(temp.path, "room-a", "artifact_fixed");
  assert.deepEqual(await readJson(manifestPath), created, "ledger persists manifest.json");
  assert.equal(await readFile(payloadPath, "utf8"), "<h1>Hello</h1>", "ledger persists payload");

  const stored = await readArtifact(location, "artifact_fixed");
  assert.deepEqual(stored.manifest, created);
  assert.equal(Buffer.from(stored.payload).toString("utf8"), "<h1>Hello</h1>");

  const updated = await updateArtifact(
    location,
    "artifact_fixed",
    { name: "Design tokens", kind: "design", mediaType: "application/json", payload: '{"space":8}' },
    { now: () => "2026-08-05T10:05:00.000Z" },
  );
  assert.equal(updated.createdAt, created.createdAt);
  assert.equal(updated.updatedAt, "2026-08-05T10:05:00.000Z");
  assert.equal(updated.name, "Design tokens");
  assert.equal(updated.kind, "design");
  assert.equal(updated.mediaType, "application/json");
  assert.equal(updated.bytes, 11);
  assert.notEqual(updated.sha256, created.sha256);
  assert.deepEqual(await listArtifacts(location), [updated]);
  assert.equal(Buffer.from((await readArtifact(location, "artifact_fixed")).payload).toString("utf8"), '{"space":8}');
});

test("artifact kind validation rejects values outside html/json/design", async (t) => {
  const temp = await createTempDir("gaia-artifact-kind-");
  t.after(() => temp.cleanup());
  const location = { rootDir: temp.path, roomId: "room-kind" };

  await assert.rejects(
    () =>
      createArtifact(
        location,
        { name: "Bad", kind: "image" as never, mediaType: "image/png", payload: "x" },
        { id: () => "artifact_bad" },
      ),
    /invalid artifact kind: image/,
  );
  assert.deepEqual(await listArtifacts(location), []);

  await createArtifact(
    location,
    { name: "Good", kind: "json", mediaType: "application/json", payload: "{}" },
    { id: () => "artifact_good" },
  );
  await assert.rejects(
    () => updateArtifact(location, "artifact_good", { kind: "text" as never }),
    /invalid artifact kind: text/,
  );
  const manifest = (await readJson(workspacePaths.roomArtifactManifest(temp.path, "room-kind", "artifact_good"))) as ArtifactManifest;
  assert.equal(manifest.kind, "json", "failed validation leaves the ledger unchanged");
});
