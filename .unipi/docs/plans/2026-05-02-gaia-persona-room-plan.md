---
title: "GAIA Persona Room — Implementation Plan"
type: plan
date: 2026-05-02
workbranch: ""
specs:
  - .unipi/docs/specs/2026-05-02-gaia-persona-room-design.md
---

# GAIA Persona Room — Implementation Plan

## Overview

This plan turns GAIA into a cleaner persona-room proof of concept while staying on the current `main` branch.

The work keeps GAIA small and terminal-first. It introduces the hard-control/soft-control split, role-driven prompt overlays, central skill resolution, room-local role state, and persistent Pi sessions per room-agent pair. Containers, subagents, and NanoClaw-style DB mailboxes stay out of scope.

The implementation should proceed in thin vertical slices. Each slice should keep `npm run check` passing. Tests should be added around pure logic before or alongside refactors so runtime changes are safer.

## Tasks

- completed: Task 1 — Add Test Harness and Baseline Fixtures
  - Description: Add a minimal test setup using Node's built-in `node:test` and compiled JS or TypeScript execution, then create baseline fixtures for workspace, agent, role, skill, and room-state logic.
  - Dependencies: None
  - Acceptance Criteria:
    - `package.json` has a `test` script.
    - `npm run check` passes.
    - `npm test` runs at least one passing smoke test.
    - Tests do not require network access or real Pi auth.
  - Steps:
    1. Chose TypeScript test execution via existing `tsx` dev dependency.
    2. Added smoke coverage for mention routing and slash command parsing.
    3. Added reusable temp-directory helper for later workspace and GAIA_HOME tests.
    4. Verified with `npm run check` and `npm test`.

- completed: Task 2 — Migrate Agent File Model to Agent-Owned Persona Folders
  - Description: Update global and project agent loading so each agent folder owns a `persona/` subfolder. Preserve compatibility with existing `SOUL.md`, `MEMORY.md`, and `INTENT.md` where possible.
  - Dependencies: Task 1
  - Acceptance Criteria:
    - Fresh `gaia init` creates `~/.gaia/agents/<id>/agent.json` and `~/.gaia/agents/<id>/persona/{SOUL.md,MEMORY.md,roles/}`.
    - Existing legacy agents with `SOUL.md` and `MEMORY.md` still load or are safely migrated without overwriting user content.
    - Project intent is read from `.gaia/agents/<id>/persona/INTENT.md`, with a compatibility fallback for `.gaia/agents/<id>/INTENT.md` if desired.
    - Agent type definitions reflect hard-control fields and persona paths clearly.
    - Tests cover fresh init and legacy compatibility.
  - Steps:
    1. Extended `AgentDefinition` with `personaDir`, `rolesDir`, and project persona paths.
    2. Updated default agent seeding to create the new folder structure.
    3. Added non-destructive compatibility helpers for legacy global `SOUL.md` / `MEMORY.md`.
    4. Updated `loadAgentDefinitions()` to populate new paths.
    5. Removed misleading unused `public` and agent-level `skills` fields from the loaded definition.
    6. Added temp-dir tests for global defaults, legacy compatibility, project intent fallback, and `gaia init` with `GAIA_HOME`.

- completed: Task 3 — Implement Role Parsing and Resolution
  - Description: Add role support as persona-level soft control. A role is markdown with optional frontmatter containing `skills`. Global role files provide the base prompt; project role files append overlays.
  - Dependencies: Task 2
  - Acceptance Criteria:
    - Global role files are discovered from `~/.gaia/agents/<id>/persona/roles/*.md`.
    - Project role overlays are discovered from `.gaia/agents/<id>/persona/roles/*.md`.
    - A role resolver returns role name, global body, optional project body, merged prompt text, and requested skill names.
    - Invalid or absent frontmatter does not crash the app; the markdown body still loads and a warning can be surfaced.
    - Tests cover prompt merge order, missing roles, malformed frontmatter, and skill list parsing.
  - Steps:
    1. Created a small role module with dependency-free frontmatter parsing.
    2. Supported simple `skills:` lists and inline arrays.
    3. Resolved role names from safe markdown filenames.
    4. Merged global role prompt before project overlay prompt.
    5. Kept role skill lists deterministic and deduplicated in declaration order.

