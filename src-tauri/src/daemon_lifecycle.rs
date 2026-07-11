//! Owned GAIA daemon lifecycle shared by all native shell engines.

use std::process::Child;

#[cfg(all(desktop, unix))]
use std::net::{TcpStream, ToSocketAddrs};
#[cfg(all(desktop, unix))]
use std::process::Command;
#[cfg(all(desktop, unix))]
use std::time::{Duration, Instant};

/// Is something accepting TCP connections on 127.0.0.1:port?
#[cfg(all(desktop, unix))]
pub fn port_alive(port: u16) -> bool {
    let addr = match ("127.0.0.1", port).to_socket_addrs() {
        Ok(mut it) => match it.next() {
            Some(a) => a,
            None => return false,
        },
        Err(_) => return false,
    };
    TcpStream::connect_timeout(&addr, Duration::from_millis(300)).is_ok()
}

#[cfg(any(mobile, all(desktop, not(unix))))]
pub fn port_alive(_port: u16) -> bool {
    false
}

/// `<gaia home>/daemon.pid` — mirrors src/core/paths.ts `gaiaHome()`
/// (GAIA_HOME env override, else `~/.gaia`). The daemon (src/server/http.ts)
/// writes its own pid here after every successful bind, INCLUDING the
/// process a `/reload` re-exec spawns — so this file, not the pid of
/// whatever we originally spawned, is the one honest answer to "what do I
/// kill on cmd+Q".
#[cfg(all(desktop, unix))]
pub fn gaia_home_dir() -> std::path::PathBuf {
    if let Ok(dir) = std::env::var("GAIA_HOME") {
        if !dir.trim().is_empty() {
            return std::path::PathBuf::from(dir);
        }
    }
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
    std::path::Path::new(&home).join(".gaia")
}

#[cfg(any(mobile, all(desktop, not(unix))))]
pub fn gaia_home_dir() -> std::path::PathBuf {
    std::path::PathBuf::new()
}

#[cfg(all(desktop, unix))]
pub fn read_daemon_pid() -> Option<i32> {
    let content = std::fs::read_to_string(gaia_home_dir().join("daemon.pid")).ok()?;
    content.trim().parse::<i32>().ok()
}

#[cfg(any(mobile, all(desktop, not(unix))))]
pub fn read_daemon_pid() -> Option<i32> {
    None
}

/// Signal a whole process GROUP (negative pid), not just one process — the
/// daemon is spawned with `process_group(0)` so this reaches every
/// descendant (npm → tsx → node → any `gaia __run-agent` children) in one
/// shot. Shells out to the `kill` binary rather than an FFI syscall so this
/// needs no new Cargo dependency.
#[cfg(all(desktop, unix))]
pub fn kill_process_group(pid: i32, signal: &str) {
    let _ = Command::new("kill")
        .arg(format!("-{signal}"))
        .arg(format!("-{pid}"))
        .status();
}

#[cfg(any(mobile, all(desktop, not(unix))))]
pub fn kill_process_group(_pid: i32, _signal: &str) {}

/// The repo directory the daemon runs from. Defaults to the source tree this
/// binary was built in (baked at compile time via CARGO_MANIFEST_DIR, which is
/// `<repo>/src-tauri`; the daemon lives one level up). This lets a double-clicked
/// app find `package.json` + `node_modules` without any runtime path guessing.
/// Override with GAIA_SHELL_SPAWN_DIR to point at a different checkout.
#[cfg(all(desktop, unix))]
pub fn spawn_dir() -> String {
    if let Ok(dir) = std::env::var("GAIA_SHELL_SPAWN_DIR") {
        if !dir.trim().is_empty() {
            return dir;
        }
    }
    concat!(env!("CARGO_MANIFEST_DIR"), "/..").to_string()
}

#[cfg(any(mobile, all(desktop, not(unix))))]
pub fn spawn_dir() -> String {
    String::new()
}

#[cfg(all(desktop, unix))]
fn lsof_port_pids(port: u16) -> Vec<i32> {
    let output = Command::new("lsof")
        .arg("-ti")
        .arg(format!("tcp:{port}"))
        .output();
    let Ok(output) = output else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<i32>().ok())
        .collect()
}

