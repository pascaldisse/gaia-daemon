# Importing a claude.ai data export

`scripts/import-claude-export.ts` turns a claude.ai account export (the
directory containing `conversations.json`, `memories.json`, `projects/`) into
a GAIA agent's history and memory. Everything is written through the daemon's
own domain functions (`scaffoldGlobalAgent`, `initWorkspace`,
`ensureWorkspaceRoom`, `appendFactOp`, `appendEpisode`), so every record is
valid by construction and respects the same guards (secret filter, room-id
validation, atomic state writes).

## Usage

```sh
npx tsx scripts/import-claude-export.ts \
  --export ~/Downloads/data-<uuid>-batch-0000 \
  --workspace ~ \
  --agent nyari \
  (--room nyari | --per-chat) \
  --set-default          # make the agent the workspace default
  # --force              # rewrite previously imported artifacts
```

Two room modes (exactly one is required):

- `--room <id>` — every conversation becomes transcript history in ONE room,
  each preceded by a `— imported chat: … —` marker line. Use this when the
  point is the agent's continuous memory, not browsable chats.
- `--per-chat` — every conversation becomes its OWN room
  (`claude-YYYYMMDD-<slug>`, deterministic, collision-suffixed) with the
  chat's original title and date on room state (`title` + `imported`), and
  the chat's last-activity time stamped onto the transcript file's mtime.
  Rooms ARE chats: they list in the sidebar like any other room (the rooms
  list orders by transcript mtime — a chat list — and renders in chunks, so
  a 100-chat import doesn't flood it). Read a whole chat via the
  transcript's "load older" pager, or keep talking to the agent in it — its
  cursor starts one window before the end. Re-running skips rooms that
  already exist, so it's incremental across export batches.

Run it while the daemon is stopped (the import writes room state directly;
the daemon's single-writer guarantee only covers writes routed through it).

## What it writes

| Export source | Destination | Form |
|---|---|---|
| `conversations.json` | `<workspace>/.gaia/rooms/<room>/transcript.jsonl` | One `RoomEvent` line per message, oldest conversation first, original timestamps. Each conversation is preceded by a one-line `— imported chat: "<title>" (<date>) —` marker so titles are readable and recall-searchable. Assistant thinking blocks land in `details.thinking` (the same field the live harnesses commit), never in the visible text — the export's own `text` field concatenates thinking with the reply, so content blocks are authoritative. |
| `conversations.json` | `<agent>/persona/memory/episodes.jsonl` | One episode per conversation (`task` = title + first user message, `reply` = last assistant message, 400-char heads). |
| `memories.json` → `conversations_memory` | `<agent>/persona/memory/facts.jsonl` | One fact per paragraph, tagged with its `**Section**` heading, `source: "consolidator"`. |
| `memories.json` (full blob) | `<agent>/persona/memory/claude-ai-memory-*.md` | Topic files, split under the 10K on-demand cap. |
| `projects/*.json` + project memories | `<agent>/persona/memory/claude-ai-project-<slug>.md` | Project system prompt + project memory per file. |

After writing the transcript, the room's `state.json` gets
`agentCursors[<agent>] = <line count> − transcriptWindow` — the agent's first
live turn gets the **tail** of the imported history injected as room context
(a fresh harness session starts with an empty window otherwise, and recall
alone surfaces fragments by relevance, not the actual last exchange).
Everything older stays behind the cursor: **recalled** (hybrid RRF over
facts, episodes, and the room transcript), never replayed into a prompt.
`recall.db` and `index.db` are derived and rebuild lazily on first search.

Not imported mechanically (curate by hand per persona): `agent.json`
(harness/model/thinking/permissionMode), `persona/SOUL.md` (the system
prompt), and the always-injected `MEMORY.md` (4K cap) / `USER.md` (2K cap)
core files.

## Re-running

Without `--force` the script refuses to touch a non-empty transcript or
facts/episodes log. With `--force` it rewrites those imported artifacts from
scratch (topic files are always rewritten). Facts and episodes are
append-only stores everywhere else in the system — `--force` is an import
convenience, not a general pattern.

## Real runs

### Per-chat run (2026-07-04)

`--per-chat` over the newest export batch: 99 rooms imported into the home
workspace (8 of 107 conversations had no visible text and were skipped) as
`claude-20260421-your-first-chat-with-claude` … `claude-20260703-…`, titles
and dates on room state, memory artifacts untouched (episodes/facts already
present from the first run). The single-room history from the first run was
then stripped out of the `nyari` transcript (the 9,590 imported lines are
preserved in that room's `imported-history.jsonl`; cursors shifted by the
removed line count; derived `recall.db` dropped to rebuild) — the per-chat
rooms are the single source for old chats, and cross-room recall reaches
ALL rooms (the previous 12-most-recent cap on `recentRoomRefs` is gone).

### First real run (2026-07-03)

107 conversations (2026-04-21 → 2026-07-03, 9,491 messages → 9,590 events
incl. markers), 107 episodes, 19 facts, and 3 topic files imported for agent
`nyari` (claude harness, model `fable`) into room `nyari` of the home
workspace (`~`), which was v2-initialized in the process
(`~/.gaia/config.json`, `~/AGENTS.md` scaffold). Verified end-to-end: 258/258
tests, recall smoke over facts/episodes/transcript, and a live daemon turn
committing `details.model: anthropic/claude-fable-5`.