- completed: Task 4 — Implement Central Skill Library Resolution
  - Description: Add GAIA skill-library lookup without implementing a new skill engine. Resolve role-declared skill names to concrete Pi skill paths.
  - Dependencies: Task 3
  - Acceptance Criteria:
    - Global skills resolve from `~/.gaia/skills/<name>/SKILL.md`.
    - Project skills resolve from `.gaia/skills/<name>/SKILL.md`.
    - If both exist, project skill wins.
    - Unknown skills produce a warning/diagnostic and are omitted from the active Pi skill set.
    - The resolver returns explicit paths suitable for Pi `additionalSkillPaths` or `skillsOverride`.
    - Tests cover global-only, project-only, project-wins, unknown skill, and deterministic ordering.
  - Steps:
    1. Added `globalSkillsPath()` and project skills path helpers.
    2. Implemented `resolveSkillRefs(workspace, skillNames)`.
    3. Returned both resolved paths and diagnostics.
    4. Kept GAIA as a path resolver only; Pi still parses and executes skill behavior.

- completed: Task 5 — Add Room State for Active Roles and Agent Cursors
  - Description: Add `.gaia/rooms/<room>/state.json` as room-local state for active roles, transcript cursors, and future Pi session metadata.
  - Dependencies: Task 1
  - Acceptance Criteria:
    - Fresh `gaia init` creates or can lazily create room `state.json`.
    - Room state supports `activeRoles`, `agentCursors`, and `piSessions` keys.
    - Missing or partial state files merge with safe defaults.
    - Writes are atomic or otherwise safe enough for a local single-process MVP.
    - Tests cover read defaults, write/read roundtrip, partial state merge, and malformed state handling.
  - Steps:
    1. Added a `RoomState` type and store module.
    2. Added path helper for room state next to `transcript.jsonl`.
    3. Exposed state read/write through `Room` and create state during workspace init/load.
    4. Prepared state fields for role changes and cursor updates.
    5. Kept `piSessions` as a placeholder until Task 8 identifies the exact Pi persistence handle.

- completed: Task 6 — Add Role Room Commands and Status Display
  - Description: Add in-room commands for inspecting and switching active roles, using room-local state.
  - Dependencies: Task 3, Task 5
  - Acceptance Criteria:
    - `/roles <agent>` lists available roles for that agent.
    - `/role <agent> <role>` sets the active role for that agent in the current room.
    - `/role <agent> none` clears the active role for that agent.
    - Unknown agents and unknown roles produce helpful messages.
    - `/help` documents the new commands.
    - Agent previews or status line show active role when present.
    - Tests cover command parsing for role commands.
  - Steps:
    1. Extended slash command parsing to support argument-bearing commands.
    2. Added app-layer handlers for `/roles` and `/role`.
    3. Persisted role changes through room state.
    4. Added a runtime invalidation/reload hook placeholder so Task 8 can refresh Pi sessions after role changes.
    5. Updated agent previews and agent listings to show `@agent [role]`.

- completed: Task 7 — Update Prompt Assembly for Persona, Role, Skills, and Cursor-Based Room Context
  - Description: Change prompt construction so role overlays are included and the turn prompt uses room events since the agent cursor instead of repeatedly injecting the whole recent transcript.
  - Dependencies: Task 3, Task 5
  - Acceptance Criteria:
    - System prompt includes persona soul, active role prompt, project persona intent, project role overlay, project context, memory, and shared-room instruction.
    - Turn prompt includes new room events since the target agent's cursor and the newest user message.
    - Agent cursor updates only after a successful or completed agent turn decision, with behavior documented for partial/error replies.
    - Prompt assembly is testable without creating a real Pi session.
    - Tests verify no duplicate transcript injection across two turns with the same agent cursor.
  - Steps:
    1. Extracted prompt assembly into a pure service.
    2. Added `readRoomEventsAfterCursor()` with cursor as transcript line count for MVP.
    3. Included role diagnostics in the prompt and UI warnings for missing active roles.
    4. Updated runtime input types to carry active role data cleanly.
    5. Added tests for prompt layer order and cursor behavior.