/// Kill whatever currently owns the daemon port before starting the shell-owned daemon.
#[cfg(all(desktop, unix))]
pub fn kill_existing(port: u16) {
    if !port_alive(port) {
        return;
    }

    let mut pids = Vec::new();
    if let Some(pid) = read_daemon_pid() {
        pids.push(pid);
    }
    pids.extend(lsof_port_pids(port));
    pids.sort_unstable();
    pids.dedup();

    eprintln!("[gaia-shell] :{port} is alive; killing existing daemon owner(s): {pids:?}");
    for pid in &pids {
        eprintln!("[gaia-shell] SIGTERM process group {pid}");
        kill_process_group(*pid, "TERM");
    }

    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline {
        if !port_alive(port) {
            eprintln!("[gaia-shell] existing daemon on :{port} stopped");
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }

    eprintln!("[gaia-shell] existing daemon still alive after 3s; SIGKILL process groups");
    for pid in &pids {
        eprintln!("[gaia-shell] SIGKILL process group {pid}");
        kill_process_group(*pid, "KILL");
    }

    let deadline = Instant::now() + Duration::from_secs(2);
    while Instant::now() < deadline {
        if !port_alive(port) {
            eprintln!("[gaia-shell] existing daemon on :{port} stopped after SIGKILL");
            return;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    eprintln!("[gaia-shell] warning: :{port} still accepts connections after kill attempts");
}

#[cfg(any(mobile, all(desktop, not(unix))))]
pub fn kill_existing(_port: u16) {}

/// Spawn the gaia daemon so the app owns its own backend. Returns the child so
/// the caller can kill it on exit.
#[cfg(all(desktop, unix))]
pub fn spawn_owned(port: u16) -> Option<Child> {
    // Resolution order:
    //   1. GAIA_SHELL_SPAWN_CMD — explicit override, via login shell.
    //   2. Bundled daemon binary shipped NEXT TO this executable
    //      (.app: Contents/MacOS/gaia-daemon) — direct exec, no shell,
    //      no node/npm/tsx anywhere; assets resolve via ../Resources
    //      (see bundledDir in src/core/paths.ts).
    //   3. Dev fallback: `bun run start` through a LOGIN shell (source-run
    //      via bun, no dev watchers) — a Finder-launched .app inherits only
    //      the bare GUI PATH, so `$SHELL -lc` sources the profile to find bun.
    let override_cmd = std::env::var("GAIA_SHELL_SPAWN_CMD")
        .ok()
        .filter(|c| !c.trim().is_empty());
    let bundled = if override_cmd.is_none() {
        std::env::current_exe()
            .ok()
            .and_then(|exe| exe.parent().map(|d| d.join("gaia-daemon")))
            .filter(|p| p.is_file())
    } else {
        None
    };

    let mut command;
    if let Some(bin) = &bundled {
        // cwd = home, never a repo checkout: the bundle must run standalone.
        let home = std::env::var("HOME").unwrap_or_else(|_| "/".to_string());
        eprintln!(
            "[gaia-shell] spawning owned daemon on :{port}: bundled binary {}",
            bin.display()
        );
        command = Command::new(bin);
        command.current_dir(&home);
    } else {
        let cmd = override_cmd.unwrap_or_else(|| "bun run start".to_string());
        let dir = spawn_dir();
        let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
        eprintln!("[gaia-shell] spawning owned daemon on :{port}: `{cmd}` (cwd {dir})");
        command = Command::new(&shell);
        command.arg("-lc").arg(&cmd).current_dir(&dir);
    }
    command
        .env("GAIA_PORT", port.to_string())
        .env("GAIA_PARENT_PID", std::process::id().to_string());
    {
        use std::os::unix::process::CommandExt;
        // Its OWN process group (setpgid(0,0)), not ours: this is what lets
        // cmd+Q later signal exactly the daemon's tree (shell → npm → tsx →
        // node → any `gaia __run-agent` children) without touching the
        // gaia-shell app process itself.
        command.process_group(0);
    }
    let child = command.spawn();

    let child = match child {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[gaia-shell] failed to spawn daemon: {e}");
            return None;
        }
    };

    // Wait (up to ~30s) for the daemon to start listening.
    let deadline = Instant::now() + Duration::from_secs(30);
    while Instant::now() < deadline {
        if port_alive(port) {
            eprintln!("[gaia-shell] daemon is up on :{port}");
            return Some(child);
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    eprintln!("[gaia-shell] daemon did not come up within timeout; loading anyway");
    Some(child)
}

#[cfg(any(mobile, all(desktop, not(unix))))]
pub fn spawn_owned(_port: u16) -> Option<Child> {
    None
}

/// Tear down the shell-owned daemon process tree.
#[cfg(all(desktop, unix))]
pub fn teardown(port: u16, child: Child) {
    let target_pid = read_daemon_pid().unwrap_or(child.id() as i32);
    eprintln!("[gaia-shell] total death: SIGTERM process group {target_pid}");
    kill_process_group(target_pid, "TERM");

    let deadline = Instant::now() + Duration::from_secs(2);
    let mut dead = false;
    while Instant::now() < deadline {
        if !port_alive(port) {
            dead = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    if dead {
        eprintln!("[gaia-shell] stopped the daemon we spawned");
    } else {
        eprintln!("[gaia-shell] daemon still alive after 2s; SIGKILL process group {target_pid}");
        kill_process_group(target_pid, "KILL");
    }
    // The OS reaps it independently of this (exiting) process; no need to
    // block here waiting for it.
    drop(child);
}

#[cfg(any(mobile, all(desktop, not(unix))))]
pub fn teardown(_port: u16, _child: Child) {}
