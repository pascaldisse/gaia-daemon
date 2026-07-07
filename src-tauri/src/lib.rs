// The GAIA native shell.
//
// A thin client: it opens a native window — WKWebView on macOS, WebView2/Chromium
// on Windows, WebKitGTK on Linux — pointed at the gaia daemon's localhost UI. No
// frontend is bundled; the window loads the same http://127.0.0.1:<port>/ a
// browser would.
//
// Daemon lifecycle (attach vs. spawn):
//   * Default: ATTACH ONLY. The window loads the resolved URL; if a daemon is
//     already up (e.g. the dev/room daemon on :8787) it just renders it, exactly
//     like a browser tab — the running daemon is never touched.
//   * Opt-in: set GAIA_SHELL_AUTOSTART=1 to also SPAWN a daemon when the port is
//     dead. This is off by default precisely so the shell can never start a
//     competing daemon against one that is already serving a room.
//
// Configuration (all optional):
//   GAIA_SHELL_URL        full URL to load (wins over everything)
//   GAIA_PORT             port to build the localhost URL from (default 8787)
//   GAIA_SHELL_AUTOSTART  "1" to spawn the daemon if the port is dead
//   GAIA_SHELL_SPAWN_CMD  shell command used to start the daemon
//                         (default: "gaia", i.e. the CLI on PATH)
//
// LATER: the optional macOS Chromium enhancement (Phase 3). See
// IMPLEMENTATION-PLAN.md and webview2-re/BUILD-SPEC.md.

use std::net::{TcpStream, ToSocketAddrs};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const DEFAULT_PORT: u16 = 8787;

/// A daemon child process we spawned ourselves. Held in managed state so we can
/// kill it on exit — and ONLY if we were the ones who started it.
struct SpawnedDaemon(Mutex<Option<Child>>);

fn resolve_port() -> u16 {
    std::env::var("GAIA_PORT")
        .ok()
        .and_then(|s| s.parse::<u16>().ok())
        .filter(|p| *p != 0)
        .unwrap_or(DEFAULT_PORT)
}

fn resolve_url() -> String {
    if let Ok(url) = std::env::var("GAIA_SHELL_URL") {
        if !url.trim().is_empty() {
            return url;
        }
    }
    format!("http://127.0.0.1:{}/", resolve_port())
}

/// Is something accepting TCP connections on 127.0.0.1:port?
fn port_alive(port: u16) -> bool {
    let addr = match ("127.0.0.1", port).to_socket_addrs() {
        Ok(mut it) => match it.next() {
            Some(a) => a,
            None => return false,
        },
        Err(_) => return false,
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

/// Opt-in: spawn the gaia daemon if the port is dead. Returns the child if we
/// started one, so the caller can register it for cleanup. Never spawns unless
/// GAIA_SHELL_AUTOSTART=1, and never spawns if the port is already alive.
fn maybe_spawn_daemon(port: u16) -> Option<Child> {
    if std::env::var("GAIA_SHELL_AUTOSTART").as_deref() != Ok("1") {
        return None;
    }
    if port_alive(port) {
        // A daemon is already up — attach, do not compete with it.
        return None;
    }

    let cmd = std::env::var("GAIA_SHELL_SPAWN_CMD").unwrap_or_else(|_| "gaia".to_string());
    eprintln!("[gaia-shell] :{port} is dead; GAIA_SHELL_AUTOSTART=1 -> spawning `{cmd}`");

    let child = Command::new("sh")
        .arg("-c")
        .arg(&cmd)
        .env("GAIA_PORT", port.to_string())
        .spawn();

    let child = match child {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[gaia-shell] failed to spawn daemon: {e}");
            return None;
        }
    };

    // Wait (up to ~20s) for the daemon to start listening.
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if port_alive(port) {
            eprintln!("[gaia-shell] daemon is up on :{port}");
            return Some(child);
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    eprintln!("[gaia-shell] daemon did not come up within timeout; loading anyway");
    Some(child)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SpawnedDaemon(Mutex::new(None)))
        .setup(|app| {
            let port = resolve_port();
            let url = resolve_url();

            // Opt-in daemon spawn (off by default -> pure attach).
            if let Some(child) = maybe_spawn_daemon(port) {
                if let Some(state) = app.try_state::<SpawnedDaemon>() {
                    *state.0.lock().unwrap() = Some(child);
                }
            }

            let external: tauri::Url = url
                .parse()
                .unwrap_or_else(|e| panic!("invalid GAIA shell URL `{url}`: {e}"));

            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(external))
                .title("GAIA")
                .inner_size(1180.0, 820.0)
                .min_inner_size(720.0, 480.0)
                .resizable(true)
                .build()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building the GAIA shell")
        .run(|app, event| {
            // On exit, tear down ONLY a daemon we spawned ourselves.
            if let tauri::RunEvent::ExitRequested { .. } = event {
                if let Some(state) = app.try_state::<SpawnedDaemon>() {
                    if let Some(mut child) = state.0.lock().unwrap().take() {
                        let _ = child.kill();
                        eprintln!("[gaia-shell] stopped the daemon we spawned");
                    }
                }
            }
        });
}
