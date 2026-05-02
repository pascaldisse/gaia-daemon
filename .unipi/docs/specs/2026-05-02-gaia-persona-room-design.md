---
title: "GAIA Persona Room"
type: brainstorm
date: 2026-05-02
---

# GAIA Persona Room

## Problem Statement

GAIA should become a natural terminal room for brainstorming, researching, and planning with persistent agent-personas.

The core problem is not “run many tools” or “clone a coding agent.” The core problem is making agent collaboration feel like talking to durable characters in a shared room, while still preserving hard technical control over models, tools, runtimes, and future safety boundaries.

The first proof of concept should optimize for a thinking room: Gaia for shaping ideas, Sidia for critique, Terry for implementation when the plan is ready.

## Context

The current project already has a useful first shape:

- global agents under `~/.gaia/agents/`
- project context under `.gaia/` and `AGENTS.md`
- deterministic `@agent` routing
- shared room transcript
- Pi runtime
- per-agent memory
- simple terminal UI
- slash command and agent previews

The code also has unresolved future scaffolding:

- `skills` exists in config but is not loaded
- `public` has no runtime meaning
- `PiRuntime.send()` currently creates a fresh Pi session/loader per message
- room transcript is manually injected every turn
- tests are missing

NanoClaw was reviewed as inspiration. Its useful lessons are the seams, not the full architecture:

- separate durable agent identity from session state
- separate shared room history from private agent runtime continuity
- use runtime/provider seams
- keep container isolation as a future runtime boundary
- avoid copying the full channel/container/SQLite host system into this MVP

Pi already has an Agent Skills system. Pi skills are on-demand instruction packages discovered by a `ResourceLoader`, exposed in the system prompt as available skills, and loaded by the model through `read` when relevant or forced by `/skill:name`. Skills do not grant tools. Tools remain hard runtime control.

## Chosen Approach

Use a tiny hybrid spine:

- keep the terminal room and current local-first file model
- clarify concepts around hard control and soft control
- use Pi’s skill mechanism instead of implementing a GAIA skill engine
- use persistent Pi sessions per room-agent pair
- add role-driven prompt overlays and skill filtering
- keep containers, subagents, and multi-channel infrastructure out of scope for now

Concept definitions:

- **Agent** = hard control. Runtime, model, tools, safety boundary, sandbox later.
- **Persona** = soft control. Identity, voice, behavior, memory. Lives inside the agent folder.
- **Role** = soft-control overlay. A role is a system prompt overlay plus a collection of selected skills.
- **Room** = shared conversation surface. Transcript, participants, active role state.
- **AgentRoomSession** = one persistent runtime session for one agent in one room.
- **Runtime** = execution backend. Pi now, containers/providers later.

## Why This Approach

This approach protects the main selling point: natural communication with durable personalities.

It rejects a NanoClaw-style infrastructure rewrite for now because that would add containers, SQLite session mailboxes, channel adapters, host sweeps, and provider machinery before the core room feeling is proven.

It also rejects prompt-only fake skills. Pi already supports skills through `DefaultResourceLoader`, `additionalSkillPaths`, and `skillsOverride`. GAIA should decide which skills are visible to an agent/role, then let Pi handle the skill protocol.

The key decision is the split between hard and soft control:

- roles and personas may guide behavior
- only agents grant actual tools and runtime power

This prevents a research role from silently escalating permissions. A role can request research behavior and expose research skills, but an agent without web/search tools still cannot browse.

## Design

### Folder Model

Global GAIA home:

```text
~/.gaia/
  skills/
    brainstorm/SKILL.md
    research/SKILL.md
    planning/SKILL.md

  agents/
    gaia/
      agent.json
      persona/
        SOUL.md
        MEMORY.md
        roles/
          brainstorm.md
          research.md
          plan.md
```

Project workspace:

```text
project/
  AGENTS.md
  .gaia/
    config.json
    skills/
      project-research/SKILL.md

    agents/
      gaia/
        agent.json
        persona/
          INTENT.md
          roles/
            research.md

    rooms/
      default/
        state.json
        transcript.jsonl
```

Rules:

- each agent owns its persona folder
- `agent.json` is hard control
- `persona/` is soft control
- global roles define stable behavior
- project role files append local role-specific behavior
- global skills live in `~/.gaia/skills/`
- project skills live in `.gaia/skills/`
- when global and project skills share a name, the project skill wins

### Agent Configuration

`agent.json` should describe hard control:

```json
{
  "id": "gaia",
  "displayName": "Gaia",
  "icon": "☀️",
  "runtime": "pi",
  "model": {},
  "thinking": "medium",
  "tools": ["read", "memory"]
}
```

Future hard-control fields may include sandbox/container configuration, allowed mounts, provider-specific options, or tool policies.

### Persona and Roles

`persona/SOUL.md` is the durable identity.

`persona/MEMORY.md` is durable memory for that agent-persona.

A role file is markdown with optional frontmatter:

```md
---
skills:
  - research
  - source-synthesis
---

# Research Role

Investigate carefully.
Prefer sources.
Separate facts from guesses.
Name uncertainty clearly.
```

The role body becomes a system prompt overlay. The listed skills are resolved from GAIA’s central skill libraries and passed to Pi as the active skill set for that agent session.

### Room State

