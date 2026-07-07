#[cfg(not(all(feature = "cef", target_os = "macos")))]
fn main() {
    eprintln!(
        "gaia-cef-bundle currently supports macOS with `--no-default-features --features cef`"
    );
    std::process::exit(2);
}

#[cfg(all(feature = "cef", target_os = "macos"))]
fn main() -> Result<(), Box<dyn std::error::Error>> {
    use cef::build_util::mac::{bundle, BundleInfo};
    use semver::Version;
    use std::path::PathBuf;

    let mut output = PathBuf::from("target/engine-bundles/cef");
    let mut profile = String::from("debug");
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--output" | "-o" => {
                output = PathBuf::from(args.next().ok_or("missing --output value")?)
            }
            "--profile" | "-p" => profile = args.next().ok_or("missing --profile value")?,
            other => return Err(format!("unknown argument: {other}").into()),
        }
    }

    let target_path = PathBuf::from("target").join(&profile);
    let app = bundle(
        &output,
        &target_path,
        "gaia-shell",
        "gaia-cef-helper",
        None,
        BundleInfo::new(
            "GAIA CEF",
            "com.gaia.daemon.cef",
            "GAIA CEF",
            "English",
            Version::new(0, 1, 0),
        ),
    )?;
    println!("built: {}", app.display());
    Ok(())
}
