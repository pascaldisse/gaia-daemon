//! Experimental CEF engine path.
//!
//! This is intentionally feature-gated behind `--no-default-features --features cef` so the
//! default WebKit/WKWebView build never links or bundles Chromium. cef-rs does not yet expose a
//! drop-in Tauri runtime/webview replacement, so this module is the honest fallback: a minimal
//! cef-rs Chromium window that loads the same GAIA daemon URL and exposes CDP.

use cef::*;
use std::cell::RefCell;
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

#[cfg(target_os = "macos")]
mod mac;

const DEFAULT_PORT: u16 = 8787;
const DEFAULT_REMOTE_DEBUGGING_PORT: i32 = 9333;

pub fn run_cef() {
    // CEF's command-line wrapper needs the framework loaded first. Detect helper processes
    // from raw argv so helpers load the framework through their app-bundle-relative path.
    let exe = std::env::current_exe().unwrap_or_default();
    let is_helper = exe.to_string_lossy().contains("/Contents/Frameworks/")
        || std::env::args().any(|arg| arg == "--type" || arg.starts_with("--type="));
    let _library = load_cef(is_helper);

    let args = cef::args::Args::new();
    let Some(cmd_line) = args.as_cmd_line() else {
        eprintln!("[gaia-shell:cef] failed to parse CEF command line");
        std::process::exit(2);
    };

    run_main(args.as_main_args(), &cmd_line, std::ptr::null_mut());
}

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

fn resolve_remote_debugging_port() -> i32 {
    std::env::var("GAIA_CEF_REMOTE_DEBUGGING_PORT")
        .ok()
        .and_then(|s| s.parse::<i32>().ok())
        .filter(|p| *p > 0)
        .unwrap_or(DEFAULT_REMOTE_DEBUGGING_PORT)
}

fn resolve_cef_cache_path() -> CefString {
    let path = std::env::var("GAIA_CEF_CACHE_PATH")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| std::env::temp_dir().join("gaia-cef-cache"));
    let _ = std::fs::create_dir_all(&path);
    CefString::from(path.to_string_lossy().as_ref())
}

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

fn load_cef(is_helper: bool) -> Library {
    #[cfg(target_os = "macos")]
    let library = Library::load(is_helper);

    #[cfg(not(target_os = "macos"))]
    let library = Library;

    // Initialize the CEF API version.
    let _ = api_hash(sys::CEF_API_VERSION_LAST, 0);

    #[cfg(target_os = "macos")]
    if !is_helper {
        mac::setup_application();
    }

    library
}

#[cfg(target_os = "macos")]
struct Library {
    path: std::path::PathBuf,
}

#[cfg(target_os = "macos")]
impl Library {
    const FRAMEWORK_PATH: &'static str =
        "Chromium Embedded Framework.framework/Chromium Embedded Framework";

    fn load(is_helper: bool) -> Self {
        use std::os::unix::ffi::OsStrExt;

        let exe = std::env::current_exe().expect("current_exe failed");
        let parent = exe.parent().expect("current_exe has no parent");
        let resolver = if is_helper {
            "../../.."
        } else {
            "../Frameworks"
        };
        let path = parent
            .join(resolver)
            .join(Self::FRAMEWORK_PATH)
            .canonicalize()
            .unwrap_or_else(|e| {
                panic!(
                    "failed to resolve CEF framework from {}: {e}",
                    exe.display()
                )
            });
        let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).expect("bad CEF path");
        assert_eq!(
            unsafe { cef::load_library(Some(&*c_path.as_ptr().cast())) },
            1,
            "failed to load {}",
            path.display()
        );
        Self { path }
    }
}

#[cfg(target_os = "macos")]
impl Drop for Library {
    fn drop(&mut self) {
        if cef::unload_library() != 1 {
            eprintln!("cannot unload framework {}", self.path.display());
        }
    }
}

#[cfg(not(target_os = "macos"))]
struct Library;