Active roles are room-local and persistent:

```json
{
  "activeRoles": {
    "gaia": "research",
    "sidia": "critic"
  },
  "agentCursors": {
    "gaia": 42,
    "sidia": 39
  },
  "piSessions": {
    "gaia": "pi-session-id-or-file",
    "sidia": "pi-session-id-or-file"
  }
}
```

This lets Gaia be in research role in one room and brainstorm role in another room. Role state is not global personality state.

### Runtime Sessions

GAIA should maintain one persistent Pi session per room-agent pair:

```text
room default + @gaia  -> Pi AgentSession A
room default + @sidia -> Pi AgentSession B
room default + @terry -> Pi AgentSession C
```

This is better than the current fresh-session-per-message behavior because it preserves agent continuity, enables future steering/follow-up behavior, and avoids repeated setup work.

It is also better than one Pi session per room because each agent has different persona, role, tools, model, and runtime configuration.

### Prompt Assembly

For each agent turn, the runtime should assemble:

```text
agent/persona/SOUL.md
+ active role prompt
+ project persona/INTENT.md
+ project role overlay, if present
+ AGENTS.md project context
+ MEMORY.md
+ room events since this agent last responded
+ newest user message
```

GAIA should avoid repeatedly injecting the full recent transcript into a persistent Pi session. Instead, each `AgentRoomSession` should track a room transcript cursor and send only new room events since that agent last participated.

The GAIA transcript remains shared room truth. The Pi session remains private continuity for one agent in that room.

### Skill Loading Through Pi

GAIA should not implement its own skill protocol.

Instead:

1. read active role frontmatter
2. resolve listed skill names to concrete `SKILL.md` paths
3. create or update the Pi `DefaultResourceLoader`
4. expose only those skills through `additionalSkillPaths` or `skillsOverride`
5. let Pi format available skills and expand `/skill:name`

On role change, GAIA should update room state and refresh the affected `AgentRoomSession`.

Preferred path:

- use a mutable role/skill filter consumed by `skillsOverride`
- call `AgentSession.reload()` so Pi rebuilds resources/system prompt

Fallback path:

- dispose the affected Pi session
- recreate it for the same room-agent pair
- preserve GAIA room state and transcript cursor

Role changes apply to the next turn, not to an already-running model call.

### Builder UX

Use CLI scaffold plus file editing.

MVP builder style:

```text
gaia agent create
```

It scaffolds:

- agent folder
- `agent.json`
- `persona/SOUL.md`
- `persona/MEMORY.md`
- starter roles

Deep editing happens in files. The room only needs lightweight role controls:

```text
/agents
/roles gaia
/role gaia research
/role gaia none
```

### Error Handling

- unknown agent mention: fail loudly with available agents
- unknown role: show available roles for that agent
- unknown skill in role frontmatter: warn clearly and omit that skill from Pi loader
- duplicate skill name: project skill wins over global skill
- Pi reload failure: recreate the affected AgentRoomSession if safe; otherwise show error and keep old session
- missing persona files: startup/init should repair defaults where safe, but avoid overwriting user edits
- invalid role frontmatter: ignore frontmatter, use markdown body, show warning

### Testing

Use zero-dependency or low-dependency tests before large refactors.

High-value coverage:

- role frontmatter parsing
- global + project role overlay resolution
- global + project skill resolution with project-wins rule
- room state read/write
- active role command parsing
- mention routing
- prompt assembly without duplicate transcript injection
- persistent AgentRoomSession lifecycle with mocked Pi runtime
- fallback behavior when Pi reload fails

## Implementation Checklist

- [x] Define updated file model and migration strategy for agent-owned `persona/` folders.
- [x] Add role file parsing with optional `skills` frontmatter.
- [x] Add global + project skill resolution with project-wins collision behavior.
- [x] Add room-local `state.json` for active roles, transcript cursors, and Pi session metadata.
- [x] Refactor runtime around persistent `AgentRoomSession` per room-agent pair.
- [x] Connect active role skills to Pi `DefaultResourceLoader` via explicit skill paths or `skillsOverride`.
- [x] Implement role commands: `/roles <agent>`, `/role <agent> <role>`, `/role <agent> none`.
- [x] Update prompt assembly to use role overlays and room events since agent cursor.
- [x] Add CLI scaffold command for creating agents with persona folders and starter roles.
- [x] Add tests for routing, role parsing, skill resolution, room state, and runtime lifecycle.
- [x] Update README and plan docs to reflect hard-control vs soft-control architecture.

## Open Questions

- What exact Pi session identifier/file should GAIA store for durable room-agent continuity?
- Can `AgentSession.reload()` safely update skills/system prompt for the next turn in all needed cases, or should role changes recreate the session?
- Should `MEMORY.md` remain global-only for now, or should projects get optional local memory later?
- Should role names be freeform filenames, or validated like skill names?
- Should `/role gaia none` mean no role overlay, or a default role from agent config?
- Should central GAIA skills be copied from Pi skills, referenced from Pi skills, or authored directly under `~/.gaia/skills/`?

## Out of Scope

- containers and sandboxed runtimes
- NanoClaw-style SQLite message mailboxes
- channel adapters and multi-platform messaging
- subagents/background workers
- natural-language role switching
- web UI
- full marketplace/package system
- automatic role inference
