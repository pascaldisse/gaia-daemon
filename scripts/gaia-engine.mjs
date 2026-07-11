#!/usr/bin/env bun
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const tauriDir = join(root, 'src-tauri');
const cmd = process.argv[2] || 'dev';

const run = (program, args, opts = {}) => {
  console.log(`$ ${program} ${args.join(' ')}`);
  const res = spawnSync(program, args, {
    cwd: opts.cwd || tauriDir,
    stdio: 'inherit',
    env: { ...process.env, ...(opts.env || {}) },
  });
  if (res.status !== 0) process.exit(res.status ?? 1);
};

const webkitCargo = (release = false) => ['build', ...(release ? ['--release'] : [])];

if (cmd === 'dev') run('cargo', ['run']);
else if (cmd === 'build') run('cargo', webkitCargo(true));
else if (cmd === 'bundle') {
  run('cargo', webkitCargo(true));
  run('bash', ['scripts/make-app.sh', 'release', 'target/engine-bundles/GAIA-webkit.app']);
} else {
  console.error(`unknown command: ${cmd}`);
  process.exit(2);
}
