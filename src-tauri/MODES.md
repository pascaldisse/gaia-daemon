# GAIA shell engine modes

This worktree builds one native shell codebase in two mutually-exclusive compile-time modes.
Do not make this a runtime toggle: the WebKit build must stay small and must not link/bundle CEF.

## Modes

### `webkit` (default)

- Feature: `webkit`
- Command selection: default Cargo features, or `GAIA_ENGINE=webkit`
- Engine: Tauri v2 default runtime (`wry` / WKWebView on macOS)
- Purpose: small macOS app and the iOS-compatible path
- Chromium/CEF: not linked; not bundled

Commands:

```sh
# Check/build the small WebKit app
cd src-tauri
cargo check
cargo build --release

# Friendly wrapper from repo root
npm run tauri:dev
npm run tauri:build
npm run tauri:bundle:scratch
```

The WebKit app remains attach-only by default. It loads `GAIA_SHELL_URL` if set, otherwise
`http://127.0.0.1:${GAIA_PORT:-8787}/`. It does not start/stop the daemon unless the existing
`GAIA_SHELL_AUTOSTART=1` opt-in is set.

### `cef`

- Feature: `cef`
- Command selection: `--no-default-features --features cef`, or `GAIA_ENGINE=cef`
- Engine: bundled Chromium Embedded Framework through `tauri-apps/cef-rs`
- Purpose: Chromium rendering plus DevTools/CDP on macOS/Linux
- CDP: `GAIA_CEF_REMOTE_DEBUGGING_PORT` (default `9333`), e.g. `http://127.0.0.1:9333/`

Commands:

```sh
# Requires a CEF install; this machine already has ~/.local/share/cef
export CEF_PATH="$HOME/.local/share/cef"
export DYLD_FALLBACK_LIBRARY_PATH="$CEF_PATH:$CEF_PATH/Chromium Embedded Framework.framework/Libraries:${DYLD_FALLBACK_LIBRARY_PATH:-}"

cd src-tauri
cargo check --no-default-features --features cef
cargo build --release --no-default-features --features cef --bin gaia-shell --bin gaia-cef-helper

# Friendly wrapper from repo root
GAIA_ENGINE=cef npm run tauri:dev
GAIA_ENGINE=cef npm run tauri:build
GAIA_ENGINE=cef npm run tauri:bundle:scratch
# or explicit aliases:
npm run tauri:dev:cef
npm run tauri:build:cef
npm run tauri:bundle:scratch:cef
```

The CEF bundle wrapper creates scratch bundles under `src-tauri/target/engine-bundles/` and opens a
new process/window for `dev`; it does not start/stop/navigate the daemon. The current macOS
standalone CEF path has been validated to expose CDP at `/json/version` on the configured port.

## Current cef-rs/Tauri bridge gap

`tauri-apps/cef-rs` provides the CEF Rust bindings and bundling utilities, but not yet a drop-in
Tauri runtime/webview backend. The upstream tracking issue for WRY/Tauri-compatible adapters is:

- https://github.com/tauri-apps/cef-rs/issues/208

Because that bridge is incomplete, this worktree honestly implements the `cef` feature path as a
minimal cef-rs Chromium window in the same Cargo package rather than pretending it is a full Tauri
runtime swap. It renders the GAIA daemon URL and exposes CDP, but it does not yet provide the full
Tauri command/menu/window runtime. The WebKit path remains the real Tauri shell; the CEF path is the
Chromium/CDP proof path until cef-rs exposes a Tauri-compatible runtime layer.

CEF setup and bundling follow the upstream cef-rs README:

- https://github.com/tauri-apps/cef-rs
