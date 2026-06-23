// What each harness can actually do, declared in one place instead of implied
// by silent no-ops scattered across the runtimes, the controller, and the UI.
// The controller, the prompt assembler, and the settings UI all READ this —
// adding a harness is one entry here plus one `send()` implementation.

export type AgentHarness = "pi" | "codex" | "claude";

/** GAIA daemon tools an agent can be granted, beyond plain file/shell access. */
export type GaiaTool = "memory" | "recall" | "summon";

export interface HarnessCapabilities {
  /**
   * Which gaia daemon tools (memory/recall/summon) this harness can wire into a
   * session. The agent's configured tools are intersected with this; anything
   * outside it is simply unavailable under this harness — and the agent's
   * system prompt + the settings UI are told so, rather than the agent
   * discovering a 401 at runtime.
   */
  readonly gaiaTools: readonly GaiaTool[];
  /**
   * True when the harness honors the granular per-tool permission array
   * (read/write/edit/bash). False for harnesses that run a coarse or fixed
   * sandbox (Codex), where the `tools` array is ignored — so the UI hides it.
   */
  readonly granularTools: boolean;
}

export const HARNESS_CAPABILITIES: Record<AgentHarness, HarnessCapabilities> = {
  pi: { gaiaTools: ["memory", "recall", "summon"], granularTools: true },
  claude: { gaiaTools: ["memory", "recall", "summon"], granularTools: true },
  // The persistent app-server is shared across rooms, so room-coupled recall/
  // summon can't be wired (only room-independent memory); and Codex runs a
  // coarse sandbox rather than honoring a granular per-tool array.
  codex: { gaiaTools: ["memory"], granularTools: false },
};

/** Capabilities for a harness id, falling back to Pi's for an unknown harness. */
export function capabilitiesFor(harness: string): HarnessCapabilities {
  return HARNESS_CAPABILITIES[harness as AgentHarness] ?? HARNESS_CAPABILITIES.pi;
}
