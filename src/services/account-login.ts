// Interactive in-app account login. A harness's own login CLI (claude
// setup-token, ...) is a TUI that needs a real terminal: it prints a sign-in
// URL, waits for the user to approve in a browser and paste back a code, then
// prints a long-lived credential. This service drives that flow FROM the daemon
// without a terminal by wrapping the command in `script` (a pty allocator) so
// the CLI believes it has a tty; it strips the TUI's ANSI escapes, feeds the
// running output through the spec's extractors to lift the URL / detect the
// paste prompt / capture the credential, forwards the user's pasted code on
// stdin, and stores the account. It is HARNESS-BLIND: every bit of harness
// knowledge (which command, how to find the URL, what the credential looks
// like) is DATA on the spec (AccountLoginSpec) — this file never branches on a
// harness id (RULE #0). The only branch here is on PLATFORM (how `script`
// wraps a command differs on darwin vs. linux), which is not a harness branch.

import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { gaiaHome } from "../core/paths.js";
import { newId } from "../core/ids.js";
import { addAccount, newAccountId } from "../domain/accounts.js";
import { harnessSpecFor, type AccountLoginSpec } from "../harness/spec.js";

/** Strip ANSI CSI + OSC sequences so the extractors see plain text. */
function stripAnsi(text: string): string {
  return text.replace(/\[[0-9;?]*[A-Za-z]/g, "").replace(/\][^]*(?:|\\)/g, "");
}

export type AccountLoginStatus = "starting" | "awaiting-signin" | "awaiting-code" | "done" | "error" | "cancelled";

export interface AccountLoginState {
  sessionId: string;
  harness: string;
  status: AccountLoginStatus;
  url?: string;
  account?: { id: string; harness: string; label?: string };
  error?: string;
}

interface LoginSession {
  state: AccountLoginState;
  login: AccountLoginSpec;
  child: ChildProcess;
  output: string;
  configDir: string;
  label?: string;
  killTimer: ReturnType<typeof setTimeout>;
}

const TERMINAL: ReadonlySet<AccountLoginStatus> = new Set(["done", "error", "cancelled"]);
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

export class AccountLoginService {
  private readonly sessions = new Map<string, LoginSession>();

  start(harnessId: string, label?: string): AccountLoginState {
    const spec = harnessSpecFor(harnessId);
    if (!spec.accounts) throw new Error(`harness '${harnessId}' has no account support`);
    const login = spec.accounts.login;
    if (!login) throw new Error(`harness '${harnessId}' has no in-app login — add the account in accounts.json`);

    const sessionId = newId("login");
    const configDir = join(gaiaHome(), "logins", sessionId);
    mkdirSync(configDir, { recursive: true });

    const cmd = login.command({ configDir });
    const opts: SpawnOptions = { env: { ...process.env, ...cmd.env }, stdio: ["pipe", "pipe", "pipe"] };
    // `script` allocates a pseudo-tty so the login CLI (which silently hangs
    // without a tty) runs. macOS `script -q /dev/null <cmd...>` forwards our
    // stdin; other platforms use `script -qec "<quoted cmd>" /dev/null`.
    const child =
      process.platform === "darwin"
        ? spawn("script", ["-q", "/dev/null", ...cmd.argv], opts)
        : spawn(
            "script",
            ["-qec", cmd.argv.map((a) => `'${a.replaceAll("'", `'\\''`)}'`).join(" "), "/dev/null"],
            opts,
          );

    const session: LoginSession = {
      state: { sessionId, harness: harnessId, status: "starting" },
      login,
      child,
      output: "",
      configDir,
      ...(label ? { label } : {}),
      killTimer: setTimeout(() => {
        if (!TERMINAL.has(session.state.status)) {
          session.state.status = "error";
          session.state.error = "login timed out";
          this.cleanup(session);
        }
      }, LOGIN_TIMEOUT_MS),
    };
    this.sessions.set(sessionId, session);

    const onData = (chunk: Buffer): void => {
      session.output += stripAnsi(chunk.toString());
      this.advance(session);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("exit", () => {
      if (TERMINAL.has(session.state.status)) return;
      const creds = session.login.credentials({ output: session.output, configDir: session.configDir });
      if (creds) this.finish(session, creds);
      else {
        session.state.status = "error";
        session.state.error = "login flow ended without producing credentials";
        this.cleanup(session);
      }
    });
    child.on("error", () => {
      if (TERMINAL.has(session.state.status)) return;
      session.state.status = "error";
      session.state.error = "login flow failed to start";
      this.cleanup(session);
    });

    return { ...session.state };
  }

  private advance(session: LoginSession): void {
    if (TERMINAL.has(session.state.status)) return;
    const creds = session.login.credentials({ output: session.output, configDir: session.configDir });
    if (creds) {
      this.finish(session, creds);
      return;
    }
    if (session.login.awaitingInput(session.output)) {
      session.state.status = "awaiting-code";
    } else if (!session.state.url) {
      const url = session.login.signInUrl(session.output);
      if (url) {
        session.state.url = url;
        session.state.status = "awaiting-signin";
      }
    }
  }

  private finish(session: LoginSession, creds: Record<string, string>): void {
    const id = newAccountId(session.state.harness, session.label);
    addAccount({
      id,
      harness: session.state.harness,
      ...(session.label ? { label: session.label } : {}),
      credentials: creds,
    });
    session.state.account = { id, harness: session.state.harness, ...(session.label ? { label: session.label } : {}) };
    session.state.status = "done";
    this.cleanup(session);
  }

  private cleanup(session: LoginSession): void {
    clearTimeout(session.killTimer);
    if (session.child.exitCode === null && !session.child.killed) session.child.kill();
    try {
      // The throwaway dir may hold a session cookie — always delete it.
      rmSync(session.configDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  input(sessionId: string, text: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || TERMINAL.has(session.state.status)) throw new Error("no active login session");
    session.child.stdin?.write(text.trim() + "\n");
  }

  status(sessionId: string): AccountLoginState {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error("unknown login session");
    return { ...session.state };
  }

  cancel(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || TERMINAL.has(session.state.status)) return;
    session.state.status = "cancelled";
    this.cleanup(session);
  }
}
