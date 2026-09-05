import { readJson, writeJsonAtomic } from "../../core/store.js";
import type { AgentDef, AgentModelConfig, SlashCommandDefinition } from "../../core/types.js";
import type { ContextDietOverrides } from "../../domain/context-diet.js";
import { effectiveAgentSkills, effectiveRoleName, listAgentRoles, resolveAgentRole } from "../../domain/roles.js";
import { resolveSkillRefs } from "../../domain/skills.js";
import type { ContextDietView } from "../../harness/spec.js";
import { findHarness, harnessIdFor, nativeCommandsFor } from "../../harness/spec.js";
import { SLASH_COMMANDS, validateThinkingLevel } from "../commands.js";
import { addArchtreeRoot } from "../archtree.js";
import { sdkThinkingLevels } from "../hints.js";

/** Agent configuration command cohort: native-command target/palette, role
 * skill resolution, /roles /role, /thinking (room + per-agent), /diet view +
 * set, /model, /summon. Split from room-service.ts (Pascal 2026-09-02 A6). */
export class RoomAgentCommandsMixin {
  [key: string]: any;

  // --- harness-native commands (passthrough) ------------------------------------

  /** The agent a bare `/native-command` routes to: whoever the room is actively
   * addressing, else the workspace default. */
  async nativeCommandTarget(): Promise<string> {
    const state = await this.room.state();
    const active = state.activeAgent;
    if (active && this.workspace.agents[active]) return active;
    return this.workspace.config.defaultAgent;
  }

  /** The native (fileless-builtin) command names this agent has CHECKED as
   * skills — the derived replacement for the old `nativeCommands` toggle. Empty
   * unless the harness supports native commands. Lowercased. */
  /** The active role's skill grants for an agent (empty when no role active) —
   * merged into the native-command check so a role can enable a builtin too. */
  private async activeRoleSkills(agentId: string, agent: AgentDef): Promise<string[]> {
    const roleName = effectiveRoleName((await this.room.state()).activeRoles, agent);
    const role = roleName ? await resolveAgentRole(agent, roleName) : undefined;
    return effectiveAgentSkills(agent, role);
  }

  private agentNativeSkillNames(agent: AgentDef, skillNames: string[], onDiskLower: Set<string>): Set<string> {
    if (skillNames.length === 0) return new Set();
    const harnessId = harnessIdFor(agent, this.workspace);
    // findHarness (not capabilitiesFor) so an unregistered harness yields "no
    // native support" instead of throwing — the palette runs even mid-boot.
    if (!findHarness(harnessId)?.capabilities.supportsNativeCommands) return new Set();
    // A native command routes only if it is FILELESS. The resolved on-disk set
    // comes from this agent's effective skills, so the palette never does a
    // second registry scan or advertises a builtin over a loaded SKILL.md.
    const native = new Set(nativeCommandsFor(harnessId).map((command) => command.name.toLowerCase()).filter((name) => !onDiskLower.has(name)));
    return new Set(skillNames.map((skill) => skill.toLowerCase()).filter((name) => native.has(name)));
  }

