// Mint a claude account NOW: run setup-token under expect (daemon-identical),
// stream raw output, store the token via the domain layer. Usage: mint.ts <label>
import "../src/harness/claude.js";
import { findHarness } from "../src/harness/spec.js";
import { addAccount, newAccountId } from "../src/domain/accounts.js";
import { spawn } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const label = process.argv[2] ?? "";
const login = findHarness("claude")?.accounts?.login;
if (!login) throw new Error("no login spec");
const configDir = join(tmpdir(), `mint-${Date.now().toString(36)}`);
mkdirSync(configDir, { recursive: true });
const cmd = login.command({ configDir });
const strip = (t: string) => t.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
const script = [
  "set timeout -1",
  `spawn -noecho ${cmd.argv.map((a) => `{${a}}`).join(" ")}`,
  "fileevent stdin readable {",
  '  if {[gets stdin line] >= 0} { send -- "$line\\r" } else { fileevent stdin readable {} }',
  "}",
  "expect eof",
].join("\n");
const child = spawn("expect", ["-c", script], { env: { ...process.env, ...cmd.env }, stdio: ["pipe", "pipe", "pipe"] });
let out = "";
let done = false;
const onData = (c: Buffer) => {
  out += strip(c.toString());
  process.stderr.write("[RAW] " + JSON.stringify(strip(c.toString()).slice(0, 200)) + "\n");
  const creds = login.credentials({ output: out, configDir });
  if (creds && !done) {
    done = true;
    const id = newAccountId("claude", label || undefined);
    addAccount({ id, harness: "claude", ...(label ? { label } : {}), credentials: creds });
    console.log("STORED:", id);
    child.kill();
    rmSync(configDir, { recursive: true, force: true });
    process.exit(0);
  }
  const url = login.signInUrl(out);
  if (url) console.log("URL:", url);
};
child.stdout?.on("data", onData);
child.stderr?.on("data", onData);
child.on("exit", () => {
  if (!done) {
    console.log("EXIT-NO-CREDS tail:", out.trim().slice(-300));
    rmSync(configDir, { recursive: true, force: true });
    process.exit(1);
  }
});
setTimeout(() => { if (!done) { console.log("TIMEOUT tail:", out.trim().slice(-300)); child.kill(); process.exit(1); } }, 60000);
