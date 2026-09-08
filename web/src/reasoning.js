// Pure model-reasoning view logic, shared by the composer thinking control and
// any settings surface. Consumes the daemon's ModelReasoningDescriptor union
// (AgentStatus.reasoning) and NEVER invents a level list: an "unknown"-capability
// model advertises no menu at all, and a model with no reasoning renders nothing.
// The universal 7-level list only survives as a strictly transitional fallback
// for pre-descriptor snapshots (descriptor entirely absent), passed in by the
// caller — never synthesized here for a genuine "unknown" descriptor.

/** @typedef {import("./types.js").AgentStatus} AgentStatus */
/** @typedef {import("./types.js").ModelReasoningDescriptor} ModelReasoningDescriptor */
/** @typedef {import("./types.js").ThinkingLevel} ThinkingLevel */

/**
 * Read the reasoning descriptor off an agent status. The field is added to the
 * daemon's AgentStatus by the backend in parallel; the cast keeps web/src
 * typechecking whether or not that landed yet (structurally compatible once it
 * does).
 * @param {AgentStatus} agent
 * @returns {ModelReasoningDescriptor|undefined}
 */
export function agentReasoning(agent) {
  return /** @type {{ reasoning?: ModelReasoningDescriptor }} */ (agent).reasoning;
}

/**
 * The distinct effective view a control renders from.
 * - state "none"    → model supports no reasoning; render no control.
 * - state "unknown" → capability undiscovered; show the requested level as an
 *                     unverified indicator, offer NO level menu (no invented list).
 * - state "known"   → `available` are the model's real levels (choices), the
 *                     ONLY menu options; `diverged` marks requested≠effective.
 * - `legacy` flags the transitional descriptor-absent fallback.
 * @typedef {Object} ReasoningView
 * @property {"none"|"unknown"|"known"} state
 * @property {string[]} available   Level ids offered as menu options.
 * @property {string} requested     What agent.json / the room override asks for.
 * @property {string} [effective]   Descriptor-confirmed level; absent for call overrides/unknown.
 * @property {boolean} [unverified] Requested level only; effective unavailable.
 * @property {boolean} diverged     requested !== effective.
 * @property {string} [resolution]  "requested"|"inherited"|"conservative".
 * @property {string} [source]      "discovered"|"override".
 * @property {boolean} [adaptive]   Diagnostic only; read-only.
 * @property {string} [defaultLevel] The model's default level, if any.
 * @property {boolean} [legacy]     Descriptor absent → universal fallback.
 */

/**
 * Build the render view. `requestedFallback` is the caller's best guess at the
 * requested level (agent.thinking, or a voice-call override) used when the
 * descriptor omits requestedLevel. `legacyLevels` is the universal list, applied
 * ONLY when the descriptor is entirely absent (pre-deploy snapshots).
 * @param {ModelReasoningDescriptor|undefined} desc
 * @param {string} requestedFallback
 * @param {string[]} [legacyLevels]
 * @param {string} [callOverride] Explicit call request; room effective is inapplicable.
 * @returns {ReasoningView}
 */
export function reasoningView(desc, requestedFallback, legacyLevels = [], callOverride) {
  const req = callOverride ?? (requestedFallback || "off");

  if (!desc) {
    // Transitional only: no descriptor at all. Behave as the old universal
    // control did so nothing regresses before the backend descriptor ships.
    return {
      state: legacyLevels.length ? "known" : "none",
      available: [...legacyLevels],
      requested: req,
      effective: callOverride === undefined ? req : undefined,
      unverified: callOverride !== undefined,
      diverged: false,
      legacy: true,
    };
  }

  if (desc.status === "unknown") {
    const requested = callOverride ?? desc.requestedLevel ?? req;
    return {
      state: "unknown",
      available: [],
      requested,
      unverified: true,
      diverged: false,
    };
  }

  // known
  const available = (desc.choices ?? []).map((choice) => choice.level);
  if (available.length === 0 || (available.length === 1 && available[0] === "off")) {
    return { state: "none", available: [], requested: req, effective: req, diverged: false };
  }
  const requested = callOverride ?? desc.requestedLevel ?? req;
  const effective = callOverride === undefined ? desc.effectiveLevel : undefined;
  return {
    state: "known",
    available,
    requested,
    effective,
    diverged: effective !== undefined && requested !== effective,
    unverified: effective === undefined,
    resolution: callOverride === undefined ? desc.resolution : undefined,
    source: desc.source,
    adaptive: desc.adaptive,
    defaultLevel: desc.defaultLevel,
  };
}

/**
 * The level to restore when toggling reasoning back ON: a remembered prior
 * level if it is still offered, else the model's default, else the current
 * effective (already model-valid), else the first non-off available level.
 * Never invents a level the model does not offer.
 * @param {ReasoningView} view
 * @param {string|undefined} remembered
 * @returns {string|undefined}
 */
export function reasoningReturnLevel(view, remembered) {
  /** @param {string|undefined} level */
  const offered = (level) => Boolean(level && level !== "off" && view.available.includes(level));
  if (offered(remembered)) return remembered;
  if (offered(view.defaultLevel)) return view.defaultLevel;
  if (offered(view.effective)) return view.effective;
  return view.available.find((level) => level !== "off");
}

/**
 * Toggle → offered targets only; unknown/always-on → no action.
 * @param {ReasoningView} view
 * @param {string} [remembered]
 * @returns {string|undefined}
 */
export function reasoningToggleTarget(view, remembered) {
  if (view.state !== "known" || !view.available.includes("off")) return undefined;
  const current = view.effective ?? view.requested;
  return current === "off" ? reasoningReturnLevel(view, remembered) : "off";
}
