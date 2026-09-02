#!/usr/bin/env bun
// Durable cloudflared quick-tunnel runner for GAIA.
//
// Spawns cloudflared, extracts its quick-tunnel hostname, and keeps the GAIA
// edge KV "origin" key current. KV writes are deliberately single-flight:
// output can produce many observations, but only the newest hostname is ever
// retried after a write finishes or backs off.

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const REPO_ROOT = path.dirname(fileURLToPath(import.meta.url)).replace(/\/scripts$/, "");

function positiveIntEnv(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${name} must be a positive number`);
  }
  return Math.floor(value);
}

const LOG_PATH = process.env.GAIA_TUNNEL_LOG_PATH || path.join(REPO_ROOT, "logs", "gaia-cloudflared.log");
const NAMESPACE_ID = process.env.GAIA_EDGE_KV_NAMESPACE || "1ed521327e914a49a905ed8aeb320bf9";
const TUNNEL_URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const BUNX_BIN = process.env.GAIA_BUNX_BIN || "/Users/pascaldisse/.bun/bin/bunx";
const CLOUDFLARED_BIN = process.env.GAIA_CLOUDFLARED_BIN || "/opt/homebrew/bin/cloudflared";
const TUNNEL_TARGET_URL = process.env.GAIA_TUNNEL_TARGET_URL || "http://127.0.0.1:8789";
const KV_TIMEOUT_MS = positiveIntEnv("GAIA_TUNNEL_KV_TIMEOUT_MS", "30000");
const KV_KILL_GRACE_MS = positiveIntEnv("GAIA_TUNNEL_KV_KILL_GRACE_MS", "5000");
const KV_BACKOFF_BASE_MS = positiveIntEnv("GAIA_TUNNEL_KV_BACKOFF_BASE_MS", process.env.GAIA_KV_RETRY_MS || "30000");
const KV_BACKOFF_MAX_MS = positiveIntEnv("GAIA_TUNNEL_KV_BACKOFF_MAX_MS", "300000");
const TUNNEL_PROBE_MS = positiveIntEnv("GAIA_TUNNEL_PROBE_MS", "60000");
const TUNNEL_GRACE_MS = positiveIntEnv("GAIA_TUNNEL_GRACE_MS", "120000");
const TUNNEL_PROBE_TIMEOUT_MS = positiveIntEnv("GAIA_TUNNEL_PROBE_TIMEOUT_MS", "10000");
const TUNNEL_MAX_FAILS = positiveIntEnv("GAIA_TUNNEL_MAX_FAILS", "3");
const TUNNEL_EXIT_DELAY_MS = positiveIntEnv("GAIA_TUNNEL_EXIT_DELAY_MS", "5000");

mkdirSync(path.dirname(LOG_PATH), { recursive: true });

let pushed = null;
let lastSeenHostname = null;
let kvPushInFlight = false;
let activeKvChild = null;
let tunnelChild = null;
let kvRetryTimer = null;
let kvFailures = 0;
let consecutiveProbeFails = 0;
let restartScheduled = false;
const startedAt = Date.now();

function log(line) {
  appendFileSync(LOG_PATH, line.endsWith("\n") ? line : line + "\n");
}

function killProcessTree(child, signal) {
  if (!child?.pid) return;
  try {
    // KV commands are detached so bunx and its wrangler descendants share a
    // process group; killing the group prevents an orphaned wrangler.
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

function runKvPut(hostname) {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let killTimer = null;
    const child = spawn(
      BUNX_BIN,
      ["wrangler", "kv", "key", "put", "--namespace-id", NAMESPACE_ID, "--remote", "origin", hostname],
      { cwd: REPO_ROOT, env: process.env, detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    activeKvChild = child;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (activeKvChild === child) activeKvChild = null;
      resolve(result);
    };

    child.stdout.on("data", (chunk) => log(`[tunnel-up] KV stdout: ${chunk}`));
    child.stderr.on("data", (chunk) => log(`[tunnel-up] KV stderr: ${chunk}`));
    child.on("error", (error) => settle({ ok: false, error }));
    child.on("close", (code, signal) => {
      settle({
        ok: !timedOut && code === 0,
        timedOut,
        error: code === 0 && !timedOut ? null : new Error(`exit code=${code} signal=${signal}`),
      });
    });

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      log(`[tunnel-up] KV push TIMED OUT after ${KV_TIMEOUT_MS}ms; terminating process group pid=${child.pid}`);
      killProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), KV_KILL_GRACE_MS);
    }, KV_TIMEOUT_MS);
  });
}

function schedulePush(delayMs) {
  if (kvRetryTimer) clearTimeout(kvRetryTimer);
  kvRetryTimer = setTimeout(() => {
    kvRetryTimer = null;
    pushLatestOrigin().catch((error) => log(`[tunnel-up] pushOrigin error: ${error.message}`));
  }, delayMs);
}

async function pushLatestOrigin() {
  const hostname = lastSeenHostname;
  if (!hostname || hostname === pushed) return;
  if (kvPushInFlight) {
    log(`[tunnel-up] KV push already in flight; skipping ${hostname} (latest value retained)`);
    return;
  }

  kvPushInFlight = true;
  log(`[tunnel-up] discovered tunnel hostname: ${hostname}, pushing to KV...`);
  try {
    const result = await runKvPut(hostname);
    if (result.ok) {
      pushed = hostname;
      kvFailures = 0;
      log(`[tunnel-up] KV push OK for ${hostname}`);
      if (lastSeenHostname !== pushed) schedulePush(0);
      return;
    }

    kvFailures += 1;
    const delay = Math.min(KV_BACKOFF_BASE_MS * 2 ** (kvFailures - 1), KV_BACKOFF_MAX_MS);
    const reason = result.timedOut ? "timeout" : result.error?.message || "unknown error";
    log(`[tunnel-up] KV push FAILED (${reason}); retrying latest origin in ${delay}ms (failure ${kvFailures})`);
    schedulePush(delay);
  } finally {
    kvPushInFlight = false;
  }
}

function handleChunk(chunk) {
  const text = chunk.toString("utf8");
  log(text);
  const m = text.match(TUNNEL_URL_RE);
  if (!m) return;
  lastSeenHostname = m[0];
  pushLatestOrigin().catch((error) => log(`[tunnel-up] pushOrigin error: ${error.message}`));
}

function stopKvChild() {
  if (kvRetryTimer) clearTimeout(kvRetryTimer);
  killProcessTree(activeKvChild, "SIGTERM");
}

function shutdown(signal) {
  log(`[tunnel-up] received ${signal}; stopping tunnel and active KV push`);
  stopKvChild();
  tunnelChild?.kill("SIGTERM");
  setTimeout(() => process.exit(0), TUNNEL_EXIT_DELAY_MS).unref();
}

process.once("SIGTERM", () => shutdown("SIGTERM"));
process.once("SIGINT", () => shutdown("SIGINT"));

log(`[tunnel-up] starting cloudflared at ${new Date().toISOString()}`);

const child = spawn(CLOUDFLARED_BIN, ["tunnel", "--url", TUNNEL_TARGET_URL], {
  stdio: ["ignore", "pipe", "pipe"],
});
tunnelChild = child;

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
  stopKvChild();
  process.exit(code === null ? 1 : code);
});

child.on("error", (err) => {
  log(`[tunnel-up] cloudflared spawn error: ${err.message}`);
  stopKvChild();
  process.exit(1);
});
