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
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

const DEFAULT_PORT: u16 = 8787;

/// Monotonic label source for spawned windows (`win-1`, `win-2`, …). The initial
/// window is always `main`; every window opened at runtime gets a fresh label.
static WINDOW_SEQ: AtomicU32 = AtomicU32::new(1);

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

/// Build the URL for a spawned window: the same localhost UI the main window
/// loads, plus a launch hash the web app reads to decide its role.
///   `#gaia?mode=torn&room=<id>`  — a torn-off chat (side panels start collapsed)
///   `#gaia?mode=new`             — a fresh full window (panels normal)
/// The hash is client-only (never sent to the daemon), so the web-serving
/// contract is untouched. Room ids are restricted to [A-Za-z0-9._-] by the
/// daemon, so no percent-encoding is required.
fn window_url(mode: &str, room: Option<&str>) -> Result<tauri::Url, String> {
    let base = resolve_url();
    let mut hash = format!("#gaia?mode={mode}");
    if let Some(r) = room {
        if !r.is_empty() {
            hash.push_str("&room=");
            hash.push_str(r);
        }
    }
    format!("{base}{hash}")
        .parse()
        .map_err(|e| format!("bad window url: {e}"))
}

/// Open a native GAIA window pointed at the running daemon.
/// `mode` is "torn" (a chat dragged out — smaller, side panels collapsed) or
/// "new" (Cmd/Ctrl+N — a standard window). `x`/`y`, when given, place the window
/// at that screen point (the tear-off drop location).
#[tauri::command]
fn open_window(
    app: tauri::AppHandle,
    mode: String,
    room: Option<String>,
    x: Option<f64>,
    y: Option<f64>,
) -> Result<String, String> {
    let label = format!("win-{}", WINDOW_SEQ.fetch_add(1, Ordering::Relaxed));
    let url = window_url(&mode, room.as_deref())?;
    let (w, h) = if mode == "torn" {
        (860.0, 760.0)
    } else {
        (1180.0, 820.0)
    };
    let mut builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url))
        .title("GAIA")
        .inner_size(w, h)
        .min_inner_size(560.0, 420.0)
        // Required so the web UI's HTML5 drag-and-drop (tab reorder + tear-off)
        // fires: with Tauri's OS drag-drop handler on, the webview swallows it.
        .disable_drag_drop_handler()
        .resizable(true);
    if let (Some(px), Some(py)) = (x, y) {
        builder = builder.position(px, py);
    }
    builder.build().map_err(|e| e.to_string())?;
    Ok(label)
}

/// Re-dock a torn-off chat: tell the main window to re-adopt `room` as a tab,
/// focus it, and close the calling (torn) window. `window` is the caller,
/// injected by Tauri.
#[tauri::command]
fn redock(app: tauri::AppHandle, window: tauri::WebviewWindow, room: String) -> Result<(), String> {
    if let Some(main) = app.get_webview_window("main") {
        main.emit("gaia://redock", room).map_err(|e| e.to_string())?;
        let _ = main.set_focus();
    }
    // Don't close the last window out from under the user if main is gone.
    if app.get_webview_window("main").is_some() {
        let _ = window.close();
    }
    Ok(())
}

/// The currently focused GAIA window (main or a spawned one), so a menu action
/// applies to the window the user is actually looking at.
fn focused_webview(app: &tauri::AppHandle) -> Option<tauri::WebviewWindow> {
    app.webview_windows()
        .into_values()
        .find(|w| w.is_focused().unwrap_or(false))
}

