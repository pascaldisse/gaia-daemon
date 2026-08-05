# 車線B仕様: artifact view + Figma様canvas (web/のみ)

## 形
artifact = { id:string, type:"html"|"json"|"design", content:string, updated:number }
design content = JSON: { elements: [{ id, kind:"box"|"text", x, y, w, h, text?, fill?, color?, fontSize? }] }

## 檔(新規、全てweb/src/)
- artifacts.js — state+API stub+検出
- artifact-panel.js — 横窓(overlay panel、#right様式) render
- artifact-canvas.js — Figma様: 選択·drag移動·四隅resize·text dblclick直編
- styles.css追記 — 既存CSS変数(--w-right等, テーマ変数)使用

## API(車線A未定 → stub interface + 注記)
```js
// STUB: 車線A(src/)のartifact保存APIに合わせて差替
// 仮: GET /api/rooms/:room/artifacts → {artifacts:[...]}
//     POST /api/rooms/:room/artifacts/:id → {artifact}
// 未実装時: localStorage "gaia.artifacts.<room>" fallback
```

## ①即座表示
- transcript.js: message内 ```json artifact / ```html fence 或 event payload に artifact 検出 → artifacts.js state 更新 → panel auto開
- 検出=軽く: fence 先頭 `{"artifact":` 或 type付JSON

## ②canvas(design型)
- 単純のみ: 要素click選択(枠表示)、drag移動、四隅handle resize、textはdblclick→contenteditable、Esc解除、Del削除
- html型: sandbox iframe (srcdoc) 表示のみ
- json型: pretty print <pre>

## ③prompt欄
- panel下部 input + 送信 → 既存composer送信路(composer.js の send経路 再利用、prefixで "artifact生成せよ: ..." 送)
- AI返答内 artifact fence → ①経由でcanvas更新

## 統合様式(既存慣習に従え)
- registerRegion("artifacts", renderFn) + markDirty("artifacts") — render.js様式
- dom.js の $/h 使用、他ライブラリ禁
- JSDoc型注釈(既存.js様式)、tsconfig通過必須
- 開閉toggle: statusbar或chrome.jsにボタン一

## 門
cd worktree && bun run check && bun test test/gaia-think 系 (web関連tests) + browser目視screenshot(~/projects/gaia-daemon-laneB-artifact/screenshots/)
各段commit。

## 禁
npm/npx/node/tsx · daemon再起動禁 · /tmp禁 · 新枠組禁 · web/以外触禁
