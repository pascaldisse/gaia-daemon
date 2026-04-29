import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent";
import { assessToolRisk } from "./risk-detector.js";
import type { SafetyConfig } from "../config/types.js";

async function askYesNo(message: string): Promise<boolean> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`${message}\nAllow? [y/N] `);
    return /^(y|yes)$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export function createSafetyExtension(config: SafetyConfig): ExtensionFactory {
  return (pi) => {
    pi.on("tool_call", async (event, ctx) => {
      if (!config.confirmRiskyTools) return { block: false };
      const assessment = assessToolRisk(event.toolName, event.input, ctx.cwd);
      if (!assessment.risky) return { block: false };

      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        return config.blockOnNoTty
          ? { block: true, reason: `Risky tool call blocked without TTY: ${assessment.reasons.join("; ")}` }
          : { block: false };
      }

      const allowed = await askYesNo(`\nRisky ${event.toolName} call:\n- ${assessment.reasons.join("\n- ")}`);
      return allowed ? { block: false } : { block: true, reason: "User cancelled risky tool call" };
    });
  };
}
