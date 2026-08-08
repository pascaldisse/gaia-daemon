// Desktop entry point. The active web engine is selected at compile time.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    gaia_shell_lib::run();
}
