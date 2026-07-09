const APP_COMMANDS: &[&str] = &["open_window", "redock", "set_badge", "notify"];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to build Tauri app");
}
