# TEST-GAP d74be4d — `feat: add durable model-driven init command`

案のみ·src不觸·code未書。真=読取確認 · 假=推測(未実行検証)。
盤=worktree `naru-opus-mtsirs1ohc5klo` · 流儀=`test/room-service.test.ts` の `makeService()` + `RoomHandle` 直読(state.json / transcript)。

## 0. 既存カバレッジ現況 (真)

| 既存test | 覆う | 覆われぬ |
|---|---|---|
| `test/commands.test.ts::parseCommand: known commands and arguments` | `/init`→`{type:init}` · palette登録 | 他全部 |
| `test/room-service.test.ts::/init queues a model turn, preserves its display text, and refreshes all runtimes` | idle経路1本: task complete · refreshes=[1,1] · transcript先頭=`/init` · queue/pendingTurn空 | busy時queue · monad · WAL往復 · model受領prompt · maybeAutoTitle · 非init時refresh無発火 |

∴ 重点5中 実カバー=部分1(重点4のtranscript側のみ)。model側·queue側·WAL側·monad側·negative側=零。

## 1. 提案表

| # | 題 | 対象file/関数 | helper | setup | assert列 | sev | 既存 |
|---|---|---|---|---|---|---|---|
| A1 | busy時 `/init` は queue entry に projectInit+displayText を載せる | `src/services/room/queue.ts` `RoomQueue.send` (init展開 l.127 · enqueue l.277) | `makeService({script})` 遅延script · `readJson(workspacePaths.roomState(root, default))` | ①長走script(未解決promise/sleep)で先行message送信 → busy ②`service.sendMessage(/init)` ③state.json読 | ・queue長=1 ・entry.projectInit===true ・entry.displayText===`/init` ・entry.text===PROJECT_INIT_PROMPT ・entry.text に `/init` 非含 | P0 | 假(無) |
| A2 | drain時 command 再parseされず message turn として走る | 同 `RoomQueue` drain (l.404 付近) | A1同 + `runtimes.get(gaia).sends` | A1後 ①先行turn解放 ②`waitForIdle` | ・sends 増加(=agent実走) ・transcript の user event text===`/init` ・agent返答 event 存在 ・`/init` へのcommand-output(空文字)event 非存在 ・state.queue===undefined | P0 | 假(無) |
| A3 | seed済 queue entry(projectInit)が boot drain で復活 | `makeService({queued:[...]})` (l.115 既存option) | fixture既存 | `queued:[{taskId, text:PROJECT_INIT_PROMPT, targets:[gaia], projectInit:true, displayText:/init, queuedAt}]` で open | ・boot後 transcript user text===`/init` ・runtime.refreshes===1 ・queue空 | P1 | 假(無) |
| B1 | monad room では `/init` が monad 経路へ落ちず nativeCommandTarget へ固定 | `queue.ts` l.127(init) vs l.153(monadAuthor) の順序 | `makeService({roomId})` + state.json に monad seed(`normalizeRoomState`準拠) | ①monad付き state.json 書込 ②open ③`/init` | ・queue/pendingTurn の targets===[nativeCommandTarget] ・pendingTurn.monad 非true ・monad engine 未起動(dispatch spy 0回) | P0 | 假(無) |
| B2 | activeAgent 有room: `/init` は activeAgent へ、無ければ defaultAgent へ | `src/services/room/agent-commands.ts` `nativeCommandTarget` | `makeService({agents:[gaia,terry]})` | ①state.activeAgent=terry を seed ②`/init` | ・pendingTurn.agentId===terry ・default room(activeAgent無)では gaia | P1 | 假(無) |
| C1 | WAL: pendingTurn に projectInit/displayText が往復する | `turn-loop.ts` markPendingTurn (l.203/476) · `domain/rooms.ts` `pendingTurnFrom` | 中断script(throw)で pendingTurn 残す ・`RoomHandle.open` 直読 | ①`/init` 送信、stream途中で throw ②state.json読 | ・pendingTurn.projectInit===true ・pendingTurn.displayText===`/init` ・pendingTurn.prompt===PROJECT_INIT_PROMPT ・normalizeRoomState 経由で両field保存(round-trip) | P0 | 假(無) |
| C2 | resume(replay path)が projectInit/displayText を落とさない | `queue.ts` resumePending 末尾 (l.487) 複数target | 既存 `an interrupted turn resumes on boot` の流儀 | ①手書き pendingTurn{targets:[gaia,terry], agentId:gaia, projectInit, displayText:/init, eventId予約, partialReply} ②新service open | ・残targetのturnでも refreshContext 発火 ・user event 再記録されぬ(user event数===1) ・その text===`/init` ・pendingTurn 最終undefined | P1 | 假(無) |
| C3 | finish-commit経路 idempotency: eventId 再利用、user二重記録なし | `queue.ts` resumePending finish-commit分岐 | 既存 `crash between transcript append and ack` 流儀 | ①user event `/init` + `evt_committed` reply を先置 ②pendingTurn{eventId:evt_committed, projectInit, displayText} ③open ④再open(2回) | ・agent reply 1件のみ ・user event 1件のみ ・2回目openで新turn無(sends不変) | P0 | 假(無) |
| D1 | model は PROJECT_INIT_PROMPT を受ける / transcript は `/init` のみ | `turn-loop.ts` l.193 `addUserMessage(options.displayText ?? text)` | `makeService({runtimeFactory})` で `send(input)` の prompt を捕捉するspy runtime | `/init` 1発 → idle | ・捕捉prompt に PROJECT_INIT_PROMPT 含 ・捕捉prompt が `/init` と非等 ・transcript user text===`/init`(既存と重複だがspy側が新規) | P0 | 部分(transcript側のみ真) |
| D2 | maybeAutoTitle は displayText を使う(内部promptで題名汚染せぬ) | `turn-loop.ts` l.201 · `service.maybeAutoTitle` | 未題room(title未設定)で `/init` | ・room title が `/init` 由来(≦短) ・title に `Initialize this project` 非含 | P1 | 假(無) |
| D3 | PROJECT_INIT_PROMPT 契約 snapshot(空でない·secret語含む·単一export) | `src/services/project-init.ts` | 直import、依存零 | ・非空 ・`AGENTS.md` 含 ・`secret` 含(除外指示の存在) | P2 | 假(無) |
| E1 | refreshContext は全runtime に、projectInit turn のみ発火 | `turn-loop.ts` l.548 分岐 | `makeService({agents:[gaia,terry,sidia]})` | ①plain message 送信→idle ②`/init`→idle | ・plain後 refreshes 全0(negative·現在未検査) ・init後 全runtime +1(3体で幅検証) | P0 | 部分(2体positiveのみ真·negative無) |
| E2 | cancel された init turn は refreshContext を発火せぬ | `turn-loop.ts` `taskCancelled(task)` gate | `/init` 送信→即 `service.cancel` | ・refreshes===0 ・pendingTurn 最終undefined | P2 | 假(無) |