/// Build the native menu and install it as the application menu. Its accelerators
/// are the standard macOS chords (CmdOrCtrl keeps them OS-agnostic). Window-level
/// actions (New/Close Window) are handled in the shell; the rest are forwarded to
/// the focused webview as `gaia://menu` so the web UI performs them. The Edit
/// submenu keeps the system copy/paste/undo working.
fn build_and_set_menu(handle: &tauri::AppHandle) -> tauri::Result<()> {
    let app_menu = SubmenuBuilder::new(handle, "GAIA")
        .about(Some(AboutMetadata::default()))
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let new_tab = MenuItemBuilder::with_id("new_tab", "New Tab")
        .accelerator("CmdOrCtrl+T")
        .build(handle)?;
    let new_window = MenuItemBuilder::with_id("new_window", "New Window")
        .accelerator("CmdOrCtrl+N")
        .build(handle)?;
    let close_tab = MenuItemBuilder::with_id("close_tab", "Close Tab")
        .accelerator("CmdOrCtrl+W")
        .build(handle)?;
    let close_window = MenuItemBuilder::with_id("close_window", "Close Window")
        .accelerator("CmdOrCtrl+Shift+W")
        .build(handle)?;
    let file_menu = SubmenuBuilder::new(handle, "File")
        .item(&new_tab)
        .item(&new_window)
        .separator()
        .item(&close_tab)
        .item(&close_window)
        .build()?;

    let edit_menu = SubmenuBuilder::new(handle, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let reload = MenuItemBuilder::with_id("reload", "Reload")
        .accelerator("CmdOrCtrl+R")
        .build(handle)?;
    let toggle_sidebar = MenuItemBuilder::with_id("toggle_sidebar", "Toggle Sessions Sidebar")
        .accelerator("CmdOrCtrl+B")
        .build(handle)?;
    let toggle_panel = MenuItemBuilder::with_id("toggle_panel", "Toggle Room Panel")
        .accelerator("CmdOrCtrl+Alt+B")
        .build(handle)?;
    let view_menu = SubmenuBuilder::new(handle, "View")
        .item(&reload)
        .separator()
        .item(&toggle_sidebar)
        .item(&toggle_panel)
        .build()?;

    let next_tab = MenuItemBuilder::with_id("next_tab", "Next Tab")
        .accelerator("CmdOrCtrl+Shift+]")
        .build(handle)?;
    let prev_tab = MenuItemBuilder::with_id("prev_tab", "Previous Tab")
        .accelerator("CmdOrCtrl+Shift+[")
        .build(handle)?;
    let dock_back = MenuItemBuilder::with_id("dock_back", "Merge to Main Window")
        .accelerator("CmdOrCtrl+Shift+M")
        .build(handle)?;
    let window_menu = SubmenuBuilder::new(handle, "Window")
        .item(&next_tab)
        .item(&prev_tab)
        .separator()
        .item(&dock_back)
        .separator()
        .minimize()
        .build()?;

    let menu = MenuBuilder::new(handle)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&window_menu)
        .build()?;
    handle.set_menu(menu)?;
    Ok(())
}

/// Route a native-menu click. New/Close Window act on native windows directly;
/// everything else is forwarded to the focused webview for the web UI to run.
fn handle_menu(app: &tauri::AppHandle, id: &str) {
    match id {
        "new_window" => {
            let _ = open_window(app.clone(), "new".to_string(), None, None, None);
        }
        "close_window" => {
            if let Some(win) = focused_webview(app) {
                let _ = win.close();
            }
        }
        "reload" => {
            // Reload natively so it works even if the web UI's JS is wedged.
            if let Some(win) = focused_webview(app) {
                let _ = win.eval("window.location.reload()");
            }
        }
        other => {
            if let Some(win) = focused_webview(app) {
                let _ = win.emit("gaia://menu", other.to_string());
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(SpawnedDaemon(Mutex::new(None)))
        .invoke_handler(tauri::generate_handler![open_window, redock])
        .on_menu_event(|app, event| handle_menu(app, event.id().0.as_str()))
        .setup(|app| {
            let port = resolve_port();
            let url = resolve_url();

            // Native menu: standard macOS chords for the window/tab chrome, plus a
            // working Edit menu (copy/paste). Best-effort — a menu failure must not
            // stop the window from opening.
            if let Err(e) = build_and_set_menu(app.handle()) {
                eprintln!("[gaia-shell] menu setup failed: {e}");
            }

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
                // See open_window: needed for the tab strip's HTML5 drag-and-drop.
                .disable_drag_drop_handler()
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
