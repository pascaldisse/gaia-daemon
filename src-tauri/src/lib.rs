mod daemon_lifecycle;

#[cfg(feature = "webkit")]
mod debug_server;

#[cfg(feature = "webkit")]
mod webkit {
    // The GAIA native shell.
    //
    // A thin client: it opens a native window — WKWebView on macOS, WebView2/Chromium
    // on Windows, WebKitGTK on Linux — pointed at the gaia daemon's localhost UI. No
    // frontend is bundled; the window loads the same http://127.0.0.1:<port>/ a
    // browser would.
    //
    // Daemon lifecycle (owned):
    //   * Default: the app OWNS :8787. On launch, anything serving it is killed,
    //     then a fresh daemon is spawned as an owned child (`npm run dev` from the
    //     source tree). GAIA_PARENT_PID lets the daemon suicide if the shell dies.
    //     On quit, the whole daemon process tree dies.
    //   * Dev-only opt-out: set GAIA_SHELL_AUTOSTART=0 (or false/off) for pure
    //     attach mode when a developer deliberately runs the daemon by hand.
    //
    // Configuration (all optional):
    //   GAIA_SHELL_URL        full URL to load (wins over everything)
    //   GAIA_PORT             port to build the localhost URL from (default 8787)
    //   GAIA_SHELL_AUTOSTART  "0" to disable spawning (default: spawn when dead)
    //   GAIA_SHELL_SPAWN_CMD  shell command used to start the daemon
    //                         (default: "npm run dev")
    //   GAIA_SHELL_SPAWN_DIR  cwd for the spawn (default: the source tree this
    //                         binary was built in)
    //
    // LATER: the optional macOS Chromium enhancement (Phase 3). See
    // IMPLEMENTATION-PLAN.md and webview2-re/BUILD-SPEC.md.

    use serde::{Deserialize, Serialize};
    use std::collections::HashMap;
    use std::hash::{DefaultHasher, Hash, Hasher};
    use std::process::Child;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::Mutex;
    #[cfg(desktop)]
    use tauri::menu::{AboutMetadata, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
    use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};
    use tauri_plugin_notification::NotificationExt;

    const DEFAULT_PORT: u16 = 8787;

    // macOS WKWebView microphone/camera capture: wry's WKUIDelegate denies
    // getUserMedia by default, so dictation/voice fails in the native app even
    // though it works in a browser. Patch the delegate's media-capture callback in
    // place to grant loopback origins (the daemon UI), keeping all other delegate
    // methods intact. Paired with NSMicrophoneUsageDescription + the audio-input
    // entitlement (see Info.plist / Entitlements.plist).
    // iOS WKWebView layout viewport: wry 0.55.1 never sets
    // WKWebView.scrollView.contentInsetAdjustmentBehavior, so UIKit leaves it at
    // .automatic. Even with viewport-fit=cover in the page's viewport meta, that
    // default shrinks the layout viewport by the safe-area insets (e.g. 728pt
    // instead of the true 812pt on an iPhone 13 mini), leaving a dead band of
    // page background below the composer. Force .never so JS gets the real
    // device height; the CSS already adds env(safe-area-inset-*) padding back.
    #[cfg(target_os = "ios")]
    mod ios_scroll_insets {
        use objc2::msg_send;
        use objc2::runtime::AnyObject;

        /// UIScrollView.ContentInsetAdjustmentBehavior.never
        const CONTENT_INSET_ADJUSTMENT_NEVER: i64 = 2;

        pub fn disable_content_inset_adjustment(wk_webview: *mut std::ffi::c_void) {
            if wk_webview.is_null() {
                eprintln!("[gaia-shell] iOS scroll-inset hook skipped: null WKWebView");
                return;
            }

            unsafe {
                let webview = wk_webview.cast::<AnyObject>();
                let scroll_view: *mut AnyObject = msg_send![&*webview, scrollView];
                if scroll_view.is_null() {
                    eprintln!("[gaia-shell] iOS scroll-inset hook skipped: no scrollView");
                    return;
                }

                let _: () = msg_send![
                    &*scroll_view,
                    setContentInsetAdjustmentBehavior: CONTENT_INSET_ADJUSTMENT_NEVER
                ];
                eprintln!("[gaia-shell] set UIScrollView.contentInsetAdjustmentBehavior = .never");
            }
        }
    }

    #[cfg(target_os = "ios")]
    fn install_ios_scroll_inset_fix(window: &tauri::WebviewWindow) {
        if let Err(e) = window.with_webview(|webview| {
            ios_scroll_insets::disable_content_inset_adjustment(webview.inner());
        }) {
            eprintln!("[gaia-shell] failed to access WKWebView for scroll-inset fix: {e}");
        }
    }