- completed: Task 8 — Refactor Pi Runtime to Persistent AgentRoomSession
  - Description: Replace fresh Pi session creation per message with persistent Pi `AgentSession` instances keyed by room-agent pair. Connect active role skills to Pi's `DefaultResourceLoader`.
  - Dependencies: Task 4, Task 5, Task 7
  - Acceptance Criteria:
    - A `PiRuntime` or new `AgentRoomSession` creates one Pi `AgentSession` per room-agent pair and reuses it for subsequent turns.
    - Role skill paths are passed to Pi through `additionalSkillPaths` or a `skillsOverride` filter.
    - Active built-in tools still come only from agent hard-control config.
    - Role changes refresh the affected session via `AgentSession.reload()` when possible.
    - If reload fails or proves unsafe, the affected session is disposed and recreated with the new role/skills.
    - Runtime `dispose()` actually disposes persistent Pi sessions.
    - Tests use a mocked runtime/session seam; no real Pi auth is needed.
    - Manual verification shows two messages to the same agent reuse continuity and do not create a fresh session each turn.
  - Steps:
    1. Chose durable room-agent session directories under `.gaia/rooms/<room>/pi-sessions/<agent>` using `SessionManager.continueRecent()`.
    2. Introduced a runtime session abstraction and factory seam that can be mocked in tests.
    3. Moved `createAgentSession()` out of the per-message hot path.
    4. Kept `DefaultResourceLoader` available and reloadable per agent session.
    5. Wired role skill resolution into loader creation through `additionalSkillPaths` with `noSkills: true`.
    6. Reloaded sessions when prompts change and recreated sessions when skill paths change or reload fails.
    7. Preserved streaming event forwarding with persistent sessions.

- completed: Task 9 — Add CLI Agent Scaffold Command
  - Description: Add a simple CLI scaffold path for creating new agent-character folders, while leaving deep editing to files.
  - Dependencies: Task 2, Task 3, Task 4
  - Acceptance Criteria:
    - `gaia agent create` scaffolds a new global agent folder with `agent.json`, `persona/SOUL.md`, `persona/MEMORY.md`, and starter `roles/` files.
    - The command refuses to overwrite an existing agent unless an explicit future flag is added.
    - The scaffold can optionally accept arguments or use minimal prompts; if prompts are deferred, documented defaults are used.
    - `gaia --help` documents the command.
    - Tests cover non-overwrite behavior and generated file shape.
  - Steps:
    1. Extended CLI argument handling without adding heavy dependencies.
    2. Implemented scaffold helpers with explicit non-overwrite behavior.
    3. Added starter role templates for brainstorm, research, and plan.
    4. Printed created paths so users can edit files directly.

- completed: Task 10 — Documentation and Migration Cleanup
  - Description: Update user-facing docs and internal plan notes to reflect the new architecture, remove stale claims, and document migration behavior.
  - Dependencies: Tasks 2 through 9
  - Acceptance Criteria:
    - README explains agent hard control, persona soft control, roles, central skills, and room-local active roles.
    - README documents folder structure and role commands.
    - README documents that Pi skills are selected by roles but tools remain agent-level hard control.
    - Any obsolete scratch notes are removed or moved to planning docs.
    - `npm run check` and `npm test` pass.
  - Steps:
    1. Updated README current-shape section after implementation stabilized.
    2. Kept containers/subagents clearly deferred as future seams.
    3. Documented legacy file compatibility and recommended migration path.
    4. Ran final verification commands.

## Sequencing

Recommended order:

1. Task 1 — tests first, so refactors have rails.
2. Task 2 — file model and type foundation.
3. Task 3 — role parsing and role overlays.
4. Task 4 — skill library resolution.
5. Task 5 — room state.
6. Task 6 — role commands and UI state.
7. Task 7 — prompt assembly and cursor context.
8. Task 8 — persistent Pi runtime sessions.
9. Task 9 — CLI scaffold.
10. Task 10 — docs and cleanup.

Task 8 is the riskiest runtime change and should not start until role/skill/state logic is tested independently.

## Risks

- **Pi session persistence details may be subtle.** The exact session identifier/file for durable room-agent continuity needs investigation before implementation locks in.
- **`AgentSession.reload()` may not update every runtime detail safely.** The plan includes a recreate-session fallback on role changes.
- **Cursor semantics can drift.** If transcript cursors are line counts, transcript editing can invalidate them. This is acceptable for MVP but should be documented.
- **Legacy migration must be non-destructive.** Existing `SOUL.md`, `MEMORY.md`, and project `INTENT.md` files must not be overwritten.
- **Role skills must not become hidden permissions.** Skills are soft workflow instructions only; tools remain agent-level hard control.
- **Current worktree has an unrelated `audit.md` deletion.** Implementation/plan commits should avoid staging it unless the user explicitly confirms that deletion.
