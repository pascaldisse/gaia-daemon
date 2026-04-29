# GAIA Pi Wrapper

## Overview

- Build `gaia` as a minimum viable standalone CLI agent on top of the Pi SDK.
- Use `plan.md` as inspiration only, not as a full implementation target.
- Keep the first version small: personas, mode switching, Pi tools, and markdown memory.
- Avoid LangChain and LangGraph because Pi already provides model routing, tool use, sessions, streaming, and extension primitives.
- Model the architecture after the simplest part of OpenClaw: a standalone app that embeds `@mariozechner/pi-coding-agent` via `createAgentSession`.
- Model memory after the simplest part of Hermes: bounded markdown memories injected at session start.
- Keep the terminal interface minimal but polished, with persona voice as the main experience.
- Design extension seams for future web search, Python science tools, visualization, subagents, richer Monad orchestration, and full Hermes-style memory.

## Expected behavior

- Running `gaia` opens a terminal conversation interface.
- The active mode is visible in the status line.
- The user can switch modes with slash commands:
  - `/gaia` switches to Gaia.
  - `/sidia` switches to Sidia.
  - `/monad` switches to Monad.
- Gaia behaves as a warm, constructive, pattern-seeking child of light.
- Sidia behaves as a skeptical, deconstructive, crack-finding child of obsidian.
- Monad behaves as a director agent that coordinates Gaia and Sidia.
- Gaia, Sidia, and Monad are separate Pi SDK sessions with their own prompts and configurable model/settings.
- Gaia and Sidia can use different models when configured.
- If no persona-specific model is configured, personas inherit Pi's configured default provider/model.
- V1 stores only Pi session history; a custom GAIA transcript with richer metadata is deferred.
- V1 memory uses markdown files under `~/.gaia/memories/`:
  - `USER.md` for shared user profile and preferences.
  - `GAIA.md` for Gaia-specific notes.
  - `SIDIA.md` for Sidia-specific notes.
- Memory is injected as a frozen snapshot when each persona session starts.
- Memory writes are persisted immediately, but active prompts are refreshed only on the next session.
- Personas can proactively write useful long-term memories with Hermes-style save/skip rules.
- Pi built-in coding tools are available from the start.
- Risky tool calls prompt for confirmation before execution.
- Web search, Python science tools, generated HTML visualization, subagents, external memory providers, gateway/background daemon, voice, and web UI are not implemented in the first version.
- V1 may define interfaces or placeholder seams for future tools, but should not spend effort implementing them.

## Implementation plan

- Create `package.json`.
  - Define the package name, dependencies, and scripts.
  - Add a `bin` entry for `gaia`.
  - Depend on `@mariozechner/pi-coding-agent`, `@mariozechner/pi-ai`, `@mariozechner/pi-tui`, and a YAML parser if YAML config is selected.
  - Use TypeScript + Node with npm as the package/runtime choice.

- Create `tsconfig.json`.
  - Configure ESM output for Node-compatible execution.
  - Include `src/**/*.ts` and tests if tests are added.

- Create `src/cli.ts`.
  - Parse CLI arguments.
  - Start the interactive GAIA app when no subcommand is provided.
  - Support a minimal `gaia init` command if setup UX includes initialization.
  - Print helpful errors when Pi auth/model configuration is unavailable.

- Create `src/config/config.ts`.
  - Load global config from `~/.gaia/config.yaml`.
  - Auto-create a default global config on first run when `~/.gaia/config.yaml` is missing.
  - Merge defaults for personas, memory, safety, and UI.
  - Leave project-level overrides as a future extension point.

- Create `src/config/types.ts`.
  - Define `GaiaConfig`.
  - Define `PersonaConfig` for Gaia, Sidia, and Monad.
  - Include optional provider/model/thinking/tool settings per persona.
  - Include memory limits and paths.
  - Include safety confirmation settings.

- Create `src/personas/types.ts`.
  - Define `PersonaId` as `gaia | sidia | monad`.
  - Define `Mode` as `gaia | sidia | monad`.
  - Define metadata for display name, icon, memory target, default prompt, and config key.

- Create `src/personas/prompts/gaia.md`.
  - Describe Gaia as warm, constructive, curious, pattern-seeking, and exploratory.
  - Emphasize exploring with the user as an equal.
  - Include memory guidance for `USER.md` and `GAIA.md`.

- Create `src/personas/prompts/sidia.md`.
  - Describe Sidia as skeptical, deconstructive, precise, melancholic but not mean.
  - Emphasize falsification, assumptions, edge cases, and cracks.
  - Include memory guidance for `USER.md` and `SIDIA.md`.

- Create `src/personas/prompts/monad.md`.
  - Describe Monad as the director/orchestrator agent.
  - In v1, keep orchestration deterministic and simple.
  - Preserve the future direction: richer planning, routing, turn ordering, and multi-agent choreography.
  - Make Monad aware that Gaia builds and Sidia stress-tests.