fn run_main(main_args: &MainArgs, cmd_line: &CommandLine, sandbox_info: *mut u8) {
    let switch = CefString::from("type");
    let is_browser_process = cmd_line.has_switch(Some(&switch)) != 1;

    let ret = execute_process(Some(main_args), None, sandbox_info);

    if is_browser_process {
        assert_eq!(ret, -1, "cannot execute browser process");
    } else {
        assert!(ret >= 0, "cannot execute non-browser process");
        return;
    }

    let mut app = GaiaCefApp::new();
    let cache_path = resolve_cef_cache_path();
    let settings = Settings {
        no_sandbox: 1,
        remote_debugging_port: resolve_remote_debugging_port(),
        root_cache_path: cache_path.clone(),
        cache_path,
        ..Default::default()
    };

    assert_eq!(
        initialize(
            Some(main_args),
            Some(&settings),
            Some(&mut app),
            sandbox_info
        ),
        1,
        "CEF initialization failed"
    );

    let url = resolve_url();
    let port = resolve_port();
    eprintln!(
        "[gaia-shell:cef] loading {url} (daemon_alive={}, cdp=http://127.0.0.1:{}/)",
        port_alive(port),
        settings.remote_debugging_port
    );

    run_message_loop();
    shutdown();
}

wrap_window_delegate! {
    struct GaiaWindowDelegate {
        browser_view: RefCell<Option<BrowserView>>,
    }

    impl ViewDelegate {
        fn preferred_size(&self, _view: Option<&mut View>) -> Size {
            Size { width: 1180, height: 820 }
        }
    }

    impl PanelDelegate {}

    impl WindowDelegate {
        fn on_window_created(&self, window: Option<&mut Window>) {
            let browser_view = self.browser_view.borrow();
            let (Some(window), Some(browser_view)) = (window, browser_view.as_ref()) else {
                return;
            };
            let mut view = View::from(browser_view);
            window.add_child_view(Some(&mut view));
            window.set_title(Some(&CefString::from("GAIA — CEF")));
            window.show();
        }

        fn on_window_destroyed(&self, _window: Option<&mut Window>) {
            *self.browser_view.borrow_mut() = None;
        }

        fn can_close(&self, _window: Option<&mut Window>) -> i32 {
            let browser_view = self.browser_view.borrow();
            let Some(browser_view) = browser_view.as_ref() else { return 1; };
            if let Some(browser) = browser_view.browser() {
                let browser_host = browser.host().expect("BrowserHost is None");
                browser_host.try_close_browser()
            } else {
                1
            }
        }
    }
}

wrap_browser_view_delegate! {
    struct GaiaBrowserViewDelegate {}

    impl ViewDelegate {}

    impl BrowserViewDelegate {
        fn on_popup_browser_view_created(
            &self,
            _browser_view: Option<&mut BrowserView>,
            popup_browser_view: Option<&mut BrowserView>,
            _is_devtools: i32,
        ) -> i32 {
            let mut window_delegate = GaiaWindowDelegate::new(RefCell::new(popup_browser_view.cloned()));
            window_create_top_level(Some(&mut window_delegate));
            1
        }
    }
}

wrap_app! {
    pub struct GaiaCefApp;

    impl App {
        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> {
            Some(GaiaBrowserProcessHandler::new(RefCell::new(None)))
        }
    }
}

wrap_browser_process_handler! {
    struct GaiaBrowserProcessHandler {
        client: RefCell<Option<Client>>,
    }

    impl BrowserProcessHandler {
        fn on_context_initialized(&self) {
            debug_assert_ne!(currently_on(ThreadId::UI), 0);

            *self.client.borrow_mut() = Some(GaiaClient::new(GaiaHandler::new()));
            let mut client = self.default_client();
            let url = CefString::from(resolve_url().as_str());
            let settings = BrowserSettings::default();
            let mut delegate = GaiaBrowserViewDelegate::new();

            let browser_view = browser_view_create(
                client.as_mut(),
                Some(&url),
                Some(&settings),
                None,
                None,
                Some(&mut delegate),
            );

            let mut window_delegate = GaiaWindowDelegate::new(RefCell::new(browser_view));
            window_create_top_level(Some(&mut window_delegate));
        }

        fn default_client(&self) -> Option<Client> {
            self.client.borrow().clone()
        }
    }
}

