// Harness capability *types*. The capability data and the per-harness lookups
// live with each harness (its `runtime/<x>.ts` declares them and registers them
// via harness-registry.ts). This module is intentionally value-free so the
// runtimes and the registry can import these types without an import cycle.

/** A harness id. Open by design: any registered harness is valid (see harness-registry.ts). */
export type AgentHarness = string;

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
  /**
   * True when the harness honors the `permissionMode` posture knob (Claude
   * Code's `--permission-mode`). The settings UI hides that field for harnesses
   * with no equivalent — derived from this flag, never from the harness id.
   */
  readonly supportsPermissionMode: boolean;
}
