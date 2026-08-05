// Desktop-app cookie/Keychain bootstrap — decrypts the LOCAL Claude Desktop
// app's own already-logged-in session so a *separate*, dedicated browser
// instance can present it to claude.ai. Reads only:
//   ~/Library/Application Support/Claude/Cookies   (Electron Chromium cookie DB)
//   Keychain item "Claude Safe Storage"             (written by the desktop app)
// Never touches the desktop app process, its profile dir, or its running
// window. Never logs a decrypted value — only presence/absence.
import { existsSync, copyFileSync, unlinkSync } from "node:fs";
import { execSync, execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pbkdf2Sync, createDecipheriv } from "node:crypto";

const WANTED_COOKIES = ["sessionKey", "lastActiveOrg", "sessionKeyLC", "anthropic-device-id", "activitySessionId"];

/** Locate the desktop app's cookie DB, or null if the app was never installed/run. */
export function desktopCookiesDbPath(home = homedir()) {
  const p = join(home, "Library", "Application Support", "Claude", "Cookies");
  return existsSync(p) ? p : null;
}

/**
 * Decrypt the desktop app's claude.ai cookies via its own macOS Keychain item.
 * Returns a map of cookie name -> value (never logged), or null if
 * unavailable/undecryptable. Standard Chromium/Electron "Safe Storage"
 * mechanism (v10-prefixed AES-128-CBC, PBKDF2 "saltysalt" key) — the same
 * scheme the app itself uses, nothing exotic.
 */
export function getDesktopSession(home = homedir()) {
  const cookiesDb = desktopCookiesDbPath(home);
  if (!cookiesDb) return null;
  let pw;
  try {
    pw = execSync('security find-generic-password -ws "Claude Safe Storage"', { encoding: "utf8" }).trim();
  } catch {
    return null; // Keychain item missing or access denied — no silent secret leakage either way.
  }
  const key = pbkdf2Sync(pw, "saltysalt", 1003, 16, "sha1");
  const iv = Buffer.alloc(16, 0x20);
  const tmp = join(tmpdir(), "claude-design-cookies-" + process.pid);
  try {
    copyFileSync(cookiesDb, tmp);
    const rows = execFileSync(
      "sqlite3",
      [tmp, "SELECT name||'\t'||hex(encrypted_value) FROM cookies WHERE host_key LIKE '%claude.ai%';"],
      { encoding: "utf8" },
    );
    const out = {};
    for (const line of rows.trim().split("\n")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      if (tab < 0) continue;
      const name = line.slice(0, tab);
      let buf = Buffer.from(line.slice(tab + 1), "hex");
      if (buf.slice(0, 3).toString() === "v10") buf = buf.slice(3);
      try {
        const d = createDecipheriv("aes-128-cbc", key, iv);
        d.setAutoPadding(false);
        let dec = Buffer.concat([d.update(buf), d.final()]);
        const pad = dec[dec.length - 1];
        if (pad > 0 && pad <= 16) dec = dec.slice(0, dec.length - pad);
        let s = dec.toString("utf8");
        if (dec.length > 32) {
          const tail = dec.slice(32).toString("utf8");
          if (/^[\x20-\x7e]+$/.test(tail)) s = tail;
        }
        out[name] = s;
      } catch {
        // one cookie failing to decrypt must not fail the whole session
      }
    }
    return out.sessionKey ? out : null;
  } catch {
    return null;
  } finally {
    try {
      unlinkSync(tmp);
    } catch {}
  }
}

export { WANTED_COOKIES };
