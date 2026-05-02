# GAIA Code Audit

Date: 2026-05-01
Model note: session switched to gpt-5.5 via OpenAI Codex.

## Scope

Requested review:

- Inspect code.
- Check whether everything is still up to date.
- Check whether code represents README.md.
- Identify obsolete, broken, or bloated parts.
- Focus on modular, simple design.
- Avoid dependencies.
- Do not implement changes before grilling thoroughly.

No implementation changes were made during the audit.

## Repo state observed

Repository path:

```text
/Users/pascaldisse/projects/GAIA Playground
```

Git status after inspection/build:

```text
## main
 M README.md
```

Only README.md was tracked dirty before/after the audit. `npm run build` regenerated dist output but `dist/` is gitignored and did not affect git status.

Top-level files/directories observed:

```text
src/
.DS_Store
.gitignore
package-lock.json
package.json
plan.md
README.md
tsconfig.json
```

## Verification commands run

```bash
git status --short --branch
npm run check
npm run build
node dist/cli.js --help
npm outdated --long
npm audit --omit=dev
npm ls --depth=0 --omit=dev
npm ls @mariozechner/pi-agent-core --depth=4
```

Results:

- `npm run check`: PASS
- `npm run build`: PASS
- `node dist/cli.js --help`: PASS
- `npm outdated --long`: packages are not fully current
- `npm audit --omit=dev`: FAIL, 4 moderate vulnerabilities through Pi dependency chain
- No test script exists

## Codebase size

TypeScript source:

```text
21 TS files
1,341 total TS lines
```

Largest files:

```text
260 lines  src/tui/app-view.ts
182 lines  src/runtime/pi-runtime.ts
150 lines  src/app/gaia-app.ts
134 lines  src/agents/registry.ts
125 lines  src/memory/memory-store.ts
110 lines  src/workspace/workspace-loader.ts
```

## Dependency state

Production dependencies in package.json:

```json
{
  "@mariozechner/pi-ai": "^0.70.6",
  "@mariozechner/pi-coding-agent": "^0.70.6",
  "@mariozechner/pi-tui": "^0.70.6",
  "typebox": "^1.1.24"
}
```

Top-level installed production deps:

```text
@mariozechner/pi-ai@0.70.6
@mariozechner/pi-coding-agent@0.70.6
@mariozechner/pi-tui@0.70.6
typebox@1.1.34
```

Outdated packages reported:

```text
@mariozechner/pi-ai             current 0.70.6, latest 0.71.1
@mariozechner/pi-coding-agent   current 0.70.6, latest 0.71.1
@mariozechner/pi-tui            current 0.70.6, latest 0.71.1
@types/node                     current 24.12.2, latest 25.6.0
typebox                         current 1.1.34, latest 1.1.37
typescript                      current 5.9.3, latest 6.0.3
```

Security audit:

```text
4 moderate severity vulnerabilities
```

Audit path:

- `@anthropic-ai/sdk` vulnerability
- pulled through `@mariozechner/pi-ai@0.70.6`
- then through `@mariozechner/pi-agent-core`
- then through `@mariozechner/pi-coding-agent`

npm says fixing all may install Pi `0.71.1` and is treated as a breaking change. Do not blindly update without compatibility check.

## README.md vs code

### Claims that are implemented accurately

README says global personas under `~/.gaia/agents/`.

Code:

- `src/workspace/workspace-loader.ts` uses `GAIA_HOME ?? ~/.gaia`
- `src/agents/registry.ts` seeds global default agents

Status: PASS.

README says `GAIA_HOME` overrides global home.

Code:

- `gaiaHome()` uses `process.env.GAIA_HOME`

Status: PASS.

README says project-local `AGENTS.md` context.

Code:

- `initWorkspace()` writes `AGENTS.md`
- `discoverContextFiles()` reads `AGENTS.md` from ancestors

Status: PASS-ish. It is Pi-like, but not strictly project-local because it walks ancestors to filesystem root.

README says project-local `.gaia/config.json`.

Code:

- `initWorkspace()` writes `.gaia/config.json`
- `loadWorkspace()` reads/merges it

Status: PASS.

README says project-local room transcript in `.gaia/rooms/default/transcript.jsonl`.

Code:

- `Room` uses `.gaia/rooms/<room>/transcript.jsonl`

Status: PASS.

README says deterministic `@agent` mention routing.

Code:

- `planMentionRoute()` implements deterministic routing

