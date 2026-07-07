#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const tauriDir = join(root, 'src-tauri');
const engine = (process.env.GAIA_ENGINE || 'webkit').toLowerCase();
const cmd = process.argv[2] || 'dev';

if (!['webkit', 'cef'].includes(engine)) {
  console.error(`GAIA_ENGINE must be webkit or cef, got ${engine}`);
  process.exit(2);
}

const run = (program, args, opts = {}) => {
  console.log(`$ ${program} ${args.join(' ')}`);
  const res = spawnSync(program, args, {
    cwd: opts.cwd || tauriDir,
    stdio: 'inherit',
    env: { ...process.env, ...(opts.env || {}) },
  });
  if (res.status !== 0) process.exit(res.status ?? 1);
};

const cefEnv = () => {
  const cefPath = process.env.CEF_PATH || join(homedir(), '.local/share/cef');
  const libraries = `${cefPath}:${join(cefPath, 'Chromium Embedded Framework.framework/Libraries')}`;
  return {
    CEF_PATH: cefPath,
    DYLD_FALLBACK_LIBRARY_PATH: process.env.DYLD_FALLBACK_LIBRARY_PATH
      ? `${libraries}:${process.env.DYLD_FALLBACK_LIBRARY_PATH}`
      : libraries,
  };
};

const webkitCargo = (release = false) => ['build', ...(release ? ['--release'] : [])];
const cefCargo = (release = false, bins = []) => [
  'build',
  '--no-default-features',
  '--features',
  'cef',
  ...bins.flatMap((b) => ['--bin', b]),
  ...(release ? ['--release'] : []),
];

if (engine === 'webkit') {
  if (cmd === 'dev') run('cargo', ['run']);
  else if (cmd === 'build') run('cargo', webkitCargo(true));
  else if (cmd === 'bundle') {
    run('cargo', webkitCargo(true));
    run('bash', ['scripts/make-app.sh', 'release', 'target/engine-bundles/GAIA-webkit.app']);
  } else {
    console.error(`unknown command: ${cmd}`);
    process.exit(2);
  }
} else {
  const env = cefEnv();
  if (!existsSync(env.CEF_PATH)) {
    console.error(`CEF_PATH does not exist: ${env.CEF_PATH}`);
    console.error('Install CEF first, e.g. from cef-rs export-cef-dir, or set CEF_PATH.');
    process.exit(2);
  }
  if (cmd === 'dev') {
    run('cargo', cefCargo(false, ['gaia-shell', 'gaia-cef-helper']), { env });
    run('cargo', ['run', '--no-default-features', '--features', 'cef', '--bin', 'gaia-cef-bundle', '--', '--profile', 'debug', '--output', 'target/engine-bundles/cef-debug'], { env });
    run('open', ['-n', 'target/engine-bundles/cef-debug/gaia-shell.app'], { cwd: tauriDir, env });
  } else if (cmd === 'build') {
    run('cargo', cefCargo(true, ['gaia-shell', 'gaia-cef-helper']), { env });
  } else if (cmd === 'bundle') {
    run('cargo', cefCargo(true, ['gaia-shell', 'gaia-cef-helper']), { env });
    run('cargo', ['run', '--no-default-features', '--features', 'cef', '--bin', 'gaia-cef-bundle', '--', '--profile', 'release', '--output', 'target/engine-bundles/cef-release'], { env });
  } else {
    console.error(`unknown command: ${cmd}`);
    process.exit(2);
  }
}
