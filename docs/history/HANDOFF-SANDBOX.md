> ⚠️ **HARNESS ABSTRACTION — ABSOLUTE RULE (see [AGENTS.md](AGENTS.md) §RULE #0).** pi/claude/codex are interchangeable harnesses behind ONE abstraction. Implement every capability ONCE at the abstraction layer (harness registry / RunnerHost / runner) so it applies to ALL harnesses — present, unimplemented, and future. NEVER special-case a harness, NEVER `if (harness === "pi")` in shared code, NEVER touch the thing underneath. A harness may ONLY declare its own wiring as DATA on its spec.

# HANDOFF — Sandbox: drop apple-container, seatbelt-only, gaia↔pi dedup

Status: 2026-06-25, branch `feat/sandbox-seatbelt-dedup` (off `main`).

## What changed and why

Apple `container` (the Linux-VM backend) is **dropped from gaia entirely and
uninstalled from the machine**. Reasons:

- It was never self-contained: internet-from-VM silently depended on host
  `sysctl net.inet.ip.forwarding=1` + a pfctl NAT rule (configured by nanoclaw,
  not by us). The earlier "DeepSeek works inside the VM" proof was riding on that
  host config, so it would not reproduce on a clean machine.
- Warts vs nanoclaw's mature container path: Apple Container only bind-mounts
  directories (not single files), no privilege drop, weaker secret model (the key
  is forwarded into the guest), and orphan-reaping gaps.
- The premise that justified it — "Seatbelt is deprecated, we need a VM for the
  future" — is false. `sandbox-exec` is Seatbelt; it is not deprecated in any way
  that matters (Chrome depends on it).
- Disk: the VM images cost ~30 GB.

gaia now stands on **macOS Seatbelt** as its only real backend. Off darwin an
untrusted turn **fail-closes** (never runs naked) — acceptable for a macOS-first
tool. The swappable-backend registry stays (the seam for a future docker/Linux
backend); only the apple-container backend was removed.

## Posture (seatbelt) — `src/runtime/sandbox/macos-seatbelt.ts`

- **WRITES — allowlist (Option B):** deny-all, then allow the workspace (cwd,
  unless `cwdWritable:false`) + temp + regenerable caches; then re-deny the policy
  files + `~/.pi/agent/auth.json`. (Unchanged blast-radius control.)
- **READS — denylist (Option A, NEW):** deny a sensitive set (SSH / AWS / gcloud /
  gh / 1Password / kube / docker / netrc / npmrc / pypirc / Keychains /
  ~/Documents / ~/Desktop / ~/Downloads), then re-allow the workspace + GAIA_HOME
  on top. Callers extend via `spec.denyRead`.
- **Residual, named:** cannot hide the turn's OWN provider key (it is in env by
  necessity — see deferred item). Other projects under `~` stay readable by
  default because runtimes/installs live there and a blanket deny breaks module
  resolution; tighten case-by-case with `--deny-read`.

## Dedup — one source of truth — `gaia __sandbox-exec`

```
gaia __sandbox-exec --backend <id> --cwd <dir> [--writable <dir>]…
     [--deny-read <dir>]… [--net full|none] [--readonly-cwd] -- <cmd> [args…]
```

Builds the launch with the SAME `resolveSandboxLaunch` the daemon uses, then
execs it. Fail-closed if the backend is unavailable (refuses to run the child).
The pi skill's launcher (`~/projects/pi-agent/pi-agent.mjs`) calls this for its
seatbelt path instead of rolling its own SBPL profile, so both gaia summons and
pi get the identical posture (incl. the read-denylist) from one place.
`--readonly-cwd` expresses pi's "repo read-only, scratch read-write" model
(`cwdWritable:false`).

## DEFERRED — credential-proxy model (do NOT implement yet)

Today the provider API key is forwarded into the agent's env, so the agent can
read its own key; Seatbelt cannot hide it. nanoclaw avoids this with a
**credential proxy**: a host-side process holds the real key, the agent talks to
the proxy over localhost, and the proxy injects auth — the raw key never enters
the sandbox. To adopt later:

1. Stand up a small loopback proxy that forwards to the provider, injecting the
   real key host-side; mint a per-turn token.
2. Point the harness base URL at the proxy; strip the real key from the child env.
3. Scope the token to the turn; bind to loopback (or, for any future VM backend,
   the gateway behind a pf rule like nanoclaw's).

This closes the last exfil gap (the turn's own key). Tracked here; not built.

## Status

- [x] gaia: apple-container backend removed from main; bridge `ok:true` hardening kept
- [x] gaia: read-denylist + write-allowlist; `cwdWritable`; `gaia __sandbox-exec`
- [x] gaia: build clean + 227 tests green; live confinement proven via
      `__sandbox-exec` (write-confine + read-deny defaults + `--deny-read` +
      fail-closed). The daemon runner uses the same `resolveSandboxLaunch`.
- [ ] pi: seatbelt-default via `gaia __sandbox-exec`; apple-container path removed
- [ ] system: `container` uninstalled (brew), services stopped, data purged
- [ ] README + memory updated
- [ ] credential-proxy: DEFERRED (above)
