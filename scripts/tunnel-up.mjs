#!/usr/bin/env bun
// Durable cloudflared quick-tunnel runner for GAIA.
//
// Spawns `cloudflared tunnel --url http://127.0.0.1:8789`, tees its output to
// /tmp/gaia-cloudflared.log, scans for the assigned https://*.trycloudflare.com
// hostname, and pushes it into the GAIA_EDGE KV namespace's "origin" key so
// the gaia.<sub>.workers.dev front door always proxies to the current tunnel.
//
// Quick-tunnel hostnames rotate every time cloudflared restarts — that's
// fine now, because the workers.dev front door is what the phone talks to,
// and this script keeps KV pointed at whatever the live hostname is.
//
// Runs as the foreground/parent process; exits when cloudflared exits (so a
// launchd KeepAlive wrapper can restart the whole pair together).

import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");
const LOG_PATH = "/tmp/gaia-cloudflared.log";
const NAMESPACE_ID = process.env.GAIA_EDGE_KV_NAMESPACE || "1ed521327e914a49a905ed8aeb320bf9";
const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const BUNX_BIN = process.env.GAIA_BUNX_BIN || "/Users/pascaldisse/.bun/bin/bunx";
const KV_RETRY_MS = Number(process.env.GAIA_KV_RETRY_MS || "30000");
const TUNNEL_PROBE_MS = Number(process.env.GAIA_TUNNEL_PROBE_MS || "60000");
const TUNNEL_GRACE_MS = Number(process.env.GAIA_TUNNEL_GRACE_MS || "120000");
const TUNNEL_PROBE_TIMEOUT_MS = Number(process.env.GAIA_TUNNEL_PROBE_TIMEOUT_MS || "10000");
const TUNNEL_MAX_FAILS = Number(process.env.GAIA_TUNNEL_MAX_FAILS || "3");
const TUNNEL_EXIT_DELAY_MS = Number(process.env.GAIA_TUNNEL_EXIT_DELAY_MS || "5000");

let pushed = null; // last hostname we successfully pushed to KV
let lastSeenHostname = null;
let consecutiveProbeFails = 0;
let restartScheduled = false;
const startedAt = Date.now();

function log(line) {
  appendFileSync(LOG_PATH, line.endsWith("\n") ? line : line + "\n");
}

async function pushOrigin(hostname) {
  if (hostname === pushed) return;
  log(`[tunnel-up] discovered new tunnel hostname: ${hostname}, pushing to KV...`);
  const { execFile } = await import("node:child_process");
  await new Promise((resolve) => {
    execFile(
      BUNX_BIN,
      ["wrangler", "kv", "key", "put", "--namespace-id", NAMESPACE_ID, "--remote", "origin", hostname],
      { cwd: REPO_ROOT, env: process.env },
      (err, stdout, stderr) => {
        if (err) {
          log(`[tunnel-up] KV push FAILED: ${err.message}`);
        } else {
          pushed = hostname;
          log(`[tunnel-up] KV push OK for ${hostname}`);
        }
        resolve();
      }
    );
  });
}

function handleChunk(chunk) {
  const text = chunk.toString("utf8");
  log(text);
  const m = text.match(TUNNEL_URL_RE);
  if (m) {
    lastSeenHostname = m[0];
    pushOrigin(lastSeenHostname).catch((e) => log(`[tunnel-up] pushOrigin error: ${e.message}`));
  }
}

setInterval(() => {
  if (lastSeenHostname && lastSeenHostname !== pushed) {
    pushOrigin(lastSeenHostname).catch((e) => log(`[tunnel-up] pushOrigin error: ${e.message}`));
  }
}, KV_RETRY_MS);

log(`[tunnel-up] starting cloudflared at ${new Date().toISOString()}`);

const CLOUDFLARED_BIN = "/opt/homebrew/bin/cloudflared";

const child = spawn(CLOUDFLARED_BIN, ["tunnel", "--url", "http://127.0.0.1:8789"], {
  stdio: ["ignore", "pipe", "pipe"],
});

child.stdout.on("data", handleChunk);
child.stderr.on("data", handleChunk);

setInterval(async () => {
  if (Date.now() - startedAt < TUNNEL_GRACE_MS || !lastSeenHostname || restartScheduled) return;

  try {
    const response = await fetch(lastSeenHostname, {
      method: "HEAD",
      signal: AbortSignal.timeout(TUNNEL_PROBE_TIMEOUT_MS),
    });
    if (response.status === 530) throw new Error("status 530");
    consecutiveProbeFails = 0;
  } catch {
    consecutiveProbeFails += 1;
    if (consecutiveProbeFails >= TUNNEL_MAX_FAILS) {
      restartScheduled = true;
      log(`[tunnel-up] tunnel hostname dead (${consecutiveProbeFails} consecutive probe fails), killing cloudflared for launchd restart`);
      child.kill("SIGTERM");
      setTimeout(() => process.exit(1), TUNNEL_EXIT_DELAY_MS);
    }
  }
}, TUNNEL_PROBE_MS);

child.on("exit", (code, signal) => {
  log(`[tunnel-up] cloudflared exited code=${code} signal=${signal}`);
  process.exit(code === null ? 1 : code);
});

child.on("error", (err) => {
  log(`[tunnel-up] cloudflared spawn error: ${err.message}`);
  process.exit(1);
});
