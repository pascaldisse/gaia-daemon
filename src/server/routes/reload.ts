import { existsSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleSwapNames } from "../../core/bundle-assets.js";
import { gaiaCodesignIdentity } from "../../core/config.js";
import { gaiaHome } from "../../core/paths.js";
import { findAppBundleRoot } from "../route.js";
const RELOAD_DELAY_MS = 250;
const RELOAD_CLOSE_TIMEOUT_MS = 1_000;
let reloadStarted = false;
export function requestReload(close: () => Promise<void>): void {
  if (reloadStarted) return;
  reloadStarted = true;
  console.log(`[gaia] ${new Date().toISOString()} reload requested via /reload — re-exec in ${RELOAD_DELAY_MS}ms (pid ${process.pid})`);
  setTimeout(() => { void reloadNow(close); }, RELOAD_DELAY_MS);
}
async function reloadNow(close: () => Promise<void>): Promise<void> {
    try {
      // Bounded graceful close (see RELOAD_CLOSE_TIMEOUT_MS): a hung or failed
      // dispose must never block the re-exec. process.exit(0) below frees the
      // port either way, and the next boot's orphan sweep (daemon.serviceFor
      // invariant) reaps any runner subprocess a skipped dispose left behind.
      if (true) {
        const closed = close().then(
          () => "closed" as const,
          (error) => {
            console.error(`[gaia] reload: graceful close failed: ${error instanceof Error ? error.message : String(error)} — proceeding with re-exec`);
            return "failed" as const;
          },
        );
        const deadline = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), RELOAD_CLOSE_TIMEOUT_MS).unref());
        if ((await Promise.race([closed, deadline])) === "timeout") {
          console.error(`[gaia] reload: graceful close still pending after ${RELOAD_CLOSE_TIMEOUT_MS}ms — proceeding with re-exec (pid ${process.pid})`);
        }
      }
      const reloadLog = openSync(join(gaiaHome(), "reload.log"), "a");

      // A reload doesn't just re-exec the running process — when a build
      // recipe is reachable it rebuilds first, so a source checkout picks up
      // the code that triggered the reload, and a compiled install picks up
      // a fresh binary. Two ways to find that recipe: running from source
      // (this file's own repo has scripts/build-daemon.mjs), or running a
      // compiled binary that was built alongside a gaia-source.json pointing
      // back at the source repo that built it.
      const repoRootFromSource = fileURLToPath(new URL("../..", import.meta.url));
      const fromSourceScript = join(repoRootFromSource, "scripts/build-daemon.mjs");
      let plan: { script: string; out: string; bun: string } | undefined;
      let fromSource = false;
      if (existsSync(fromSourceScript)) {
        fromSource = true;
        // process.execPath, not the bare "bun" name: this process IS bun
        // running src/cli.ts (package.json's "start": "bun src/cli.ts"), so
        // its own execPath is a guaranteed-correct absolute path. A bare
        // "bun" instead depends on PATH containing bun's install dir, which
        // a GUI-launched app's stripped LaunchServices PATH does not always
        // have — silent, output-less spawnSync failure observed live 2026-07-11.
        plan = { script: fromSourceScript, out: join(repoRootFromSource, "dist"), bun: process.execPath };
      } else {
        const sourceJsonPath = join(dirname(process.execPath), "gaia-source.json");
        if (existsSync(sourceJsonPath)) {
          try {
            const parsed = JSON.parse(readFileSync(sourceJsonPath, "utf8")) as { root: string; bun: string };
            const script = join(parsed.root, "scripts/build-daemon.mjs");
            if (existsSync(script)) plan = { script, out: dirname(process.execPath), bun: parsed.bun };
          } catch (error) {
            console.error(`gaia: failed to read gaia-source.json: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }

      let rebuildOk = false;
      const stagingDir = plan ? `${plan.out}.staging-${Date.now()}` : undefined;
      if (plan && stagingDir) {
        try {
          // Build into a staging directory, OUTSIDE the .app bundle (if bundled).
          // This keeps the app's code signature intact during the build.
          await mkdir(stagingDir, { recursive: true });
          const build = spawnSync(plan.bun, [plan.script, "--out", stagingDir], {
            stdio: ["ignore", reloadLog, reloadLog],
            timeout: 120_000,
          });
          if (build.status === 0) {
            // Build succeeded. Atomically swap the snapshotted asset dirs
            // (BUNDLE_ASSET_DIRS: web/, setups/, design/) from staging
            // into plan.out. This is atomic from TCC's perspective — it never
            // sees the bundle in an inconsistent state.
            //
            // A packaged (!fromSource) install ALSO swaps the compiled
            // `gaia-daemon` binary + `gaia-source.json` — otherwise the app
            // rebuilds a fresh binary into staging on every /rebuild and then
            // discards it, re-execing the SAME OLD BINARY forever (daemon
            // code changes never take effect on a compiled install). Renaming
            // the running binary aside then moving the new one into its path
            // is a plain POSIX rename — never a write into the open inode —
            // so it never hits ETXTBSY, and the process currently executing
            // out of the old (now unlinked-from-the-directory) inode keeps
            // running fine until it re-execs below. The from-source (tsx) dev
            // flow is untouched: only the asset dirs swap, exactly as before.
            const names = bundleSwapNames(fromSource);
            for (const name of names) {
              const src = join(stagingDir, name);
              const dst = join(plan.out, name);
              const tmp = `${dst}.old-${Date.now()}`;
              try {
                // Move current (if exists) to .old, then move staging into place.
                // This is as atomic as POSIX rename gets.
                if (existsSync(dst)) await rename(dst, tmp);
                await rename(src, dst);
              } catch (error) {
                writeSync(reloadLog, `[gaia] reload: atomic swap FAILED for ${name}: ${error instanceof Error ? error.message : String(error)}\n`);
                throw error;
              }
              // Clean up the .old backup, best-effort. `gaia-daemon.old-*`
              // may still be the inode THIS process is executing out of —
              // some filesystems refuse to unlink an in-use executable.
              // That must never fail the reload; the swap itself (the
              // renames above) already succeeded.
              if (existsSync(tmp)) {
                try {
                  rmSync(tmp, { recursive: true, force: true });
                } catch (error) {
                  writeSync(reloadLog, `[gaia] reload: cleanup of stale ${tmp} failed (tolerated): ${error instanceof Error ? error.message : String(error)}\n`);
                }
              }
            }
            rebuildOk = true;
          } else {
            writeSync(reloadLog, "[gaia] reload rebuild FAILED — relaunching previous build\n");
          }
        } finally {
          // Clean up staging directory.
          if (existsSync(stagingDir)) rmSync(stagingDir, { recursive: true, force: true });
        }
      }

      // After atomic swap, re-sign the bundle (macOS only). Code signature is
      // only broken momentarily if a rename fails; normal case is fully safe.
      if (rebuildOk && plan && !fromSource && process.platform === "darwin") {
        const appRoot = findAppBundleRoot(plan.out);
        if (appRoot) {
          const parsed = (() => {
            try {
              return JSON.parse(readFileSync(join(dirname(process.execPath), "gaia-source.json"), "utf8")) as { root: string };
            } catch {
              return undefined;
            }
          })();
          const entitlements = parsed ? join(parsed.root, "src-tauri/Entitlements.plist") : undefined;
          // Prefer a stable named identity over ad-hoc ("-") signing: ad-hoc
          // keys the TCC designated requirement to the binary's cdhash, which
          // changes on every rebuild and orphans every mic/camera grant. A
          // named identity keys it to the certificate leaf instead, which
          // stays stable across rebuilds. Fall back to ad-hoc only when the
          // configured identity isn't actually present in the keychain.
          const wantIdentity = gaiaCodesignIdentity();
          const probe = spawnSync("security", ["find-identity", "-v", "-p", "codesigning"], { encoding: "utf8" });
          const identity = probe.status === 0 && probe.stdout.includes(`"${wantIdentity}"`) ? wantIdentity : "-";
          if (identity === "-" && wantIdentity !== "-") {
            writeSync(reloadLog, `[gaia] reload: codesign identity "${wantIdentity}" not found in keychain — falling back to ad-hoc (TCC grants will be orphaned)\n`);
          }
          const codesignArgs = ["--force", "--deep", "--sign", identity];
          if (entitlements && existsSync(entitlements)) codesignArgs.push("--entitlements", entitlements);
          codesignArgs.push(appRoot);
          const sign = spawnSync("codesign", codesignArgs, { stdio: ["ignore", reloadLog, reloadLog] });
          if (sign.status === 0) {
            writeSync(reloadLog, `[gaia] reload: re-signed ${appRoot} after rebuild\n`);
          } else {
            writeSync(reloadLog, `[gaia] reload: codesign FAILED (status ${sign.status}) — mic/camera permission will likely break until fixed\n`);
          }
        } else {
          writeSync(reloadLog, `[gaia] reload: installed binary not inside a .app bundle — skipping re-sign\n`);
        }
      }

      // Re-exec. tsx's --require/--import live in process.execArgv, NOT
      // process.argv — without them a source re-exec is plain `node
      // src/cli.ts`, which dies instantly and leaves the port dead (the
      // exact "/reload froze the app" failure). And never stdio:"ignore"
      // here: a crashing reload child must leave a corpse we can read.
      // In a compiled bun binary argv[1] is the virtual "/$bunfs/..." entry
      // script (verified 2026-07-11) — it must never be passed to the child,
      // where the CLI would parse it as a command.
      const args = process.argv
        .slice(1)
        .filter((arg) => arg !== "--dev" && !arg.startsWith("/$bunfs") && !arg.includes("~BUN"));
      // When the child is the COMPILED binary, argv[1] of a source run
      // ("src/cli.ts") must be dropped too — the binary would parse the
      // script path as a CLI command and print --help instead of booting
      // (observed live 2026-07-11 14:01: reload went dark). Flags only.
      const flagsOnly = process.argv
        .slice(2)
        .filter((arg) => arg !== "--dev" && !arg.startsWith("/$bunfs") && !arg.includes("~BUN"));
      const compiledBinary = plan ? join(plan.out, "gaia-daemon") : undefined;
      // Not gated on `fromSource`: a packaged (!fromSource) install now
      // installs its freshly-built binary into plan.out above, so
      // compiledBinary IS the new build there too — re-exec it the same way
      // a source checkout re-execs onto a pre-existing dist/gaia-daemon.
      // From-source dev behavior is unchanged: it only ever finds a compiled
      // binary here if one was separately built into dist/ (e.g. `bun run
      // build`), exactly as before.
      const migrateToCompiled = rebuildOk && compiledBinary !== undefined && existsSync(compiledBinary);

      // gaia never sets ANTHROPIC_BASE_URL on its OWN process env — the only
      // writer is the per-turn thinking-proxy shim, which sets it on a spawned
      // CHILD's env object, not here. Any value present in process.env at
      // rebuild time is therefore foreign pollution inherited from whatever
      // launched the app (a stale `launchctl setenv`, a dead local proxy from
      // an old terminal session, ...) — self-contained means /rebuild must not
      // carry it forward forever. Strip it; a user who genuinely wants a
      // custom gateway sets it fresh at launch, not implicitly via reload.
      const { ANTHROPIC_BASE_URL: _droppedGateway, ...childEnv } = process.env;

      const child = migrateToCompiled
        ? spawn(compiledBinary, flagsOnly, {
            detached: true,
            stdio: ["ignore", reloadLog, reloadLog],
            cwd: process.cwd(),
            env: childEnv,
          })
        : spawn(process.execPath, [...process.execArgv, ...args], {
            detached: true,
            stdio: ["ignore", reloadLog, reloadLog],
            cwd: process.cwd(),
            env: childEnv,
          });
      console.log(`[gaia] reload exec: ${migrateToCompiled ? compiledBinary : process.execPath}`);
      child.unref();
      process.exit(0);
    } catch (error) {
      console.error(`gaia: reload failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  }
