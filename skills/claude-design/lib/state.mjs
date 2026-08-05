// Config/state paths — all under the skill's own dir, never shared with the
// interactive browser, GAIA's :9333 app-tools, or the Claude Desktop app.
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const SKILL_DIR = dirname(dirname(fileURLToPath(import.meta.url))); // .../claude-design
export const DEFAULT_PROFILE_DIR = join(SKILL_DIR, "profile"); // gitignored, created lazily
export const DEFAULT_STATE_PATH = join(SKILL_DIR, "profile", "state.json");

export function loadOptions(env = process.env) {
  return {
    cdpPort: Number(env.CLAUDE_DESIGN_CDP_PORT) || undefined,
    profileDir: env.CLAUDE_DESIGN_PROFILE_DIR || undefined,
    browserPath: env.CLAUDE_DESIGN_BROWSER || undefined,
    headless: env.CLAUDE_DESIGN_HEADLESS === "1",
    home: env.CLAUDE_DESIGN_HOME || homedir(),
  };
}