Status: PASS.

README says multiple agents in first-mentioned order.

Code:

- `GaiaApp` loops through `route.plan.targets`

Status: PASS.

README says per-agent global markdown memory.

Code:

- `MEMORY.md` is global under each global agent dir
- `MemoryStore` mutates that file

Status: PASS, but this conflicts with earlier remembered project-local direction.

README says Pi runtime for all agents / Pi only runtime right now.

Code:

- `createAgentRuntime()` rejects non-`pi`

Status: PASS.

README says sample personas: `@gaia`, `@sidia`, `@terry`.

Code:

- seeded in `ensureGlobalDefaultAgents()`

Status: PASS.

README says slash commands `/help`, `/agents`, `/quit`.

Code:

- implemented in `src/tui/commands.ts`
- also supports `/exit` alias, undocumented

Status: PASS with small doc mismatch.

README says dynamic selectable previews for `/` commands and `@` agents.

Code:

- implemented in `src/tui/app-view.ts`

Status: PASS.

README says project-local agent overrides:

```text
.gaia/agents/gaia/INTENT.md
.gaia/agents/gaia/agent.json
```

Code:

- implemented only for agents that already exist globally

Status: PASS if project files are only overrides. FAIL if project-local agents should be definable without global personas.

## Major architectural conflict

The current README/code use:

```text
~/.gaia/agents/<agent>/agent.json
~/.gaia/agents/<agent>/SOUL.md
~/.gaia/agents/<agent>/MEMORY.md
```

Project-local files are:

```text
AGENTS.md
.gaia/config.json
.gaia/rooms/default/transcript.jsonl
.gaia/agents/<agent>/INTENT.md      optional
.gaia/agents/<agent>/agent.json     optional override
```

But earlier durable project direction said:

```text
.gaia/SYSTEM.md
.gaia/agents/<agent>/{agent config, SOUL.md, MEMORY.md}
avoid ~/.gaia/memories for project agent state
Monad is orchestration/router layer, not an agent folder/persona
```

This is the central unresolved fork:

- Are personas durable global identities?
- Or is agent identity/memory project-local?

Do not implement broad cleanup until this is decided.

## Obsolete / dead / bloated parts

### 1. `@mariozechner/pi-tui` appears unused

Search found no imports of:

```text
@mariozechner/pi-tui
pi-tui
```

Recommendation:

- Remove unless you plan to replace the custom `AppView` with Pi TUI soon.

### 2. Direct import from transitive dependency

`src/agents/types.ts` imports:

```ts
import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
```

But `@mariozechner/pi-agent-core` is not declared in package.json. It is only present through:

```text
@mariozechner/pi-coding-agent -> @mariozechner/pi-agent-core
```

This is brittle.

Options:

1. Add direct dependency. More dependency bloat.
2. Avoid the import and define a narrow local type after confirming accepted values.
3. Import a re-export from a declared Pi package if available.

Given the design preference to avoid dependencies, prefer 2 or 3.

### 3. `public` exists but does nothing

References:

- `src/agents/types.ts`
- `src/agents/registry.ts`

No runtime behavior uses it.

Recommendation:

- Remove until needed, or define and implement semantics.

### 4. `skills` exists but does nothing

References:

- `src/agents/types.ts`
- `src/agents/registry.ts`
- seeded in `agent.json` as `skills: []`

But runtime uses:

```ts
noSkills: true
```

and does not load `agent.skills`.

This is misleading fake config.

Recommendation:

- Remove until implemented, or implement skill loading.

### 5. `modelLabel` exists but does nothing

References:

- `src/runtime/types.ts`
- `src/runtime/pi-runtime.ts`

It is computed but not displayed or used.

Recommendation:

- Remove, or display in `/agents` / status.

### 6. Runtime seam is slightly fake

Workspace config has:

```json
"runtime": "pi"
```

Agent config also has:

```json
"runtime": "pi"
```

`createAgentRuntime()` uses:

```ts
const runtime = options.agent.runtime || options.workspace.config.runtime;
```

But seeded agents always have runtime, so workspace runtime does not practically override default agents.

Since only Pi is supported, this is not harmful, but it is future scaffolding.

### 7. plan.md duplicates README state

`plan.md` repeats a lot of the implemented/current feature list already in README.md. This is drift-prone.

Recommendation:

- README should be user-facing truth.
- plan.md should be only decisions, future work, and open questions.

