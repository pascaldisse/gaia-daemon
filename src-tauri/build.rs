const APP_COMMANDS: &[&str] = &["open_window", "redock", "set_badge", "notify"];

fn bake_mobile_daemon_url() {
    let manifest_dir = std::env::var("CARGO_MANIFEST_DIR").unwrap_or_else(|_| ".".to_string());
    let path = std::path::Path::new(&manifest_dir).join("mobile-daemon-url.txt");
    println!("cargo:rerun-if-changed={}", path.display());
    if let Ok(contents) = std::fs::read_to_string(&path) {
        let trimmed = contents.trim();
        if !trimmed.is_empty() {
            println!("cargo:rustc-env=GAIA_MOBILE_DAEMON_URL={}", trimmed);
        }
    }
}

fn main() {
    println!("cargo:rerun-if-env-changed=GAIA_MOBILE_DAEMON_URL");
    println!("cargo:rerun-if-env-changed=GAIA_SHELL_URL");
    bake_mobile_daemon_url();
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(APP_COMMANDS)),
    )
    .expect("failed to build Tauri app");
}
