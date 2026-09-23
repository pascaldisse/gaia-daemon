// TTS-mute 3rd recurrence (09-23, whip 461) — see docs/readaloud-playback.md § row H
// in the main repo (this crate has no docs/ of its own).
//
// The web-side watchdogs (analyser RMS, ctx.currentTime stall, mediaDevices
// 'devicechange') all sit at or above the WebAudio graph, which WebKit keeps
// rendering into whichever device the AudioContext was born on. After a pure
// default-OUTPUT reassignment (e.g. macOS Sound-menu AirPods↔speakers, no
// device add/remove) the graph stays "loud" and the clock keeps ticking while
// the actual hardware sink is dead — none of those detectors can see it, and
// WebKit gates the 'devicechange' DOM event on a getUserMedia grant this page
// never requests, so it never fires either. This module is the one signal
// that sits *below* the WebAudio graph, at the real OS routing layer: a
// CoreAudio kAudioHardwarePropertyDefaultOutputDevice listener on the system
// object, installed once at app setup. On every change it (after a debounce,
// to collapse a burst of callbacks during a single physical switch into one
// event) dispatches a CustomEvent on `window` in every live WKWebView; the
// JS-side twin listener lives in web/src/readaloud.js and reuses the exact
// same bounded `rebuildDeadOutput()` recovery path as every other detector.
//
// Constants verified against the public CoreAudio headers (Apple SDK, via
// phracker/MacOSX-SDKs mirror): kAudioHardwarePropertyDefaultOutputDevice =
// 'dOut' (AudioHardware.h), kAudioObjectPropertyScopeGlobal = 'glob' and
// kAudioObjectPropertyElementMaster/Main = 0 (AudioHardwareBase.h),
// kAudioObjectSystemObject = 1 (AudioHardware.h). Not exercised against a
// real CoreAudio callback in this fix (see UNVERIFIED note where this module
// is wired up in lib.rs) — correctness here rests on those header values
// plus the block2/objc2 FFI patterns already used elsewhere in this crate
// (see capture_webview_png in debug_server.rs for the sibling RcBlock usage).

use std::ffi::c_void;
use std::sync::mpsc;
use std::time::Duration;

use block2::{Block, RcBlock};
use tauri::{AppHandle, Manager};

/// Wire event name dispatched into every live WKWebView on a default-output
/// device change. One exported constant on this (Rust) side; the JS-side
/// twin (`OUTPUT_DEVICE_CHANGED_EVENT`, web/src/readaloud.js) is a separate
/// constant because Rust and JS cannot share a symbol — each side defines the
/// literal exactly once, so there is no *per-language* string duplication.
pub const OUTPUT_DEVICE_CHANGED_EVENT: &str = "gaia:output-device-changed";

/// Debounce window before a burst of CoreAudio callbacks (a single physical
/// device switch can fire the listener more than once) collapses into one
/// dispatched event. Overridable — see `install_with_debounce`.
pub const DEFAULT_DEBOUNCE_MS: u64 = 250;

type AudioObjectId = u32;
type OsStatus = i32;

#[repr(C)]
struct AudioObjectPropertyAddress {
    selector: u32,
    scope: u32,
    element: u32,
}

const fn fourcc(code: [u8; 4]) -> u32 {
    ((code[0] as u32) << 24) | ((code[1] as u32) << 16) | ((code[2] as u32) << 8) | (code[3] as u32)
}

const K_AUDIO_OBJECT_SYSTEM_OBJECT: AudioObjectId = 1;
const K_AUDIO_HARDWARE_PROPERTY_DEFAULT_OUTPUT_DEVICE: u32 = fourcc(*b"dOut");
const K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL: u32 = fourcc(*b"glob");
/// `kAudioObjectPropertyElementMaster` (pre-macOS 12 SDKs) /
/// `kAudioObjectPropertyElementMain` (macOS 12+ SDKs) — same value, 0, across
/// every SDK that has shipped either name.
const K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN: u32 = 0;