  /** The `/`-command palette: daemon builtins, harness-fileless commands, and
   * plugins. Pi owns discovery and slash-command presentation for SKILL.md
   * commands; Gaia only forwards a typed native command to Pi's SDK. */
  private async paletteCommands(): Promise<SlashCommandDefinition[]> {
    const seen = new Set(SLASH_COMMANDS.map((command) => command.name));
    const dynamic: SlashCommandDefinition[] = [];
    const agentDefs = this.workspace.agents as Record<string, AgentDef>;
    const agents = await Promise.all(
      Object.values(agentDefs).map(async (agent) => ({
        agent,
        harnessId: harnessIdFor(agent, this.workspace),
        skillNames: await this.activeRoleSkills(agent.id, agent),
      })),
    );
    for (const { agent, harnessId, skillNames } of agents) {
      if (!findHarness(harnessId)?.capabilities.supportsNativeCommands) continue;
      // Fileless builtins remain daemon palette entries; on-disk skills belong
      // exclusively to Pi's own command surface and are never advertised here.
      const onDisk = new Set(resolveSkillRefs(this.workspace, skillNames).skills.map((skill) => skill.name.toLowerCase()));
      const checked = this.agentNativeSkillNames(agent, skillNames, onDisk);
      for (const command of nativeCommandsFor(harnessId)) {
        const name = command.name.toLowerCase();
        if (!checked.has(name) || seen.has(command.name)) continue;
        seen.add(command.name);
        dynamic.push({ name: command.name, type: "native", description: command.description, native: true });
      }
    }
    for (const [name, plugin] of (await this.commandPlugins()).entries()) {
      if (seen.has(name)) continue;
      seen.add(name);
      dynamic.push({ name, type: "native", description: plugin.description ?? "", native: true });
    }
    return dynamic.length ? [...SLASH_COMMANDS, ...dynamic] : SLASH_COMMANDS;
  }

  async renderAgentsList(): Promise<string> {
    const state = await this.room.state();
    const agentDefs = this.workspace.agents as Record<string, AgentDef>;
    return Object.values(agentDefs)
      .map((agent) => {
        const defaultMark = agent.id === this.workspace.config.defaultAgent ? " (default)" : "";
        const roleName = effectiveRoleName(state.activeRoles, agent);
        const fromGlobalDefault = state.activeRoles[agent.id] === undefined && roleName !== undefined;
        const role = roleName ? ` [role: ${roleName}${fromGlobalDefault ? " (global default)" : ""}]` : "";
        return `${agent.icon} @${agent.id}${defaultMark}${role} - ${agent.displayName} [tools: ${agent.tools.join(", ") || "none"}]`;
      })
      .join("\n");
  }

  async renderRoles(agentId: string | undefined): Promise<string> {
    if (!agentId) return "Usage: /roles <agent>";
    const agent = this.workspace.agents[agentId];
    if (!agent) return this.unknownAgentMessage(agentId);
    const roles = await listAgentRoles(agent);
    if (roles.length === 0) return `No roles found for @${agent.id}. Add files under ${agent.rolesDir}`;
    const state = await this.room.state();
    const activeRole = state.activeRoles[agent.id];
    return roles.map((role) => `${role === activeRole ? "*" : "-"} ${role}${role === activeRole ? " (active)" : ""}`).join("\n");
  }

  async setRole(agentId: string | undefined, role: string | undefined): Promise<string> {
    if (!role) return "Usage: /role [agent] <role|none|default>";
    const targetId = agentId ?? this.workspace.config.defaultAgent;
    const agent = this.workspace.agents[targetId];
    if (!agent) return this.unknownAgentMessage(targetId);

    // "none" is an explicit no-role override for this room; "default" (or empty)
    // removes the override so the room inherits the agent's global default role.
    if (role === "none") {
      await this.room.updateState((state: any) => {
        state.activeRoles[agent.id] = "none";
      });
      await this.emitSnapshot();
      return `Cleared role for @${agent.id} in this room.`;
    }

    if (role === "default") {
      await this.room.updateState((state: any) => {
        delete state.activeRoles[agent.id];
      });
      await this.emitSnapshot();
      return `@${agent.id} now inherits its global default role in this room.`;
    }

    const roles = await listAgentRoles(agent);
    if (!roles.includes(role)) {
      return `Unknown role for @${agent.id}: ${role}\nAvailable roles: ${roles.length > 0 ? roles.join(", ") : "none"}`;
    }
    await this.room.updateState((state: any) => {
      state.activeRoles[agent.id] = role;
    });
    await this.emitSnapshot();
    return `Set @${agent.id} role to ${role}.`;
  }

