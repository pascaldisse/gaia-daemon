// Desktop entry point. Delegates to the shared lib so the mobile targets
// (tauri ios/android) can reuse the same run() through their generated macros.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    gaia_shell_lib::run();
}