#[link(name = "CoreAudio", kind = "framework")]
extern "C" {
    /// `AudioObjectAddPropertyListenerBlock` — CoreAudio/AudioHardware.h.
    /// `in_dispatch_queue = NULL` runs the block on an internal CoreAudio
    /// notification queue (not necessarily the main thread), which is why
    /// the dispatch back into the webview below always hops through
    /// `AppHandle::run_on_main_thread`.
    // The block-callback pointer argument is typed `*const c_void` (rather
    // than `*const AudioObjectPropertyAddress`) purely so block2's Encode
    // machinery accepts the closure below — our plain repr(C) struct has no
    // ObjC type encoding of its own. The real call signature in C is still
    // `const AudioObjectPropertyAddress*`; this listener never reads the
    // pointee anyway (it only cares that *a* default-output change fired).
    fn AudioObjectAddPropertyListenerBlock(
        in_object_id: AudioObjectId,
        in_address: *const AudioObjectPropertyAddress,
        in_dispatch_queue: *mut c_void,
        in_listener: &Block<dyn Fn(u32, *const c_void)>,
    ) -> OsStatus;
}

/// Install the CoreAudio default-output-device watchdog with the default
/// debounce. Best-effort: a registration failure is logged, never fatal (the
/// web-side watchdogs D/E/G still cover their own failure classes).
pub fn install(app: AppHandle) {
    install_with_debounce(app, DEFAULT_DEBOUNCE_MS);
}

/// Same as [`install`] with an explicit debounce window in milliseconds.
pub fn install_with_debounce(app: AppHandle, debounce_ms: u64) {
    let (tx, rx) = mpsc::channel::<()>();

    // Trailing-edge debounce: block for the first signal of a burst, then
    // drain/collapse any further signals that arrive inside the debounce
    // window before actually dispatching. Runs for the lifetime of the app;
    // exits cleanly once `tx` (held by the CoreAudio block below) is dropped.
    std::thread::spawn(move || loop {
        if rx.recv().is_err() {
            return;
        }
        while rx.recv_timeout(Duration::from_millis(debounce_ms)).is_ok() {}
        let app_for_main = app.clone();
        if let Err(e) = app.run_on_main_thread(move || {
            let script = format!(
                "window.dispatchEvent(new CustomEvent({:?}))",
                OUTPUT_DEVICE_CHANGED_EVENT
            );
            for (_label, window) in app_for_main.webview_windows() {
                if let Err(e) = window.eval(&script) {
                    eprintln!("[gaia-shell] output-device-changed eval failed: {e}");
                }
            }
        }) {
            eprintln!("[gaia-shell] output-device-changed run_on_main_thread failed: {e}");
        }
    });

    // Retained for the process lifetime by the ObjC runtime once installed
    // (Block_copy'd by AudioObjectAddPropertyListenerBlock) — intentionally
    // leaked rather than stored, matching this crate's other one-shot native
    // hooks (see capture_webview_png's completion handler in debug_server.rs).
    let block: RcBlock<dyn Fn(u32, *const c_void)> =
        RcBlock::new(move |_n: u32, _addrs: *const c_void| {
            let _ = tx.send(());
        });

    let address = AudioObjectPropertyAddress {
        selector: K_AUDIO_HARDWARE_PROPERTY_DEFAULT_OUTPUT_DEVICE,
        scope: K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
        element: K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
    };

    let status = unsafe {
        AudioObjectAddPropertyListenerBlock(
            K_AUDIO_OBJECT_SYSTEM_OBJECT,
            &address,
            std::ptr::null_mut(),
            &block,
        )
    };
    if status != 0 {
        eprintln!(
            "[gaia-shell] AudioObjectAddPropertyListenerBlock failed: OSStatus {status}"
        );
    }
    // Leak intentionally: the block must outlive this function, for the life
    // of the app, and there is no matching `AudioObjectRemovePropertyListenerBlock`
    // call anywhere (the watchdog runs until process exit). CoreAudio takes
    // its own Block_copy retain internally, so `mem::forget` here only
    // avoids relying on that retain-count interaction for correctness.
    std::mem::forget(block);
}