  async runThinkingCommand(agentId: string | undefined, level: string | undefined): Promise<string> {
    const target = agentId ?? this.workspace.config.defaultAgent;
    const agent = this.workspace.agents[target];
    if (!agent) return this.unknownAgentMessage(target);
    if (!level) {
      const state = await this.room.state();
      const effective = state.thinkingOverrides[agent.id] ?? agent.thinking ?? "off";
      return `Usage: /thinking [agent] <${sdkThinkingLevels().join("|")}>\n@${agent.id} thinking is ${effective}.`;
    }
    try {
      // Routes through the daemon closure so an active voice CALL still gets
      // call-scoped thinking (reverts on hang-up); the non-call path resolves
      // to THIS room's scope via daemon.applyThinking → setRoomThinking below.
      if (this.options.setThinking) return await this.options.setThinking(agent.id, level);
      return await this.setRoomThinking(agent.id, level);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** Room-wide GAIA-THINK protocol level (`/thinking N`, 0-10; `off`=0).
   * Distinct from the per-agent SDK reasoning-effort override above: this is a
   * single room value written to RoomState.thinkingLevel that drives the
   * `# Protocols` section's thinking line for EVERY agent. Rejects out-of-range
   * (existing validation style). The level rides in the system prompt via
   * promptCacheKey, so it takes effect on each agent's next turn. */
  async runThinkingLevelCommand(level: number): Promise<string> {
    const error = validateThinkingLevel(level);
    if (error) return error;
    await this.room.updateState((state: any) => {
      if (level === 0) delete state.thinkingLevel;
      else state.thinkingLevel = level;
    });
    await this.emitSnapshot();
    return level === 0
      ? "Thinking disabled for this room (GAIA-THINK level 0)."
      : `Set GAIA-THINK level to ${level}/10 for this room.`;
  }

  /** Context-diet policy for this room (effective = workspace default + this
   * room's override) plus the room's raw override document, for display. The
   * daemon-side half of BOTH the `diet` gaia-tool verb and the `/diet` room
   * command — one implementation, two surfaces (Pascal 2026-08-21). */
  async dietView(): Promise<ContextDietView> {
    const [effective, roomOverrides] = await Promise.all([
      this.dietPolicyStore.effective(this.roomId),
      this.dietPolicyStore.roomOverrides(this.roomId),
    ]);
    return { effective, roomOverrides };
  }

  /** Patch the workspace default or this room's override; returns the new view. */
  async dietSet(params: { scope: "room" | "workspace"; patch: ContextDietOverrides }): Promise<ContextDietView> {
    if (params.scope === "workspace") await this.dietPolicyStore.patchWorkspace(params.patch);
    else await this.dietPolicyStore.patchRoom(this.roomId, params.patch);
    return this.dietView();
  }

  private static formatDietPolicy(policy: ContextDietView["effective"]): string {
    return `preset=${policy.preset ? "on" : "off"}, fullTurnWindow=${policy.fullTurnWindow}, toolTailLines=${policy.toolTailLines}, keepAllToolCalls=${policy.keepAllToolCalls}`;
  }

  /** /diet on|off|status [--workspace]: toggles render-time context-diet decay
   * (see harness/prompt.ts renderRoomTranscript). Default OFF, IRON — nothing
   * about a room's rendering changes until this (or the gaia-tool `diet`
   * verb) is run. */
  async runDietCommand(sub: "on" | "off" | "status", scope: "room" | "workspace"): Promise<string> {
    if (sub === "status") {
      const view = await this.dietView();
      const override = Object.keys(view.roomOverrides).length ? ` (room override: ${JSON.stringify(view.roomOverrides)})` : "";
      return `Context-diet for this room: ${RoomAgentCommandsMixin.formatDietPolicy(view.effective)}${override}`;
    }
    const view = await this.dietSet({ scope, patch: { preset: sub === "on" } });
    const target = scope === "workspace" ? "this workspace (default for every room without its own override)" : "this room";
    return `Context-diet ${sub === "on" ? "enabled" : "disabled"} for ${target}. Effective: ${RoomAgentCommandsMixin.formatDietPolicy(view.effective)}.`;
  }

  /** Room-scoped thinking override (mirrors setRole): writes ONLY
   * state.thinkingOverrides via room state, never agent.json, and never
   * respawns runners — the harness reads the resolved value per-turn
   * (runAgentTurn input.thinking). "" clears the override, reverting this
   * room to the agent's global default (agent.thinking). */
  async setRoomThinking(agentId: string, level: string): Promise<string> {
    const levels = sdkThinkingLevels();
    if (level !== "" && !levels.includes(level)) {
      throw new Error(`Invalid thinking level: ${level}. Use one of: ${levels.join(", ")}`);
    }
    const agent = this.workspace.agents[agentId];
    if (!agent) throw new Error(this.unknownAgentMessage(agentId));

    await this.room.updateState((state: any) => {
      if (level === "") delete state.thinkingOverrides[agent.id];
      else state.thinkingOverrides[agent.id] = level;
    });
    await this.emitSnapshot();
    if (level === "") return `Cleared @${agent.id} room thinking (using global default ${agent.thinking ?? "off"}).`;
    return `Set @${agent.id} thinking to ${level} for this room.`;
  }

  /** Persists an agent's thinking level to the effective agent.json (project
   * override wins). The in-place mutation updates THIS process's snapshot;
   * the settingsChanged reload is what carries it into the runner
   * subprocesses (they snapshot agent.json at spawn). */
  async setAgentThinking(agentId: string, level: string): Promise<string> {
    const levels = sdkThinkingLevels();
    if (level !== "" && !levels.includes(level)) {
      throw new Error(`Invalid thinking level: ${level}. Use one of: ${levels.join(", ")}`);
    }
    const agent = this.workspace.agents[agentId];
    if (!agent) throw new Error(this.unknownAgentMessage(agentId));

    const configPath = agent.projectConfigPath ?? agent.configPath;
    const config = ((await readJson(configPath)) ?? {}) as Record<string, unknown>;
    if (level === "") delete config.thinking;
    else config.thinking = level;
    await writeJsonAtomic(configPath, config);

    agent.thinking = level === "" ? undefined : (level as AgentDef["thinking"]);
    await this.emitSnapshot();
    await this.reloadAfterAgentConfigWrite(agent);
    return `Set @${agent.id} thinking to ${level || "unset"}.`;
  }

  /** After a command rewrites agent.json: rebuild the affected services so
   * live runners respawn on the NEW config. Runners are subprocesses that
   * read agent.json once at spawn — without this, /model and /thinking only
   * changed the chip, never the next turn (the bug where /model opus kept
   * running fable). The reload defers while a turn runs and harness sessions
   * resume from their on-disk stores, so the conversation continues. */
  private async reloadAfterAgentConfigWrite(agent: AgentDef): Promise<void> {
    await this.options.settingsChanged?.(agent.projectConfigPath ? "workspace" : "global");
  }

  async runModelCommand(agentId: string | undefined, spec: string | undefined): Promise<string> {
    const target = agentId ?? this.workspace.config.defaultAgent;
    const agent = this.workspace.agents[target];
    if (!agent) return this.unknownAgentMessage(target);
    const current = agent.model ? `${agent.model.provider ?? "?"}/${agent.model.name ?? "?"}` : "workspace default";
    if (!spec) {
      return `Usage: /model [agent] <provider/name> (or "none" to clear)\n@${agent.id} model is ${current}.`;
    }
    try {
      return await this.setAgentModel(agent.id, spec);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  /** Persists an agent's model to the effective agent.json (project override
   * wins). "none"/"default"/"off" clears the override, falling back to the
   * workspace default. A bare name keeps the current provider;
   * "provider/name" sets both. The settingsChanged reload carries the change
   * into the runner subprocesses — the manual pick sticks until the next
   * /model, while a provider-side auto-reroute (fable → opus safeguard)
   * stays per-message and never rewrites this config. */
  async setAgentModel(agentId: string, spec: string): Promise<string> {
    const agent = this.workspace.agents[agentId];
    if (!agent) throw new Error(this.unknownAgentMessage(agentId));

    const configPath = agent.projectConfigPath ?? agent.configPath;
    const config = ((await readJson(configPath)) ?? {}) as Record<string, unknown>;

    if (["none", "default", "off", ""].includes(spec.toLowerCase())) {
      delete config.model;
      await writeJsonAtomic(configPath, config);
      agent.model = undefined;
      await this.emitSnapshot();
      await this.reloadAfterAgentConfigWrite(agent);
      return `Cleared @${agent.id} model override — using workspace default. Applies from the next turn (the session continues).`;
    }

    // A bare <name> keeps the agent's current provider, else the one its
    // HARNESS declares as data (lockedProvider / first modelProviderIds entry).
    // Never a hardcoded provider: guessing one harness's world here would
    // silently mis-provider every other harness (RULE #0).
    const slash = spec.indexOf("/");
    const harnessUi = findHarness(harnessIdFor(agent, this.workspace))?.ui;
    const defaultProvider = agent.model?.provider ?? harnessUi?.lockedProvider ?? harnessUi?.modelProviderIds?.[0];
    if (slash <= 0 && !defaultProvider) throw new Error(`Invalid model: ${spec}. Use <provider/name> — @${agent.id}'s harness declares no default provider.`);
    const model: AgentModelConfig =
      slash > 0 ? { provider: spec.slice(0, slash), name: spec.slice(slash + 1) } : { provider: defaultProvider!, name: spec };
    if (!model.name) throw new Error(`Invalid model: ${spec}. Use <name> or <provider/name>.`);

    config.model = model;
    await writeJsonAtomic(configPath, config);
    agent.model = model;
    await this.emitSnapshot();
    await this.reloadAfterAgentConfigWrite(agent);
    return `Set @${agent.id} model to ${model.provider}/${model.name}. Applies from the next turn (the session continues).`;
  }

  async runSummonCommand(agentId: string | undefined, task: string | undefined): Promise<string> {
    if (!this.options.summonHost) return "Summon system is not available.";
    if (!agentId || !task) return "Usage: /summon <agent> <task>";
    const agent = this.workspace.agents[agentId];
    if (!agent) return this.unknownAgentMessage(agentId);
    // Human-initiated: the result comes back as a note in THIS room (no agent
    // turn to trigger — the human reads it).
    const childRoomId = await this.options.summonHost.summon(this.roomId, agent.id, task, { deliver: "note" });
    return `Summoned @${agent.id} in room '${childRoomId}'. Open it from the rooms list (under this room) to watch or steer; its result will be posted back here when it finishes.`;
  }
  async runArchtreeCommand(agentId: string | undefined, task: string | undefined): Promise<string> {
    if (!this.options.summonHost) return "Archtree is unavailable because the summon system is unavailable.";
    if (!task) return "Usage: /archtree add-root [--agent <agent>] <task>";
    const target = agentId ?? (await this.nativeCommandTarget());
    if (!this.workspace.agents[target]) return this.unknownAgentMessage(target);
    const childRoomId = await addArchtreeRoot(this.options.summonHost, { workspace: this.workspace, parentRoomId: this.roomId, agentId: target, task });
    return `Added archtree root @${target} in room '${childRoomId}'. It is live under this coordinator and visible in /archtree.`;
  }
}

export function installRoomAgentCommands(target: object): void {
  for (const name of Object.getOwnPropertyNames(RoomAgentCommandsMixin.prototype)) {
    if (name === "constructor") continue;
    Object.defineProperty(target, name, Object.getOwnPropertyDescriptor(RoomAgentCommandsMixin.prototype, name)!);
  }
}
