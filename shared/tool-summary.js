/** Browser-and-daemon neutral compact tool subject. Kept here so the transcript
 * UI and the agent-context projector literally use the same renderer. */
export function toolSummaryText(tool) {
  const candidates = [
    ...toolSubjectCandidates(tool.args),
    ...toolSubjectCandidates(tool.partialResult),
    ...toolSubjectCandidates(tool.result),
  ];
  return candidates[0]?.summary ?? "";
}
function toolSubjectCandidates(value, path = [], depth = 0) {
  if (value === undefined || value === null || depth > 3) return [];
  if (typeof value === "string") {
    const summary = compactOneLine(value);
    return summary ? [{ score: path.length ? subjectScore(path.at(-1)) : 0, summary }] : [];
  }
  if (typeof value === "number" || typeof value === "boolean") {
    const key = path.at(-1);
    return [{ score: subjectScore(key), summary: key ? `${key}: ${String(value)}` : String(value) }];
  }
  if (Array.isArray(value)) return value.slice(0, 4).flatMap((item, index) => toolSubjectCandidates(item, [...path, String(index)], depth + 1));
  if (typeof value !== "object") return [];
  return Object.entries(value).flatMap(([key, nested]) => {
    const nextPath = [...path, key];
    const label = compactKey(key);
    if (typeof nested === "string") {
      const body = compactOneLine(nested);
      if (!body) return [];
      return [{ score: subjectScore(key), summary: subjectScore(key) >= 80 ? body : `${label}: ${body}` }];
    }
    if (typeof nested === "number" || typeof nested === "boolean") return [{ score: subjectScore(key), summary: `${label}: ${String(nested)}` }];
    return toolSubjectCandidates(nested, nextPath, depth + 1);
  }).sort((left, right) => right.score - left.score);
}
function subjectScore(key) {
  const normalized = String(key ?? "").toLowerCase();
  if (["path", "filepath", "file", "filename", "url", "uri", "href", "target"].includes(normalized)) return 100;
  if (["command", "cmd", "query", "pattern", "repo", "repository", "cwd", "name", "id"].includes(normalized)) return 80;
  if (normalized.includes("path") || normalized.includes("file") || normalized.includes("url")) return 90;
  return 10;
}
function compactKey(key) { return String(key ?? "").replace(/[_-]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase(); }
function compactOneLine(value) {
  const normalized = String(value ?? "").replace(/\s+/g, " ").trim();
  return normalized.length > 96 ? `${normalized.slice(0, 93)}...` : normalized;
}
