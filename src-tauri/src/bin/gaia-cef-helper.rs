#[cfg(not(feature = "cef"))]
compile_error!("gaia-cef-helper is only built for `--no-default-features --features cef`");

#[cfg(feature = "cef")]
fn main() {
    gaia_shell_lib::run_cef();
}
