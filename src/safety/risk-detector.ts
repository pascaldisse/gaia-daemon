import { isAbsolute, relative, resolve } from "node:path";

export interface RiskAssessment {
  risky: boolean;
  reasons: string[];
}

const SECRET_PATH = /(^|\/)(\.env($|\.)|credentials|\.npmrc|\.pypirc|id_rsa|id_ed25519|\.ssh|auth\.json|token|secret)/i;
const RISKY_BASH = /(^|[;&|\s])(sudo|rm\s+-|mv\s+|chmod\s+|chown\s+|npm\s+(i|install)|pnpm\s+(i|add|install)|yarn\s+add|pip\s+install|curl\b.*\|\s*(sh|bash)|wget\b.*\|\s*(sh|bash))/i;
const REDIRECT_PROTECTED = />\s*(\/|~\/|\.env|.*credentials|.*secret|.*token)/i;

function insideCwd(path: string, cwd: string): boolean {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const rel = relative(resolve(cwd), absolute);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function assessToolRisk(toolName: string, input: Record<string, unknown>, cwd: string): RiskAssessment {
  const reasons: string[] = [];

  const pathValue = typeof input.path === "string" ? input.path : typeof input.file_path === "string" ? input.file_path : undefined;
  if ((toolName === "write" || toolName === "edit") && pathValue) {
    if (!insideCwd(pathValue, cwd)) reasons.push(`write/edit outside cwd: ${pathValue}`);
    if (SECRET_PATH.test(pathValue)) reasons.push(`secret-bearing path: ${pathValue}`);
  }

  if (toolName === "bash") {
    const command = typeof input.command === "string" ? input.command : "";
    if (RISKY_BASH.test(command)) reasons.push(`risky shell command: ${command}`);
    if (REDIRECT_PROTECTED.test(command)) reasons.push(`shell redirection to protected-looking path: ${command}`);
  }

  if ((toolName === "read" || toolName === "grep") && pathValue && SECRET_PATH.test(pathValue)) {
    reasons.push(`secret-bearing read path: ${pathValue}`);
  }

  return { risky: reasons.length > 0, reasons };
}
