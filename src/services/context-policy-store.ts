// Context-diet policy store (09-MEMORY-CONTEXT, ported from v2's
// services/context/policy-store.ts): two-tier file-backed config — a
// workspace-wide default (.gaia/context-diet.json) and a per-room override
// (.gaia/rooms/<id>/context-diet.json) — merged into one effective policy.
// Same knob names v2 used (preset, keepAllToolCalls, fullTurnWindow,
// toolTailLines); v1-shaped storage (workspacePaths, readJson/writeJsonAtomic
// from core/store.ts) instead of v2's separate global/room revisioned
// documents — the daemon here serves one workspace at a time, so "global"
// means "this workspace's default", not "every workspace on the machine".
//
// Default is OFF (IRON, Pascal 2026-08-21): an empty/missing policy file at
// either tier resolves to DEFAULT_CONTEXT_DIET_POLICY (preset:false), so a
// fresh install or an untouched room renders identically to pre-diet gaia.

import { readJson, writeJsonAtomic } from "../core/store.js";
import { workspacePaths } from "../core/paths.js";
import {
  DEFAULT_CONTEXT_DIET_POLICY,
  mergeContextDietPolicy,
  parseContextDietOverrides,
  parseContextDietPolicy,
  type ContextDietOverrides,
  type ContextDietPolicy,
} from "../domain/context-diet.js";

export class ContextPolicyStore {
  constructor(private readonly rootDir: string) {}

  /** This workspace's default policy (fully resolved — missing file = DEFAULT_CONTEXT_DIET_POLICY). */
  async workspace(): Promise<ContextDietPolicy> {
    return parseContextDietPolicy(await readJson(workspacePaths.contextDietPolicy(this.rootDir)));
  }

  /** Raw per-room override document (possibly {} — a room with no overrides file has none). */
  async roomOverrides(roomId: string): Promise<ContextDietOverrides> {
    return parseContextDietOverrides(await readJson(workspacePaths.roomContextDietPolicy(this.rootDir, roomId)));
  }

  /** Workspace default layered with this room's overrides — what a turn actually uses. */
  async effective(roomId: string): Promise<ContextDietPolicy> {
    const [base, overrides] = await Promise.all([this.workspace(), this.roomOverrides(roomId)]);
    return mergeContextDietPolicy(base, overrides);
  }

  /** Patch the workspace default (partial — only named fields change), returns the new effective-at-workspace-level policy. */
  async patchWorkspace(patch: ContextDietOverrides): Promise<ContextDietPolicy> {
    const current = await this.workspace();
    const next = mergeContextDietPolicy(current, patch);
    await writeJsonAtomic(workspacePaths.contextDietPolicy(this.rootDir), next);
    return next;
  }

  /** Replace the workspace default wholesale. */
  async setWorkspace(policy: ContextDietPolicy): Promise<ContextDietPolicy> {
    const next = parseContextDietPolicy(policy, DEFAULT_CONTEXT_DIET_POLICY);
    await writeJsonAtomic(workspacePaths.contextDietPolicy(this.rootDir), next);
    return next;
  }

  /** Patch this room's override document (partial), returns the room's new effective policy. */
  async patchRoom(roomId: string, patch: ContextDietOverrides): Promise<ContextDietPolicy> {
    const current = await this.roomOverrides(roomId);
    const next: ContextDietOverrides = { ...current, ...patch };
    await writeJsonAtomic(workspacePaths.roomContextDietPolicy(this.rootDir, roomId), next);
    return this.effective(roomId);
  }

  /** Clear this room's overrides entirely — falls back to the workspace default. */
  async clearRoom(roomId: string): Promise<ContextDietPolicy> {
    await writeJsonAtomic(workspacePaths.roomContextDietPolicy(this.rootDir, roomId), {});
    return this.effective(roomId);
  }
}