## 2. 節見出し(実装順推奨)

1. P0束: A1·A2·B1·C1·C3·D1·E1 — durability + routing の骨。
2. P1束: A3·B2·C2·D2。
3. P2束: D3·E2。

## 3. 死枝(検討→棄却)

- 死 `実 /init を実model で走らせる e2e`: 因=room-service testはscripted runtime流儀·model呼出禁·遅延不定。
- 死 `AGENTS.md 実書込の検証`: 因=書込はmodel側行為·daemon契約外。
- 死 `test/monad.test.ts へ B1 を置く`: 因=当file=engine単体(RoomService不使用)。B1はroom-service.test.ts側。
- 死 `全test/ glob をgateにする`: 因=AGENTS.md law(bun node:test 状態漏れ)。触file直指定のみ。

## 4. 未驗 (UNVERIFIED)

- 全案=未実行。file/関数/行番号=d74be4d diff + 現worktree読取(真)、しかしtest実走せず(假)。
- B1 の monad seed 手順=`normalizeRoomState` 準拠と仮定(假)。実際の monad state 形は `test/monad.test.ts` `readRoomMonad`/`activateSetup` 経路で要確認。
- A1 の busy 生成法(遅延script)=既存 `messages sent while busy queue DURABLY` の手口を踏襲する前提(假·当test未精読)。
- D2 の maybeAutoTitle 発火条件(未題room判定)=未読(假)。
