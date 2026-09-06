import { readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { PiUserGlobalExtensionsPolicy } from "../../core/types/settings.js";

export interface UserGlobalExtensionFilter {
  paths: readonly string[];
  policy: PiUserGlobalExtensionsPolicy;
  allow?: readonly string[];
  exclude?: readonly string[];
}

export interface UserGlobalExtensionFilterResult {
  loaded: string[];
  skipped: string[];
}

/** Filter user-global extension files before making them explicit loader paths.
 * Excludes always win; bare patterns match a basename, slash-containing patterns
 * match the normalized full path. */
export function filterUserGlobalExtensions(input: UserGlobalExtensionFilter): UserGlobalExtensionFilterResult {
  const allow = input.allow ?? [];
  const exclude = input.exclude ?? [];
  const loaded: string[] = [];
  const skipped: string[] = [];
  for (const path of input.paths) {
    const excluded = exclude.some((pattern) => matchesExtensionPattern(pattern, path));
    const permitted = input.policy === "all" || (input.policy === "allowlist" && allow.some((pattern) => matchesExtensionPattern(pattern, path)));
    (permitted && !excluded ? loaded : skipped).push(path);
  }
  return { loaded, skipped };
}

/** Pi's user-global extension directory, restricted to extension source files. */
export function discoverUserGlobalExtensionPaths(agentDir: string): string[] {
  const dir = join(agentDir, "extensions");
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(?:[cm]?ts|[cm]?js)$/u.test(entry.name))
      .map((entry) => join(dir, entry.name))
      .sort();
  } catch {
    return [];
  }
}

function matchesExtensionPattern(pattern: string, path: string): boolean {
  const normalizedPattern = pattern.replaceAll("\\", "/");
  const target = normalizedPattern.includes("/") ? path.replaceAll("\\", "/") : basename(path);
  const expression = `^${normalizedPattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replaceAll("*", ".*")}$`;
  return new RegExp(expression, "u").test(target);
}
