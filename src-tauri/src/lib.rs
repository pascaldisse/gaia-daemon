// The GAIA native shell.
//
// PHASE 1 (this file): a thin client. It opens a native window — WKWebView on
// macOS, WebView2/Chromium on Windows, WebKitGTK on Linux — pointed at the
// already-running gaia daemon's localhost UI (http://127.0.0.1:8787/). No
// frontend is bundled and NO daemon is spawned here yet: the window loads the
// exact same URL a browser would, so the daemon serving the current room is
// never touched.
//
// LATER: daemon lifecycle (attach-if-live, else spawn as a sidecar), a runtime
// port probe, and the optional macOS Chromium enhancement (Phase 3). See
// IMPLEMENTATION-PLAN.md and webview2-re/BUILD-SPEC.md.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|_app| Ok(()))
        .run(tauri::generate_context!())
        .expect("error while running the GAIA shell");
}