    #[cfg(not(target_os = "ios"))]
    fn install_ios_scroll_inset_fix(_window: &tauri::WebviewWindow) {}

    /// Monotonic label source for spawned windows (`win-1`, `win-2`, …). The initial
    /// window is always `main`; every window opened at runtime gets a fresh label.
    static WINDOW_SEQ: AtomicU32 = AtomicU32::new(1);

    /// A daemon child process we spawned ourselves. Held in managed state so we can
    /// kill it on exit — and ONLY if we were the ones who started it.
    struct SpawnedDaemon(Mutex<Option<Child>>);

    #[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
    #[serde(rename_all = "camelCase")]
    struct PetBinding {
        workspace_id: String,
        room_id: String,
        agent_id: String,
        package: String,
    }

    #[derive(Clone, Debug, Deserialize, Serialize)]
    #[serde(rename_all = "camelCase")]
    struct PetProgress {
        workspace_id: String,
        room_id: String,
        agent_id: String,
        task_id: String,
        status: String,
        tool_name: Option<String>,
    }

    /// Native pet label -> durable binding. The package participates in the
    /// label hash, so replacing a package closes/recreates exactly one window.
    struct PetWindows(Mutex<HashMap<String, PetBinding>>);

    fn resolve_port() -> u16 {
        std::env::var("GAIA_PORT")
            .ok()
            .and_then(|s| s.parse::<u16>().ok())
            .filter(|p| *p != 0)
            .unwrap_or(DEFAULT_PORT)
    }

