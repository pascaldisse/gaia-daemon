/** Only supported runtime. Legacy persisted ids normalize here at every load boundary. */
export const PI_HARNESS_ID = "pi";
const LEGACY_HARNESS_IDS = new Set(["claude", "codex", "antigravity"]);

/** Preserve unknown values for the registry to reject; map removed runtime ids to Pi. */
export function canonicalHarnessId(value: string, fallback = PI_HARNESS_ID): string {
  const id = value.trim();
  if (!id) return fallback;
  return LEGACY_HARNESS_IDS.has(id) ? PI_HARNESS_ID : id;
}