### 8. Custom TUI is dependency-light but complexity-heavy

`src/tui/app-view.ts` is the largest source file at 260 lines.

It manually handles:

- raw TTY mode
- prompt redraws
- selection menus
- slash previews
- mention previews
- Ctrl-C / Ctrl-D
- escape / arrows / tab / enter

This avoids dependencies, but should be tested because it owns terminal complexity.

## Potentially broken or fragile behavior

### 1. Running from subdirectories likely fails

`loadWorkspace(process.cwd())` only checks exact cwd for `.gaia`.

`discoverContextFiles()` walks ancestors for AGENTS.md.

This is inconsistent. If the project root has `.gaia` but user runs `gaia` from `src/`, startup likely fails.

Decision needed:

- Root-bound only?
- Or discover nearest ancestor `.gaia` like git/Pi-style tools?

### 2. AGENTS.md discovery may be too broad

`discoverContextFiles()` walks all ancestors to filesystem root.

This may ingest parent/global `AGENTS.md` files outside the project.

If workspace root is discovered, AGENTS.md discovery should probably stop at workspace root or explicitly document global/ancestor behavior.

### 3. Mention parser catches incidental @tokens

Regex:

```ts
/@([a-z0-9_-]+)/gi
```

This can interpret email/social tokens as agent mentions.

Example:

```text
email pascal@example.com
```

could treat `@example` as an unknown agent and fail loudly.

### 4. Agent ID normalization is inconsistent

Router lowercases mentions:

```ts
const id = match[1].toLowerCase();
```

Known agent IDs come from loaded config as-is.

If an agent ID has uppercase chars, routing breaks.

Recommendation:

- Enforce lowercase IDs at load time, or stop lowercasing mentions.

### 5. Unknown mentions fail whole message

This matches README, but can be harsh if accidental @tokens exist.

Decision needed:

- strict unknown mention failure always?
- only strict for command-style mentions?
- ignore unknown incidental mentions?

### 6. Memory mutation wording is stricter than behavior

Error says:

```text
old_text must match exactly one memory region
```

But implementation counts occurrences of arbitrary substring in whole file, not memory regions.

Recommendation:

- Make it region-based or change wording.

### 7. Memory unsafe regex is overbroad

Current patterns reject broad words like:

```text
reveal
print
dump
exfiltrate
```

This may reject benign memory content like:

```text
Use print debugging for tiny scripts.
Dump logs before cleanup.
```

### 8. Normal `gaia` startup creates/verifies global personas

`loadWorkspace()` calls `ensureGlobalDefaultAgents()`.

So both `gaia init` and normal `gaia` run can mutate global home.

Maybe good self-healing, but README only says init creates/verifies global personas.

### 9. Project override cannot create project-only agents

`loadAgentDefinitions()` iterates global agents directory. Project `.gaia/agents/<id>/agent.json` is only considered if the global agent dir exists.

Fine if agents are global. Wrong if project agents are allowed.

### 10. Pi session state may overlap GAIA transcript state

PiRuntime creates:

```ts
SessionManager.create(this.cwd)
SettingsManager.create(this.cwd)
```

GAIA also manually injects room transcript.

Need verify whether Pi persists separate session state, to avoid duplicate/competing histories.

### 11. No tests

No automated tests exist. This is the biggest confidence gap for refactors.

High-value zero-dependency tests:

- mention routing
- command parser
- config merge behavior
- workspace init/load in temp dir
- context discovery order
- agent config merge behavior
- transcript append/read
- memory mutation behavior

Use Node built-in `node:test` to avoid adding dependencies.

## Design quality assessment

Good:

- Clear module split:
  - workspace
  - agents
  - router
  - runtime
  - room
  - memory
  - TUI
  - app
- JSONL transcript is simple and appropriate.
- Mention routing is deterministic and testable.
- Global default persona seeding is simple.
- Runtime seam is small.
- No heavy framework pile-on.

Concerning:

- Architecture may have pivoted without explicitly retiring earlier project-local direction.
- Several config fields are aspirational/dead: `public`, `skills`, `runtime`, `modelLabel`.
- README contains scratchpad note.
- Safety is deferred while default agents have write/edit and Terry has bash.
- Custom raw terminal UI has the most code and no tests.
- Dependency graph has a vulnerability via Pi 0.70.6.

## README-specific notes

README currently includes this scratch note near the end:

```text
- check how containers are handled in nano claw
```