static HANDLER_INSTANCE: OnceLock<std::sync::Weak<Mutex<GaiaHandler>>> = OnceLock::new();

pub struct GaiaHandler {
    browsers: Vec<Browser>,
    is_closing: bool,
}

impl GaiaHandler {
    fn new() -> Arc<Mutex<Self>> {
        Arc::new_cyclic(|weak| {
            let _ = HANDLER_INSTANCE.set(weak.clone());
            Mutex::new(Self {
                browsers: Vec::new(),
                is_closing: false,
            })
        })
    }

    #[allow(dead_code)]
    fn instance() -> Option<Arc<Mutex<Self>>> {
        HANDLER_INSTANCE.get().and_then(std::sync::Weak::upgrade)
    }

    fn on_title_change(&mut self, browser: Option<&mut Browser>, title: Option<&CefString>) {
        let mut browser = browser.cloned();
        if let Some(browser_view) = browser_view_get_for_browser(browser.as_mut()) {
            if let Some(window) = browser_view.window() {
                window.set_title(title);
            }
        }
    }

    fn on_after_created(&mut self, browser: Option<&mut Browser>) {
        if let Some(browser) = browser.cloned() {
            self.browsers.push(browser);
        }
    }

    fn do_close(&mut self, _browser: Option<&mut Browser>) -> bool {
        if self.browsers.len() == 1 {
            self.is_closing = true;
        }
        false
    }

    fn on_before_close(&mut self, browser: Option<&mut Browser>) {
        let Some(mut browser) = browser.cloned() else {
            return;
        };
        if let Some(index) = self
            .browsers
            .iter()
            .position(|elem| elem.is_same(Some(&mut browser)) != 0)
        {
            self.browsers.remove(index);
        }
        if self.browsers.is_empty() {
            quit_message_loop();
        }
    }
}

wrap_client! {
    pub struct GaiaClient {
        inner: Arc<Mutex<GaiaHandler>>,
    }

    impl Client {
        fn display_handler(&self) -> Option<DisplayHandler> {
            Some(GaiaDisplayHandler::new(self.inner.clone()))
        }

        fn life_span_handler(&self) -> Option<LifeSpanHandler> {
            Some(GaiaLifeSpanHandler::new(self.inner.clone()))
        }
    }
}

wrap_display_handler! {
    struct GaiaDisplayHandler {
        inner: Arc<Mutex<GaiaHandler>>,
    }

    impl DisplayHandler {
        fn on_title_change(&self, browser: Option<&mut Browser>, title: Option<&CefString>) {
            if let Ok(mut inner) = self.inner.lock() {
                inner.on_title_change(browser, title);
            }
        }
    }
}

wrap_life_span_handler! {
    struct GaiaLifeSpanHandler {
        inner: Arc<Mutex<GaiaHandler>>,
    }

    impl LifeSpanHandler {
        fn on_after_created(&self, browser: Option<&mut Browser>) {
            if let Ok(mut inner) = self.inner.lock() {
                inner.on_after_created(browser);
            }
        }

        fn do_close(&self, browser: Option<&mut Browser>) -> i32 {
            self.inner
                .lock()
                .map(|mut inner| inner.do_close(browser).into())
                .unwrap_or(1)
        }

        fn on_before_close(&self, browser: Option<&mut Browser>) {
            if let Ok(mut inner) = self.inner.lock() {
                inner.on_before_close(browser);
            }
        }
    }
}
