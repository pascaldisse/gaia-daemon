#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { networkInterfaces } from 'node:os';
import { globSync, statSync } from 'node:fs';

const DEFAULT_PORT = Number(process.env.GAIA_PORT || 8787);
const BUNDLE_ID = 'com.gaia.daemon';

function usage() {
  console.log(`Usage:\n  node scripts/gaia-mobile.mjs url [--host IP] [--simulator]\n  node scripts/gaia-mobile.mjs ios-dev [--simulator] [--host IP] [--device DEVICE] [-- RUNNER_ARGS...]\n  node scripts/gaia-mobile.mjs ios-open [--host IP]\n  node scripts/gaia-mobile.mjs device --udid UDID --url URL [--debug] [--no-launch]\n\nStarts or reuses a GAIA daemon reachable from iOS, then runs Tauri iOS.\nSimulator mode uses http://127.0.0.1:${DEFAULT_PORT}/ so it can attach to the existing Mac-local daemon.\nPhone mode uses http://<mac-lan-ip>:${DEFAULT_PORT}/ and requires GAIA_HOST=0.0.0.0.\n\n'device' bypasses 'tauri ios dev' (which waits forever for a phantom dev\nserver on physical devices) by doing 'tauri ios build' -> 'devicectl device\ninstall app' -> 'devicectl device process launch'. --url is baked in as\nGAIA_MOBILE_DAEMON_URL at build time (compile-time env, never hardcoded in\nsource) — point it at an auth-bootstrap URL like\nhttps://<tunnel-host>/auth?token=<token> to land the app already\nauthenticated against an edge-proxy-fronted daemon.`);
}

function parse(argv) {
  const [cmd = 'ios-dev', ...rest] = argv;

  if (cmd === 'device') {
    let udid = process.env.GAIA_DEVICE_UDID || '';
    let url = process.env.GAIA_MOBILE_DAEMON_URL || '';
    let debug = false;
    let launch = true;
    for (let i = 0; i < rest.length; i++) {
      const arg = rest[i];
      if (arg === '--udid') udid = rest[++i] || '';
      else if (arg.startsWith('--udid=')) udid = arg.slice('--udid='.length);
      else if (arg === '--url') url = rest[++i] || '';
      else if (arg.startsWith('--url=')) url = arg.slice('--url='.length);
      else if (arg === '--debug') debug = true;
      else if (arg === '--no-launch') launch = false;
    }
    return { cmd, udid, url, debug, launch };
  }

  let host = process.env.GAIA_MOBILE_HOST || '';
  let simulator = false;
  let device = '';
  const passthrough = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--simulator') simulator = true;
    else if (arg === '--host') host = rest[++i] || '';
    else if (arg.startsWith('--host=')) host = arg.slice('--host='.length);
    else if (arg === '--device') device = rest[++i] || '';
    else if (arg.startsWith('--device=')) device = arg.slice('--device='.length);
    else if (arg === '--') passthrough.push(...rest.slice(i + 1));
    else passthrough.push(arg);
  }
  return { cmd, host: host || (simulator ? '127.0.0.1' : pickLanHost()), device, passthrough, simulator };
}

function pickLanHost() {
  const nets = networkInterfaces();
  const candidates = [];
  for (const [name, addrs] of Object.entries(nets)) {
    for (const addr of addrs || []) {
      if (addr.family !== 'IPv4' || addr.internal) continue;
      candidates.push({ name, address: addr.address });
    }
  }
  const preferred = candidates.find((c) => /^(en|bridge|utun)/.test(c.name)) || candidates[0];
  if (!preferred) throw new Error('No LAN IPv4 address found. Pass --host <mac-lan-ip>.');
  return preferred.address;
}

async function canFetch(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

function spawnLogged(program, args, opts = {}) {
  console.log(`$ ${program} ${args.join(' ')}`);
  return spawn(program, args, {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: { ...process.env, ...(opts.env || {}) },
  });
}

async function waitFor(url, label) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await canFetch(url)) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} did not become reachable at ${url} within 30s`);
}

async function ensureDaemon(host, port) {
  const lan = `http://${host}:${port}/api/app`;
  if (await canFetch(lan)) return null;

  const loopback = `http://127.0.0.1:${port}/api/app`;
  if (await canFetch(loopback)) {
    throw new Error(`GAIA is already running on :${port}, but not reachable at ${lan}.\nStop it and restart with LAN binding:\n  npm run stop\n  GAIA_HOST=0.0.0.0 npm run dev`);
  }

  const child = spawnLogged('npm', ['run', 'dev'], {
    env: { GAIA_HOST: '0.0.0.0', GAIA_PORT: String(port) },
  });
  await waitFor(lan, 'GAIA daemon');
  return child;
}

