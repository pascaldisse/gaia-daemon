// Pure argv parser — isolated from execution so it's unit-testable without a
// browser. Recognizes the minimum command set: doctor, start/open, status,
// inspect, screenshot, prompt/create, sync.
const COMMANDS = new Set(["doctor", "start", "open", "status", "inspect", "screenshot", "prompt", "create", "sync"]);

export function parseArgs(argv) {
  const args = [...argv];
  const command = args.shift();
  if (!command) return { command: null, error: "missing command" };
  if (!COMMANDS.has(command)) return { command, error: `unknown command: ${command}` };

  const options = { cdpPort: undefined, profileDir: undefined, browser: undefined, headless: false, out: undefined, positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--cdp-port") options.cdpPort = Number(args[++i]);
    else if (a === "--profile-dir") options.profileDir = args[++i];
    else if (a === "--browser") options.browser = args[++i];
    else if (a === "--headless") options.headless = true;
    else if (a === "--out") options.out = args[++i];
    else if (a === "--") options.positional.push(...args.slice(i + 1)), (i = args.length);
    else options.positional.push(a);
  }

  if ((command === "prompt" || command === "create") && options.positional.length === 0) {
    return { command, options, error: `${command} requires a non-empty brief/prompt` };
  }
  return { command, options, error: null };
}

export function usage() {
  return [
    "Usage: claude-design.mjs <command> [options]",
    "",
    "Commands:",
    "  doctor              check dedicated browser + desktop session availability",
    "  start | open         launch/reuse the dedicated browser and open claude.ai/design",
    "  status               report auth/page readiness of the dedicated instance",
    "  inspect               dump semantic selector match status for the design page",
    "  screenshot            capture a PNG of the current dedicated page",
    "  prompt | create <brief>   send a prompt into Claude Design (create a design)",
    "  sync                 run Claude Code's official /design-sync (optional path)",
    "",
    "Options:",
    "  --cdp-port <n>        dedicated CDP port (default 9456; never 9333)",
    "  --profile-dir <path>  dedicated browser profile dir (default skill/profile)",
    "  --browser <path>      explicit Chromium-family executable",
    "  --headless            use --headless=new instead of a visible window",
    "  --out <path>          screenshot output path",
  ].join("\n");
}