    fn env_url(name: &str) -> Option<String> {
        std::env::var(name).ok().and_then(|url| {
            let trimmed = url.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed.to_string())
            }
        })
    }

    #[cfg(mobile)]
    fn compile_time_url(name: &str) -> Option<String> {
        let raw = match name {
            "GAIA_SHELL_URL" => option_env!("GAIA_SHELL_URL"),
            "GAIA_MOBILE_DAEMON_URL" => option_env!("GAIA_MOBILE_DAEMON_URL"),
            _ => None,
        }?;
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    }

    fn resolve_url() -> String {
        if let Some(url) = env_url("GAIA_SHELL_URL") {
            return url;
        }
        #[cfg(mobile)]
        {
            if let Some(url) = env_url("GAIA_MOBILE_DAEMON_URL")
                .or_else(|| compile_time_url("GAIA_MOBILE_DAEMON_URL"))
                .or_else(|| compile_time_url("GAIA_SHELL_URL"))
            {
                return url;
            }
        }
        format!("http://127.0.0.1:{}/", resolve_port())
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
            .initialization_script(&crate::debug_server::init_script())
            // Required so the web UI's HTML5 drag-and-drop (tab reorder + tear-off)
            // fires: with Tauri's OS drag-drop handler on, the webview swallows it.
            .disable_drag_drop_handler()
            .resizable(true);
        if let (Some(px), Some(py)) = (x, y) {
            builder = builder.position(px, py);
        }
        let _window = builder.build().map_err(|e| e.to_string())?;
        Ok(label)
    }

    fn valid_pet_package(name: &str) -> bool {
        let mut chars = name.chars();
        chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
            && chars.all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
    }

    fn pet_window_label(binding: &PetBinding) -> String {
        let mut hasher = DefaultHasher::new();
        binding.workspace_id.hash(&mut hasher);
        binding.room_id.hash(&mut hasher);
        binding.agent_id.hash(&mut hasher);
        binding.package.hash(&mut hasher);
        format!("pet-{:016x}", hasher.finish())
    }

    fn pet_window_url(binding: &PetBinding) -> Result<tauri::Url, String> {
        let base: tauri::Url = resolve_url()
            .parse()
            .map_err(|e| format!("bad shell url: {e}"))?;
        let mut url = base.join("pet.html").map_err(|e| e.to_string())?;
        url.query_pairs_mut()
            .append_pair("workspaceId", &binding.workspace_id)
            .append_pair("roomId", &binding.room_id)
            .append_pair("agentId", &binding.agent_id)
            .append_pair("package", &binding.package);
        Ok(url)
    }

    /// Reconcile one workspace's complete durable binding snapshot into real
    /// desktop windows. Mobile compiles the no-op sibling below: iOS must never
    /// pretend an in-app webview can stay above unrelated apps.
    #[tauri::command]
    #[cfg(desktop)]
    fn sync_pets(
        app: tauri::AppHandle,
        workspace_id: String,
        bindings: Vec<PetBinding>,
    ) -> Result<bool, String> {
        if bindings.iter().any(|binding| {
            binding.workspace_id != workspace_id
                || binding.room_id.is_empty()
                || binding.agent_id.is_empty()
                || !valid_pet_package(&binding.package)
        }) {
            return Err("invalid pet binding snapshot".to_string());
        }

        let desired: HashMap<String, PetBinding> = bindings
            .into_iter()
            .map(|binding| (pet_window_label(&binding), binding))
            .collect();
        let state = app.state::<PetWindows>();
        let mut live = state.0.lock().map_err(|_| "pet window state poisoned")?;

        let stale: Vec<String> = live
            .iter()
            .filter(|(label, binding)| {
                binding.workspace_id == workspace_id && !desired.contains_key(*label)
            })
            .map(|(label, _)| label.clone())
            .collect();
        for label in stale {
            if let Some(window) = app.get_webview_window(&label) {
                let _ = window.close();
            }
            live.remove(&label);
        }

        for (index, (label, binding)) in desired.into_iter().enumerate() {
            if live.contains_key(&label) && app.get_webview_window(&label).is_some() {
                continue;
            }
            let url = pet_window_url(&binding)?;
            WebviewWindowBuilder::new(&app, &label, WebviewUrl::External(url))
                .title(format!("GAIA Pet — @{}", binding.agent_id))
                .inner_size(240.0, 190.0)
                .position(
                    24.0 + (index % 5) as f64 * 190.0,
                    24.0 + (index / 5) as f64 * 155.0,
                )
                .resizable(false)
                .decorations(false)
                .transparent(true)
                .shadow(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .focused(false)
                .initialization_script(&crate::debug_server::init_script())
                .build()
                .map_err(|e| e.to_string())?;
            live.insert(label, binding);
        }
        Ok(true)
    }

    #[tauri::command]
    #[cfg(mobile)]
    fn sync_pets(
        _app: tauri::AppHandle,
        _workspace_id: String,
        _bindings: Vec<PetBinding>,
    ) -> Result<bool, String> {
        Ok(false)
    }

    /// Route one globally-delivered room+agent progress event only to its bound
    /// window. The daemon derives status/toolName from shared AgentEvents; Rust
    /// has no harness knowledge.
    #[tauri::command]
    fn pet_progress(app: tauri::AppHandle, progress: PetProgress) -> Result<(), String> {
        let state = app.state::<PetWindows>();
        let live = state.0.lock().map_err(|_| "pet window state poisoned")?;
        for (label, binding) in live.iter() {
            if binding.workspace_id == progress.workspace_id
                && binding.room_id == progress.room_id
                && binding.agent_id == progress.agent_id
            {
                if let Some(window) = app.get_webview_window(label) {
                    window
                        .emit("gaia://pet-progress", progress.clone())
                        .map_err(|e| e.to_string())?;
                }
            }
        }
        Ok(())
    }

    /// Re-dock a torn-off chat: tell the main window to re-adopt `room` as a tab,
    /// focus it, and close the calling (torn) window. `window` is the caller,
    /// injected by Tauri.
    #[tauri::command]
    fn redock(
        app: tauri::AppHandle,
        window: tauri::WebviewWindow,
        room: String,
    ) -> Result<(), String> {
        if let Some(main) = app.get_webview_window("main") {
            main.emit("gaia://redock", room)
                .map_err(|e| e.to_string())?;
            let _ = main.set_focus();
        }
        // Don't close the last window out from under the user if main is gone.
        if app.get_webview_window("main").is_some() {
            let _ = window.close();
        }
        Ok(())
    }

    /// Set the app's dock badge (macOS) / taskbar badge — the "N unread" count the
    /// web UI computes when agent turns finish in rooms the user isn't watching.
    /// `count <= 0` clears it. The badge is application-global, so it's applied via
    /// whichever GAIA window exists (main preferred); a windowless app is a silent
    /// no-op. Called from the web bridge's `setDockBadge`.
    #[tauri::command]
    #[cfg(desktop)]
    fn set_badge(app: tauri::AppHandle, count: i64) -> Result<(), String> {
        let window = app
            .get_webview_window("main")
            .or_else(|| app.webview_windows().into_values().next());
        let Some(window) = window else {
            return Ok(());
        };
        let value = if count > 0 { Some(count) } else { None };
        window.set_badge_count(value).map_err(|e| e.to_string())
    }

    #[tauri::command]
    #[cfg(mobile)]
    fn set_badge(_app: tauri::AppHandle, _count: i64) -> Result<(), String> {
        Ok(())
    }

    /// Post a native OS notification (Notification Center banner) when an agent
    /// finishes a turn the user isn't looking at. Called from the web bridge's
    /// `nativeNotify`; the plugin's Rust API is used directly (no webview ACL
    /// surface). The first call may trigger the OS's one-time permission prompt.
    #[tauri::command]
    fn notify(app: tauri::AppHandle, title: String, body: String) -> Result<(), String> {
        app.notification()
            .builder()
            .title(title)
            .body(body)
            .show()
            .map_err(|e| e.to_string())
    }

    /// The currently focused GAIA window (main or a spawned one), so a menu action
    /// applies to the window the user is actually looking at.
    #[cfg(desktop)]
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
    #[cfg(desktop)]
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
        let new_room = MenuItemBuilder::with_id("new_room", "New Room")
            .accelerator("CmdOrCtrl+Shift+N")
            .build(handle)?;
        let new_incognito_room =
            MenuItemBuilder::with_id("new_incognito_room", "New Incognito Room")
                .accelerator("CmdOrCtrl+Alt+Shift+N")
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
            .item(&new_room)
            .item(&new_incognito_room)
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
    #[cfg(desktop)]
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
        let builder = tauri::Builder::default()
            .plugin(tauri_plugin_notification::init())
            .manage(SpawnedDaemon(Mutex::new(None)))
            .manage(PetWindows(Mutex::new(HashMap::new())))
            .invoke_handler(tauri::generate_handler![
                open_window,
                redock,
                set_badge,
                notify,
                sync_pets,
                pet_progress
            ]);

        #[cfg(desktop)]
        let builder = builder.on_menu_event(|app, event| handle_menu(app, event.id().0.as_str()));

        builder
            .setup(|app| {
                let port = resolve_port();
                let url = resolve_url();

                // Native menu: standard macOS chords for the window/tab chrome, plus a
                // working Edit menu (copy/paste). Best-effort — a menu failure must not
                // stop the window from opening.
                #[cfg(desktop)]
                if let Err(e) = build_and_set_menu(app.handle()) {
                    eprintln!("[gaia-shell] menu setup failed: {e}");
                }

                // Self-contained CLI: repair `gaia` on the user's PATH every
                // launch, best-effort, regardless of autostart mode.
                crate::daemon_lifecycle::ensure_cli_on_path();

                // Own our daemon unless explicitly disabled for a dev-only pure attach.
                match std::env::var("GAIA_SHELL_AUTOSTART").as_deref() {
                    Ok("0") | Ok("false") | Ok("off") => {}
                    _ => {
                        crate::daemon_lifecycle::kill_existing(port);
                        if let Some(child) = crate::daemon_lifecycle::spawn_owned(port) {
                            if let Some(state) = app.try_state::<SpawnedDaemon>() {
                                *state.0.lock().unwrap() = Some(child);
                            }
                        }
                    }
                }

                let external: tauri::Url = url
                    .parse()
                    .unwrap_or_else(|e| panic!("invalid GAIA shell URL `{url}`: {e}"));

                #[allow(unused_mut)]
                let mut main_window_builder =
                    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(external))
                        .title("GAIA")
                        .initialization_script(&crate::debug_server::init_script())
                        // See open_window: needed for the tab strip's HTML5 drag-and-drop.
                        .disable_drag_drop_handler();

                // Desktop gets an explicit window size. On iOS/Android a fixed
                // inner_size becomes the WKWebView's frame, so the page lays out
                // at that CSS width (1180px here) and `width=device-width` never
                // resolves to real device points — the whole UI renders far too
                // wide and the screen shows only the left slice. Mobile must let
                // the webview fill the device screen.
                #[cfg(desktop)]
                {
                    main_window_builder = main_window_builder
                        .inner_size(1180.0, 820.0)
                        .min_inner_size(720.0, 480.0)
                        .resizable(true);
                }

                let main_window = main_window_builder.build()?;
                install_ios_scroll_inset_fix(&main_window);
                crate::debug_server::spawn(app.handle().clone());

                Ok(())
            })
            .build(tauri::generate_context!())
            .expect("error while building the GAIA shell")
            .run(|app, event| {
                // On exit, tear down ONLY a daemon we spawned ourselves — total
                // death (the whole process tree), never a bare kill of the
                // immediate child.
                if let tauri::RunEvent::ExitRequested { .. } = event {
                    if let Some(state) = app.try_state::<SpawnedDaemon>() {
                        if let Some(child) = state.0.lock().unwrap().take() {
                            crate::daemon_lifecycle::teardown(resolve_port(), child);
                        }
                    }
                }
            });
    }
}

#[cfg(feature = "webkit")]
pub use webkit::run;