This is currently the only uncommitted README diff observed.

Recommendation:

- Move it to `plan.md` or an issue.
- Keep README as user-facing product truth unless intentionally using it as scratchpad.

README should probably also decide/document:

- `/exit` alias, or remove alias.
- whether `gaia` can run from project subdirectories.
- whether global personas are intentional.
- whether normal `gaia` startup may seed global personas.
- whether project-local agents are allowed or only overrides.

## Questions to answer before implementation

### Architecture fork

1. Are personas supposed to be global durable identities, yes or no?

Current README/code says yes:

```text
~/.gaia/agents
```

Earlier remembered direction says project-local:

```text
.gaia/agents/<agent>/SOUL.md
.gaia/agents/<agent>/MEMORY.md
```

2. Should memory be global, project-local, or both?

Options:

- A. Global identity memory only
- B. Project memory only
- C. Global SOUL + project MEMORY
- D. Global MEMORY + project INTENT
- E. Two-layer memory: global durable + project-local contextual

Current code is D-ish.

3. Do you still want `.gaia/SYSTEM.md`?

4. Is Monad dead for now, or just renamed into simple mention routing?

### Workspace behavior

5. Should `gaia` work from any subdirectory inside an initialized project?

6. Should `.gaia` discovery walk upward like git?

7. Should AGENTS.md discovery stop at workspace root?

8. Should `gaia init` detect repo root or only use cwd?

### Agents

9. Can projects define new agents locally, or only override global agents?

10. Should project-local `agent.json` override tools/model/displayName/icon only, or also runtime/thinking/public/skills?

11. What does `public` mean? If unclear, remove it.

12. Are `skills` in scope now? If not, remove the field until implemented.

13. Should every default agent have write/edit?

Current default tools:

```text
gaia:  read, write, edit, memory
sidia: read, write, edit, memory
terry: read, write, edit, bash, memory
```

14. Is Terry's bash permission acceptable before sandboxing?

### Routing

15. Should accidental @mentions in emails/social handles fail the whole message?

16. Should unknown mentions fail loudly always, or only if command-style?

17. Should multiple agents respond sequentially with each seeing prior agent replies?

Current behavior: yes.

18. Should agent messages ever trigger routing?

README says no, but future subagent ideas may conflict.

### Runtime

19. Should Pi packages be upgraded to 0.71.1 now to address audit, or pinned at 0.70.6 until compatibility is checked?

20. Should model overrides be real MVP feature? If not, remove `model`, `thinking`, and `modelLabel` until needed.

21. Should GAIA own transcript state exclusively, or should Pi session state also persist?

### TUI

22. Is selectable `/` and `@` preview essential?

23. Do we need full line editing/cursor movement, or is append/backspace acceptable?

### Docs

24. Is README a product/user doc or also a scratchpad?

25. Should plan.md be kept, and if so should it stop duplicating README current state?

26. Should README document `/exit` alias?

27. Should README document that normal `gaia` startup also verifies/seeds global personas?

### Testing

28. Are zero-dependency tests using Node built-in `node:test` acceptable?

29. What is the minimal no-regression bar before architectural edits?

Suggested minimum:

- routing tests
- command parser tests
- config merge tests
- temp-dir workspace init/load tests
- transcript tests
- memory mutation tests

30. Should tests target TypeScript through `tsx`, or compiled JS in `dist`?

## Recommended next move if changes are authorized

Do not begin feature work before answering the architecture fork.

Suggested order:

1. Decide global vs project-local memory/persona architecture.
2. Clean docs:
   - remove README scratch note or move to plan.md
   - document `/exit` or remove alias
   - clarify project root/subdir behavior
   - clarify global vs project-local memory/personas
3. Remove or wire dead scaffolding:
   - remove `@mariozechner/pi-tui` if unused
   - remove or implement `public`
   - remove or implement `skills`
   - remove or display `modelLabel`
   - fix transitive `@mariozechner/pi-agent-core` import
4. Add zero-dependency tests for pure logic.
5. Fix workspace discovery if subdir support is desired.
6. Consider Pi 0.71.1 upgrade/audit fix in a separate patch.

## Short verdict

The repo is small, mostly modular, and currently builds. README mostly matches the implementation. However, the design has several stale/future-facing config fields, an unused dependency, a direct transitive dependency import, no tests, and an unresolved architectural contradiction around global vs project-local agent identity/memory.

Resolve the architecture fork before implementing cleanup.
