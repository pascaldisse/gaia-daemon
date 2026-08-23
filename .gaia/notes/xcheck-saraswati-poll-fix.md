# 交叉検証 — Saraswati(L2陽·読専) 2026-08-23

対象 = Durga `gaia/naru-kimi-mt5xeuvgbctq8d@64dfe86`(fix commit `abe68ed`「test: wait for fake summon task enqueue」)。
編集零·merge零·Durga枝不触。本notesのみ。

## 検体
- 読専worktree `.gaia/worktrees/xcheck-saraswati` = detached `64dfe86`(`submodule update --init design`)。
- 逆証worktree `.gaia/worktrees/xcheck-revert` = detached `64dfe86` + **未commit**改変。
- `abe68ed` 差分 = `waitFor(cond,msg)` helper 追加 + 固定sleep廃止 4箇所:
  `:239`(summonAndWait) · `:319`(nested outer/leaf) · `:835` · `:856`(insight ledger)。
  → 先任 Brahma の「未命事項(同形固定sleep)」= 全件処置済。

## atom① 実測(fix後)
```
SOLO       summons.test.ts        RED=0/30
LOAD(5file並走×10)  summons      RED=0/10
                    room-service RED=0/10
                    pi-runtime   RED=0/10
                    cli-tools    RED=0/10
                    caryll       RED=10/10   ← 場外(atom③)、集計除外
```
先任数値と並置:
| 項 | 修正前 | Durga後(先任) | 本lane再測 |
|---|---|---|---|
| E2E resume callback `:816` | 9/50 ≈18% | 0/30 · 0/10 | 0/30 · 0/10 |
| summonAndWait 5000ms timeout | 1/30 · 1/10 | (未) | 0/30 · 0/10 |

## atom② 逆証(poll が真に荷を負うか)
未commit worktree で `waitFor` → 固定sleep へ戻す:
```
sleep 20ms 復元 · SOLO            RED=0/30
sleep 20ms 復元 · LOAD(4file並走)×20  RED=0/20
sleep  0ms                        RED=12/12  ← 全件 (fail) summonAndWait … [5000ms]
poll 版(xcheck-saraswati)        RED=0/30
```
∴ 失敗式は **enqueue 前の settle()**(`:124 settle(){ const task=tasks.at(-1); if(!task) return; }`)で確定。
0ms で確率 0→1 に振れ、poll で 1→0。**poll化は荷を負う。真。**
**但し 20ms 版は本機・本負荷では赤を出さず**(0/50)→ 20ms の脆さは環境依存(先任機では 1/30)。
poll化の価値 = 「速い機では偶々緑」を**機構的に消す**点。時間依存の除去であって、本機での赤修理ではない。

## atom③ 場外
`test/caryll.test.ts:45` = 実機 `~/.gaia/agents/nyari/persona/memory/episodes.jsonl` 依存 → 10/10 常赤。
本lane RED 集計から **除外**(負荷源としてのみ並走させた)。別lane案件、Durga修正とは無関係。

## 未驗印
- 20ms版の赤を本機で再現できず ∴ 「修正前→修正後」の直接 before/after は本機未成立(0ms代替で機構証明)。
- 全test glob での回帰 = 未(家法: 触れたfileのみ)。
- `bun run check` = 碼変更零 ∴ 該当無 / 未走。