function runTauriIos(kind, host, url, device, passthrough) {
  const args = ['exec', 'tauri', '--', 'ios', kind === 'open' ? 'dev' : 'dev', '--features', 'webkit', '--host', host];
  if (kind === 'open') args.push('--open');
  if (device) args.push(device);
  if (passthrough.length) args.push('--', ...passthrough);
  return spawnLogged('npm', args, { env: { GAIA_MOBILE_DAEMON_URL: url } });
}

/** Run a command to completion, streaming output, rejecting on non-zero exit. */
function run(program, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnLogged(program, args, opts);
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (signal) return reject(new Error(`${program} ${args.join(' ')} killed by ${signal}`));
      if (code !== 0) return reject(new Error(`${program} ${args.join(' ')} exited with code ${code}`));
      resolve();
    });
  });
}

/**
 * Physical-device path that bypasses `tauri ios dev`'s phantom-dev-server
 * wait (which never resolves for this thin client — it loads its frontend
 * FROM the daemon, there is no separate dev server to wait for). Instead:
 *   tauri ios build --debug  ->  devicectl device install app  ->
 *   devicectl device process launch.
 * `url` is baked in as GAIA_MOBILE_DAEMON_URL, a compile-time env consumed
 * by `option_env!` in src-tauri/src/lib.rs — never hardcoded in source, so
 * pointing at a new hostname (e.g. a future stable tunnel) is just a rebuild
 * with a different --url.
 */
async function runDeviceDeploy({ udid, url, debug, launch }) {
  if (!udid) throw new Error('device deploy requires --udid <device-udid> (or GAIA_DEVICE_UDID)');
  if (!url) throw new Error('device deploy requires --url <daemon-or-bootstrap-url> (or GAIA_MOBILE_DAEMON_URL)');

  console.log(`[gaia-mobile] building for device ${udid}, GAIA_MOBILE_DAEMON_URL=${url}`);
  const buildArgs = ['exec', 'tauri', '--', 'ios', 'build', '--features', 'webkit'];
  if (debug) buildArgs.push('--debug');
  await run('npm', buildArgs, { env: { GAIA_MOBILE_DAEMON_URL: url } });

  const appMatches = globSync('src-tauri/gen/apple/build/**/Products/Applications/*.app', {
    cwd: process.cwd(),
  });
  if (appMatches.length === 0) {
    throw new Error('no .app found under src-tauri/gen/apple/build/**/Products/Applications/ after build');
  }
  // Newest archive wins if there are stale ones from prior simulator builds.
  const appPath = appMatches
    .map((p) => ({ p, mtime: statSync(p).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0].p;
  console.log(`[gaia-mobile] built app: ${appPath}`);

  console.log(`[gaia-mobile] installing on device ${udid}`);
  await run('xcrun', ['devicectl', 'device', 'install', 'app', '--device', udid, appPath]);

  if (launch) {
    console.log(`[gaia-mobile] launching ${BUNDLE_ID} on device ${udid}`);
    await run('xcrun', ['devicectl', 'device', 'process', 'launch', '--device', udid, BUNDLE_ID]);
  }
}

async function main() {
  const parsed = parse(process.argv.slice(2));
  const { cmd } = parsed;

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return usage();
  if (cmd === 'device') return runDeviceDeploy(parsed);

  const { host, device, passthrough, simulator } = parsed;
  const port = DEFAULT_PORT;
  const url = `http://${host}:${port}/`;

  if (cmd === 'url') {
    console.log(url);
    return;
  }
  if (cmd !== 'ios-dev' && cmd !== 'ios-open') throw new Error(`Unknown command: ${cmd}`);

  console.log(`[gaia-mobile] daemon URL for iOS: ${url}${simulator ? ' (simulator loopback)' : ''}`);
  const daemon = await ensureDaemon(host, port);
  const tauri = runTauriIos(cmd === 'ios-open' ? 'open' : 'dev', host, url, device, passthrough);

  const stopDaemon = () => {
    if (daemon && !daemon.killed) daemon.kill('SIGTERM');
  };
  process.on('SIGINT', () => { tauri.kill('SIGINT'); stopDaemon(); });
  process.on('SIGTERM', () => { tauri.kill('SIGTERM'); stopDaemon(); });
  tauri.on('exit', (code, signal) => {
    stopDaemon();
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(`[gaia-mobile] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
