# Anthropic Skills API ↔ GAIA folders — recon

> scope: docs/local inspection only · 2026-08-21 · no keys, uploads, or API calls
>
> sources: [GA announcement][announce] · [Skills/API guide][guide] · [Skills overview][overview] · [Code execution][code-exec] · [pricing][pricing] · [GAIA resolver][gaia-resolver] · [GAIA README][gaia-readme]. `UNVERIFIED` = absent/ambiguous in those sources; not inferred.

## §0 verdict

**Charles/external sharing → use Anthropic Skills API as a controlled, workspace-internal distribution target; keep Git/zip as canonical external artifact.**

- strong fit → common portable `SKILL.md` + folder/resource model; API workspace sharing; immutable-ish full snapshots, pin-able IDs.
- non-fit → no public catalogue/discovery/export channel; recipient needs its own Anthropic workspace/API credentials + upload; API sandbox cannot run networked/local-binary/Bun-dependent GAIA skills.
- policy → source skill in Git; `anthropic/` build wrapper + dependency audit; upload complete release zip; record `skill_*` + `skver_*`; consumers pin version. Never treat `latest` as release pin.

## §1 shape delta

| axis | GAIA local folders — measured | Anthropic Skills API — documented | port implication |
|---|---|---|---|
| discovery root | global `~/.gaia/skills/<dir>/SKILL.md`; project `.gaia/skills/<dir>/SKILL.md` overrides global. GAIA additionally scans Claude/Pi/Codex/Hermes roots. | upload bundle: `SKILL.md` at zip root **or** one enclosing top-level folder; installed in sandbox `/skills/{SKILL.md.name}/`. | folder largely ports; normalise zip root/single wrapper. No GAIA root precedence model. |
| mandatory entry | `SKILL.md`; local resolver accepts frontmatter `name`/`description`, falls back to dirname for name; no side manifest. | `SKILL.md`; YAML `name` + `description` required. | add/validate metadata where missing; do not rely on dirname fallback. |
| name grammar | GAIA resolver: `[A-Za-z0-9_-]+`; examples use kebab-case. | ≤64 chars; lowercase letters/numbers/hyphens only; no XML; excludes `anthropic`, `claude`. | GAIA underscore/uppercase-compatible names need rename/wrapper name. |
| description | optional; UI/assignment hint. | non-empty; ≤1024 chars; no XML; activation metadata. | retain + sharpen trigger wording. |
| manifest | none — `SKILL.md` is manifest + instructions. `youtube-transcript/package.json` is an application dependency manifest only. | no separate manifest specified; `SKILL.md` frontmatter is required manifest surface; optional upload `display_name` ≤255 chars. | no manifest translation layer; package-manager files do not establish Anthropic dependencies. |
| body/resources | arbitrary sibling scripts/resources; `{baseDir}` entry convention in local instructions. `gaiago-seal`: only `SKILL.md`; `youtube-transcript`: `SKILL.md`, `transcript.js`, `package.json`/lock; `app-tools`: `SKILL.md` + `app-*.js`. | arbitrary supporting scripts/resources bundled; metadata first, `SKILL.md` on trigger, other files on demand; instructions recommend body <500 lines. | relative paths port; replace `{baseDir}` with documented `/skills/{name}`-relative/path-discovery convention or compute shell dir. |
| authority/tools | soft workflow instructions only; tools remain GAIA `agent.json` hard control. Local runtime can use user machine/network. | skill executes through code-execution sandbox; Bash/filesystem; attached code-exec required. | split instructions from capability assumptions; attaching a skill neither grants external APIs nor local access. |
| size/count | no local size cap observed in resolver. | ≤30 MB total **uncompressed** upload; Messages: ≤20 skills/request. Managed Agents: ≤500 deduplicated skills/session. | package/release size gate; keep large docs out or prune. |
| activation | GAIA resolves explicit agent/persona/role assignment; Pi loads assigned file paths. | request `container.skills[]`: `{type:"custom", skill_id:"skill_*", version:"skver_*"|"latest"}` + code-execution tool; Claude auto-selects relevant attached skill. | build an API-side attach policy; GAIA role assignment does not transfer. |
| versioning | filesystem/Git; project-over-global collision; no upload registry. | `POST /v1/skills/{id}/versions`; complete snapshot each time; omitted files disappear; `SKILL.md.name` must stay same; generated `skver_*`; pin exact version. | release zip must be whole skill, not diff; Git remains source history/rollback. |
| sharing | filesystem/user/project; distribution handled outside folder protocol. | API custom skill private to Anthropic workspace, accessible workspace-wide; claude.ai uploads are per-user and separate; surfaces do not sync. | useful for Charles’s internal workspace, not a one-upload external marketplace. |

## §2 local exemplar audit

| skill | local manifest/entry | executable/deps | API disposition |
|---|---|---|---|
| `gaiago-seal` | `SKILL.md`; `name: gaiago-seal`; trigger-rich description. | summons GAIA worker, local `whisper`/`ffmpeg`, reads `~/.gaia/knowledge/`; no packaged script. | **instructions only** portable; operational workflow blocked: no GAIA summon/local paths; audio binaries unverified/not listed. |
| `youtube-transcript` | `SKILL.md`; `name: youtube-transcript`; command `{baseDir}/transcript.js`. | Node ESM + `youtube-transcript-plus` from `package.json`; internet required to contact YouTube. | **metadata/body shape ports; execution blocked**: API no network, no runtime install; Node/Bun absent from documented preinstalled inventory. Rewrite as client/MCP/web-fetch workflow or precompute inputs. |
| `app-tools` | `SKILL.md`; `name: app-tools`; `{baseDir}/app-*.js`. | JavaScript CDP clients; calls local `127.0.0.1:9333`, controls a host app. | **not portable operationally**: API sandbox isolated/no host access/no outbound network; no documented Node/Bun. Could port only as instructions for a separately supplied client tool. |