- Create `src/memory/memory-store.ts`.
  - Implement Hermes-inspired bounded markdown memory.
  - Store files in `~/.gaia/memories/`.
  - Support shared `USER.md` plus persona files.
  - Use `§` as the entry delimiter.
  - Enforce character limits.
  - Deduplicate exact entries.
  - Support add, replace, and remove by unique substring.
  - Write files atomically.
  - Add lightweight scanning for prompt-injection and secret-exfiltration patterns.

- Create `src/memory/render.ts`.
  - Render memory blocks for prompt injection.
  - Include headers with usage percentage and character counts.
  - Keep the rendered format close to Hermes for clarity.
  - Return frozen startup snapshots for each session.

- Create `src/tools/memory-tool.ts`.
  - Register a Pi custom tool named `memory`.
  - Parameters:
    - `action`: `add | replace | remove`.
    - `target`: `user | persona`.
    - `content` for add/replace.
    - `old_text` for replace/remove.
  - Route `target: user` to `USER.md`.
  - Route `target: persona` to the active persona's memory file.
  - Return live memory state after mutations.
  - Include Hermes-style save/skip guidance in the tool description.

- Create `src/pi/resource-loader.ts`.
  - Build a minimal custom `ResourceLoader` for each persona session.
  - Inject the persona prompt.
  - Append the relevant memory blocks.
  - Keep skills/prompts/extensions empty in v1 unless the app intentionally inherits Pi resources.
  - Leave an extension seam for adding GAIA-specific skills and tools later.

- Create `src/pi/session-factory.ts`.
  - Create `AgentSession` instances using `createAgentSession`.
  - Use shared `AuthStorage` and `ModelRegistry` from Pi.
  - Resolve persona model/settings from `~/.gaia/config.yaml`, falling back to Pi defaults.
  - Attach memory tool and safety-related customizations.
  - Use Pi `SessionManager` for session persistence.

- Create `src/safety/risk-detector.ts`.
  - Detect risky writes outside the current working directory.
  - Detect edits to secret-bearing files such as `.env`, credentials, SSH keys, npm/pypi configs, and auth files.
  - Detect risky bash patterns such as `rm`, `mv`, `chmod`, `chown`, `sudo`, package installs, and shell redirection to protected paths.
  - Keep the detector conservative and configurable.

- Create `src/safety/confirmation.ts`.
  - Prompt the user before allowing risky tool calls.
  - Integrate with Pi extension/tool-call interception if practical.
  - Fall back to wrapping or filtering tool availability if direct interception is too costly for v1.
  - Return clear messages for blocked or cancelled actions.

- Create `src/app/gaia-app.ts`.
  - Own application lifecycle.
  - Load config and memory.
  - Create Gaia, Sidia, and Monad sessions.
  - Track active mode.
  - Route normal user messages to the active mode.
  - Route slash commands to command handling.
  - Subscribe to Pi session streaming events and forward deltas to the TUI.

- Create `src/app/mode-router.ts`.
  - Implement `/gaia`, `/sidia`, and `/monad`.
  - For Gaia/Sidia modes, send the user message to that persona session.
  - For Monad mode, send the user prompt to the Monad director session first.
  - Use a simple v1 orchestration rule after Monad responds or chooses order.
  - Keep the orchestration API ready for future director decisions.

- Create `src/app/monad-orchestrator.ts`.
  - Represent Monad as its own agent, not a hardcoded formatter.
  - In v1, support a simple configurable/default order for sibling turns.
  - Pass compact context from Monad to Gaia/Sidia.
  - Pass Gaia's and Sidia's outputs back into the visible stream.
  - Avoid implementing subagents or complex parallel orchestration in v1.

- Create `src/tui/app-view.ts`.
  - Use Pi TUI components for the terminal interface.
  - Render message stream, editor/input, and status line.
  - Keep layout minimal.

- Create `src/tui/status-line.ts`.
  - Show active mode.
  - Show active persona/model when known.
  - Optionally show memory usage if easy.

- Create `src/tui/commands.ts`.
  - Parse slash commands.
  - Implement `/gaia`, `/sidia`, `/monad`, `/help`, and `/quit`.
  - Add slash-command autocomplete only if it is low-cost with Pi TUI components.

- Create `src/tui/message-renderer.ts`.
  - Render user messages.
  - Render Gaia, Sidia, and Monad assistant messages with distinct labels/icons.
  - Render tool calls/results in a compact way.
  - Keep styling minimal and readable.

- Create `src/future/web-search.ts` or document an interface in comments.
  - Define the intended future interface for general web search.
  - Do not bind to Brave, Tavily, or another provider in v1.
  - Leave this out of active tools until implementation starts.

