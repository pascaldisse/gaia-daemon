import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";

const REPO = join(import.meta.dir, "..");
const SCRIPT = join(REPO, "scripts", "tunnel-up.mjs");

function waitForExit(child: ReturnType<typeof spawn>) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}

test("tunnel-up times out KV writes and never overlaps retries", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gaia-tunnel-up-test-"));
  const state = join(dir, "state");
  const cloudflared = join(dir, "cloudflared");
  const bunx = join(dir, "bunx");
  await writeFile(join(dir, "active"), "0");
  await writeFile(join(dir, "max"), "0");
  await writeFile(
    cloudflared,
    "#!/bin/sh\necho 'INF https://test-123.trycloudflare.com'\nsleep 1\n",
  );
  await writeFile(
    bunx,
    `#!/bin/sh
lock() { while ! mkdir "$TEST_STATE/lock" 2>/dev/null; do sleep 0.01; done; }
unlock() { rmdir "$TEST_STATE/lock"; }
cleanup() {
  lock
  active=$(cat "$TEST_STATE/active")
  echo $((active - 1)) > "$TEST_STATE/active"
  unlock
  exit 0
}
lock
active=$(cat "$TEST_STATE/active")
active=$((active + 1))
echo "$active" > "$TEST_STATE/active"
max=$(cat "$TEST_STATE/max")
if [ "$active" -gt "$max" ]; then echo "$active" > "$TEST_STATE/max"; fi
unlock
trap cleanup TERM INT
sleep 10
cleanup
`,
  );
  await chmod(cloudflared, 0o755);
  await chmod(bunx, 0o755);

  try {
    const child = spawn(process.execPath, [SCRIPT], {
      cwd: REPO,
      env: {
        ...process.env,
        TEST_STATE: dir,
        GAIA_CLOUDFLARED_BIN: cloudflared,
        GAIA_BUNX_BIN: bunx,
        GAIA_TUNNEL_LOG_PATH: join(dir, "tunnel.log"),
        GAIA_TUNNEL_KV_TIMEOUT_MS: "100",
        GAIA_TUNNEL_KV_KILL_GRACE_MS: "50",
        GAIA_TUNNEL_KV_BACKOFF_BASE_MS: "50",
        GAIA_TUNNEL_KV_BACKOFF_MAX_MS: "50",
        GAIA_TUNNEL_GRACE_MS: "60000",
      },
    });
    const result = await waitForExit(child);
    assert.equal(result.code, 0);
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(Number(await readFile(join(dir, "max"), "utf8")), 1);
    assert.match(await readFile(join(dir, "tunnel.log"), "utf8"), /KV push TIMED OUT after 100ms/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
