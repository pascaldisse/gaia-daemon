---
name: claude-design
description: Create, inspect, and capture visual work in Claude Design. Use for interface concepts, prototypes, design-system exploration, visual review, and Claude Design requests.
---

# Claude Design

## Tool

`claude-design.mjs` → local Claude Design companion; dedicated browser instance + profile; GAIA app and interactive browser remain independent.

```bash
bun {baseDir}/claude-design.mjs doctor
bun {baseDir}/claude-design.mjs start
bun {baseDir}/claude-design.mjs status
bun {baseDir}/claude-design.mjs inspect
bun {baseDir}/claude-design.mjs screenshot --out /tmp/claude-design.png
bun {baseDir}/claude-design.mjs prompt -- "<design brief>"
bun {baseDir}/claude-design.mjs sync
```

## Workflow

1. `doctor` → environment + authenticated-session readiness.
2. `start` → open Claude Design in the dedicated instance.
3. `status` → require `loggedIn: true` + `onDesignPage: true`.
4. `prompt -- "…"` → create or continue visual work.
5. `screenshot` → inspect result; critique against requested direction.
6. Iterate with focused prompts; preserve operator-created projects.
7. `sync` → optional repository design-system handoff through Claude Code.

## Design brief

Include:

- artifact type + audience
- one named visual direction
- content hierarchy
- required states/interactions
- type, color, spacing, motion constraints
- accessibility + responsive requirements
- acceptance criteria

## Operating contract

- Dedicated CDP port → `9456`; GAIA app CDP `9333` remains independent.
- Local authenticated Claude session → companion manages access; credential values never printed.
- Existing projects → read-only unless operator names one for modification.
- New project → distinctive task name; report created artifact.
- DOM drift → run `inspect`; update semantic selector table instead of transport.
- Output → screenshot path + concise state/result summary.

## Options

- `--cdp-port <n>` → dedicated port override; `9333` rejected.
- `--profile-dir <path>` → dedicated profile override.
- `--browser <path>` → Chromium-family executable override.
- `--headless` → optional; headed mode = default.