- Create `src/future/artifacts.ts` or document an interface in comments.
  - Define the future artifact model for generated HTML files and clickable paths.
  - Do not implement Python visualization in v1.

- Create `README.md` or update project documentation.
  - Explain the v1 goal.
  - Explain setup and running `gaia`.
  - Explain memory files.
  - Explain slash commands.
  - Clearly list out-of-scope future features.

- Keep `plan.md` unchanged.
  - Treat it as vision/lore inspiration.
  - Do not rewrite it as the v1 engineering plan unless requested.

## Implementation phases

- Phase 1: Project skeleton and config.
  - Add package metadata and TypeScript setup.
  - Add `gaia` CLI entry point.
  - Load `~/.gaia/config.yaml`.
  - Auto-create `~/.gaia/config.yaml` and memory directories on first run.
  - Verify that a minimal Pi SDK session can stream a response.

- Phase 2: Persona sessions.
  - Add Gaia, Sidia, and Monad prompt files.
  - Create one Pi `AgentSession` per persona.
  - Resolve model/settings per persona with Pi default fallback.
  - Route a hardcoded message to each persona.
  - Verify that persona voice and model fallback work.

- Phase 3: Minimal TUI and mode switching.
  - Add Pi TUI-based message stream, input/editor, and status line.
  - Add `/gaia`, `/sidia`, and `/monad` commands.
  - Show active mode in the status line.
  - Stream responses into the message view.
  - Reach the first useful demo: chatting and switching modes.

- Phase 4: Markdown memory.
  - Add `USER.md`, `GAIA.md`, and `SIDIA.md` storage.
  - Inject frozen memory snapshots into persona prompts at session creation.
  - Add the `memory` tool.
  - Allow proactive Hermes-style memory writes.
  - Verify memory persists across app restarts.

- Phase 5: Monad v1 orchestration.
  - Treat Monad as a director agent.
  - Implement a simple orchestration path using Gaia/Sidia sessions.
  - Keep turn order simple and configurable or deterministic.
  - Ensure Gaia/Sidia can see enough context to respond coherently.
  - Avoid complex subagent machinery.

- Phase 6: Pi tools and safety confirmations.
  - Enable Pi built-in coding tools.
  - Add risk detection for destructive commands and protected writes.
  - Prompt before risky tool calls.
  - Verify normal coding workflows still work.

- Phase 7: Documentation and future seams.
  - Document current behavior and limitations.
  - Document future web search, HTML artifacts, Python tools, subagents, and full memory providers.
  - Keep the code modular enough that selected tools can later become Pi extensions.

## Testing strategy

- Unit-test config loading if tests are included in v1.
  - Missing config.
  - Default config.
  - Persona-specific overrides.
  - Pi default fallback behavior.

- Unit-test memory store behavior.
  - Add entry.
  - Replace by unique substring.
  - Remove by unique substring.
  - Reject duplicate entries.
  - Reject over-limit entries.
  - Reject unsafe prompt-injection patterns.
  - Preserve delimiter behavior.
  - Persist and reload files.

- Unit-test command parsing if tests are included in v1.
  - `/gaia`, `/sidia`, `/monad`.
  - Unknown slash commands.
  - Normal chat messages.

- Unit-test risk detection if tests are included in v1.
  - Writes inside current working directory.
  - Writes outside current working directory.
  - Secret-file paths.
  - Destructive bash patterns.
  - Benign bash commands.

- Smoke-test Pi SDK integration.
  - Start app.
  - Send a message in Gaia mode.
  - Switch to Sidia mode and send a message.
  - Switch to Monad mode and send a message.
  - Restart app and confirm memory is injected.

- Manual acceptance test for first demo.
  - Run `gaia`.
  - See status line in Gaia mode.
  - Ask Gaia to remember a user preference.
  - Switch to Sidia.
  - Ask Sidia to remember a technical convention.
  - Quit and restart.
  - Confirm both memories affect future responses.

## Open questions

- Exact minimum TUI scope is not finalized.
  - Required pieces are message stream, input/editor, and status line.
  - Slash autocomplete and memory status can be deferred if they slow down v1.

- Exact safety confirmation rules are not finalized.
  - Current likely rules: confirm writes outside cwd, secret-file access, and destructive bash patterns.
  - Whether all bash commands require confirmation is unresolved.

- Test depth is not finalized.
  - Unit tests are recommended for memory/config/commands/risk detection.
  - A pure manual demo is possible if speed is the top priority.

- Monad v1 order is not fully specified.
  - The architecture treats Monad as a director agent.
  - The first implementation still needs a simple deterministic fallback when the director does not choose an order.

- Monad memory target is not fully specified.
  - V1 memory is explicitly `USER.md`, `GAIA.md`, and `SIDIA.md`.
  - It is unclear whether Monad should eventually get `MONAD.md` or only coordinate sibling memories.