Local discovery evidence → resolver scans one `SKILL.md` per child directory; frontmatter `name` identifies skill (directory only fallback); precedence: project → global → Pi/other ecosystems. No `skill.json`/`manifest.*` in audited local skills; only `youtube-transcript/package.json`.

## §3 upload + lifecycle

| operation | endpoint/contract | release rule |
|---|---|---|
| create | `POST /v1/skills` → upload zip or individual file objects; bundle directly to Skills API, **not** Files API; returns `skill_*`. | archive skill folder after dependency audit. |
| enumerate | `GET /v1/skills`; `source=custom` filter documented. | inventory workspace registry. |
| retrieve/delete | `GET /v1/skills/{id}` · `DELETE /v1/skills/{id}` (delete removes all versions). | do not delete a referenced production skill without migration. |
| versions | `POST /v1/skills/{id}/versions`; `GET /v1/skills/{id}/versions`; `GET /v1/skills/{id}/versions/{version}`; `DELETE /v1/skills/{id}/versions/{version}`. | upload full snapshot; exact `skver_*` in production request. |
| content retrieval | `GET /v1/skills/{id}/versions/{version}/content`. | **UNVERIFIED** response/archive format; retain own Git release zip. |

## §4 execution envelope / blockers

| surface | documented fact | GAIA impact |
|---|---|---|
| network | API code-exec: completely disabled; no outbound/API/internet connections. | network skills (`youtube-transcript`, web fetchers, HTTP CLIs, CDP) fail unless rewritten around API-provided/client/MCP tools. |
| process/files | Linux x86_64 sandbox; Bash + file operations; workspace-only filesystem; isolated host/containers; fresh unless container reused. | no `~/.gaia`, user files, desktop app, local socket, GAIA CLI/daemon. Bundle static resources or upload input files. |
| language | Python 3.11 documented; listed preinstalls are Python libraries + CLI `unzip`, `unrar`, `7zip`, `bc`, `rg`, `fd`, `sqlite`. | Python-first ports viable only against listed deps. **Bun: UNVERIFIED / treat unavailable. Node: UNVERIFIED / treat unavailable.** Do not ship `package.json` expecting install/run. |
| packages/binaries | no runtime package install; only preinstalled libraries; docs list no `ffmpeg`, `whisper`, browser, GAIA CLI, or arbitrary system binaries. | audit every command; `ffmpeg`/`whisper`/host-specific tooling **UNVERIFIED / treat unavailable**. |
| resources | 5 GiB RAM, 5 GiB workspace, 1 CPU; per invocation max duration not numerically published; programmatic-tool Python cell 90 s wall-clock. | large media/transcription/document pipelines need a measured API eval; do not promise parity. |
| persistence | reuse returned container ID; checkpoint ~5 min idle; hard expiry 30 days; otherwise fresh container. | stateful multi-step allowed only during container lifetime; no durable local state. |

## §5 attach/request mechanics

```json
{
  "model": "<code-exec-compatible-model>",
  "container": {
    "skills": [{
      "type": "custom",
      "skill_id": "skill_<id>",
      "version": "skver_<pinned-version>"
    }]
  },
  "tools": [{"type": "code_execution_20260521", "name": "code_execution"}],
  "messages": [{"role": "user", "content": "<task>"}]
}
```

- metadata (`name`, `description`) enters system prompt; files copied to `/skills/{name}/`; body/resources load on demand.
- Files API is separate: upload input → `container_upload` by `file_id`; generated `$OUTPUT_DIR` files yield `file_id` → download via Files API.
- continuation → resend `container.id` + same skill list; handle `pause_turn` for long work.
- changing list/order or `latest` description can bust prompt-cache prefix.

## §6 price / governance notes

- no separate **Skills upload** price found. Skill use consumes normal model tokens; skill metadata/instructions/files read add context tokens.
- code-exec: free when current web-search/web-fetch tool included; otherwise minimum 5-min execution billing; org includes 1,550 free container-hours/month, then $0.05/container-hour. Input files start execution billing even if tool not called.
- custom skill + code-exec data: standard retention; Agent Skills not ZDR. Code-exec container data ≤30 days; generated Files persist until delete.
- Compliance Activity Feed can log create/delete/version operations if enabled beforehand; Skills API uploads are **not** Enterprise content-scanned. Review/CI/sign/release gate remains Charles’s responsibility.

## §7 port plan

1. **as-is candidate** → instruction-only GAIA skills with valid lower-kebab `name`, non-empty trigger description, ≤30 MB total, no host/network/runtime dependency.
2. **wrapping required** → zip root + metadata validator; rewrite `{baseDir}` commands; replace GAIA tool references with explicit client/MCP tool contracts; vendor only verified Python/static assets.
3. **hard blocker** → local desktop/GAIA CLI/home paths; outbound HTTP; npm/Bun/Node package install; undocumented binaries. Keep local or move capability into caller-operated tool/MCP service.
4. **distribution** → Git repo/release zip for external audience; Charles uploads vetted release to each intended workspace; share `skill_*`/pinned `skver_*` only within that workspace. Cross-workspace transfer = recipient upload, not API sharing.

[announce]: https://claude.com/blog/computer-use-skills-api-files-api
[guide]: https://platform.claude.com/docs/en/build-with-claude/skills-guide
[overview]: https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview
[code-exec]: https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool
[pricing]: https://platform.claude.com/docs/en/about-claude/pricing
[gaia-resolver]: ../src/domain/skills.ts
[gaia-readme]: ../README.md#skills
