# Read-aloud playback — state machine, failure modes, recovery

Owner file: `web/src/readaloud.js` (`AudioTransport`). Server side:
`src/services/read-aloud.ts`. Tests: `test/readaloud-transport.test.ts`.
This doc exists because the same class of bug ("player shows PLAYING,
progress advances, no sound") has recurred 09-01 / 09-04 / 09-15 / 09-19 /
09-21 / 09-22 — each prior fix patched a real but narrower cause. This is the
current full picture; update it in the same commit as the next fix instead of
leaving tribal knowledge in commit messages only.

## 1 · State machine

```
 constructed --play()--> playing --pause()--> paused --play()--> playing
     |                      |  ^                                    |
     |                      |  | append() (armed, !userPaused)      |
     |                      |  \------------------------------------/
     |                      |
     |                 checkProgress() / onstatechange / devicechange
     |                      |
     |                      v
     |               rebuildDeadOutput() --bounded retry--> migrateContext()
     |                      |                                   |
     |                      | budget exhausted                  | success
     |                      v                                   v
     |                  dead (outputDead=true,             playing (rebuilds++,
     |                  terminal, user must ⟳)             recovered badge)
     |
     \--markDone() + frontier>=total + sources empty--> ended (_maybeFinish)
```

`playing` / `userPaused` / `_armed` / `outputDead` / `_migrating` /
`_awaitingAudioUnlock` are the governing booleans; `ctx.state` (`suspended` /
`running` / `closed` / `interrupted`) is the browser's own AudioContext state,
tracked separately because it can disagree with what the UI believes.

Shared-context page players (`sharedContext: true`, the composer's read-aloud
button) additionally gate every context (re)creation behind a captured user
activation (`pointerdown`/`keydown`) — `unlockSharedAudioContext()` /
`waitForPageAudioContext()` / `adoptSharedContext()` — because constructing an
`AudioContext` outside a gesture is throttled/suspended by browser autoplay
policy (see `design/READALOUD-REGRESSION.md` probe 1: an *untrusted* synthetic
click reproduces exactly this class of "stuck suspended, never plays").

## 2 · Failure → detector → recovery

| # | Failure mode | Symptom | Detector | Recovery | Added |
|---|---|---|---|---|---|
| A | Server sends a clean EOF on a mid-stream failure | Clip stops N seconds short, silently, no error | `pcmFrames === 0` throws | client surfaces `onError` | 09-01 (`9c56279`) |
| B | `ctx.resume()` rejects/never resolves at `play()` | Stuck `suspended`, never starts | `2d8cae9`: `onError` when `state !== 'running'` after resume | visible error, no silent stall | 09-01 |
| C | Finish races a late in-flight append (the "1:55 of 2:03" stall) | Playback stops 8s short of the real total, player looks finished | `_maybeFinish()` re-checks `_appendSeq` on a microtask | `append()` re-arms (`_armed && !userPaused`) instead of dropping the tail | pre-09-15 |
| D | Frozen/closed `AudioContext` (dead output, OS audio session interruption) | `ctx.state !== 'running'`, or `state==='running'` but `currentTime` stalls | `checkProgress()` watchdog: `advance < minClockAdvanceSeconds` over `stallSeconds` | `rebuildDeadOutput()` → bounded `migrateContext()`, PCM retained | 09-15 (`f1df3760`, `baba0ab1`) |
| E | Bluetooth/device add-remove during playback | Same as D, tied to a device event | `mediaDevices.devicechange` listener → `rebuildDeadOutput()` — **gated on media-capture permission in WebKit: the page never calls `getUserMedia`, so per MDN ("the user must have granted permission to use a media device" — [MediaDevices: devicechange event](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/devicechange_event)) this listener does not fire for a default-OUTPUT-only reassignment on this page; kept only as defense-in-depth, not a working detector for H's case — see H** | same bounded rebuild path as D | 09-15/09-19 |
| F | Autoplay-blocked / shared-context resume racing a later gesture | PCM buffered but never scheduled | `_awaitingAudioUnlock`, `waitForPageAudioContext()` | next captured gesture calls `adoptSharedContext()`, resumes at `pausedSample` | 09-21 (`28d6398f`) |
| **G** | **`ctx.currentTime` keeps advancing normally into a dead route — WebKit does not reliably fire `devicechange` for a default-OUTPUT reassignment that isn't itself a device add/remove (e.g. macOS Sound-menu AirPods↔speakers switch with both devices still present)** | **Player shows PLAYING, progress bar advances, `ctx.state==='running'`, zero audible sound — the exact 09-22 report** | **`AnalyserNode` in the signal path: `analyser.connect(ctx.destination)` at `web/src/readaloud.js:174`, i.e. `source → analyser → destination`, downstream of every scheduled source but UPSTREAM of the hardware. GRAPH-LEVEL ONLY — it measures the rendered WebAudio signal, not physical hardware output. WebKit keeps rendering into the AudioContext's birth device; after a pure output-route switch the graph stays loud and `checkProgress()`'s RMS sample stays non-silent, so this watchdog CANNOT see a dead-hardware switch (live proof 09-23, whip 461: player at 0:12/1:45, no sound, no recovery, `ctx.state==='running'`, analyser RMS non-silent) — it only catches a genuinely silent/frozen render graph (dead source, stuck decode)** | same `rebuildDeadOutput()` → `migrateContext()` path as D; successful rebuild sets `recovered=true` for 4s → green "✓ recovered" badge | 09-22 |
| **H** | **Hardware default-output device switch while the graph keeps rendering (speakers↔AirPods) — the exact gap G cannot cover, 3rd recurrence 09-23, whip 461** | **Same symptom as G but G's own detector never fires (graph-level only, see G)** | **NEW: native (gaia-shell, `src-tauri`) `AudioObjectAddPropertyListenerBlock` on `kAudioObjectSystemObject`/`kAudioHardwarePropertyDefaultOutputDevice` → debounced (param, default 250ms) → `evaluateJavaScript` dispatches a `window` CustomEvent `gaia:output-device-changed` (`OUTPUT_DEVICE_CHANGED_EVENT` in `web/src/readaloud.js`) into every live `WKWebView`; `readaloud.js` listens on `window` and calls the same `rebuildDeadOutput()`** | same bounded rebuild path as D/E/G | **09-23 (this fix)** |

D/E/G/H all funnel into the *same* bounded-retry primitive (`rebuildDeadOutput`
→ `migrateContext`, budget = `maxStalledRebuilds`, default 2, then terminal
`_deadOutput()`), so the new detector adds one more *trigger*, not a new
recovery mechanism — this keeps the retry budget, PCM retention, and
shared-context gesture rules identical across every failure class. H is the first detector below the WebAudio graph, at the actual OS hardware-routing layer — the only one of D/E/G/H that can observe a live-but-silent hardware switch.

### Why G evaded every previous fix
Every prior fix instrumented `ctx.currentTime`, `ctx.state`, or the device
list — all *upstream* of the browser's actual hardware I/O. WebKit's own
render clock can keep incrementing `currentTime` at normal real-time rate
even when the bound output device is no longer live (this is explicitly
documented in `migrateContext`'s own comment, added 09-15, and never acted on
until now). None of A–F's detectors can distinguish "clock advancing because
audio is playing" from "clock advancing because the render loop free-runs into
a dead sink" — both look identical from `ctx.currentTime`/`ctx.state` alone.
An `AnalyserNode` reads energy *inside* the WebAudio graph, one hop closer to
the render callback that a genuinely dead device would also stop refreshing;
it is the cheapest client-observable proxy for "the render loop is still
actually being pulled", short of a native (Tauri/Rust) CoreAudio
default-output-device listener (out of scope for this JS-only fix — see
UNVERIFIED).

## 3 · Watchdog parameters (`AudioTransport` constructor, all overridable)

| param | default | meaning |
|---|---|---|
| `watchdogMs` | 1000 | `checkProgress()` tick interval |
| `stallSeconds` | 2 | observation window before the clock-advance check judges D |
| `minClockAdvanceSeconds` | 0.5 | minimum `ctx.currentTime` delta per window to count as "advancing" |
| `contextCloseTimeoutMs` | 3000 | bound on `ctx.close()` during a rebuild |
| `maxStalledRebuilds` | 2 | rebuild budget before terminal `outputDead` |
| **`silenceSeconds`** | **3** | **sustained-silence window (G) before a rebuild fires — longer than any natural TTS pause** |
| **`silenceThreshold`** | **0.0015** | **RMS floor below which the analyser reading counts as silent — comfortably below any real speech energy** |
| **`outputDeviceChangeDebounceMs`** (native, `gaia-shell`) | **250** | **debounce window on the CoreAudio default-output-device listener before dispatching `gaia:output-device-changed` — avoids a duplicate-event storm mid-switch** |

## 4 · Regression tests (`test/readaloud-transport.test.ts`), by the date each bug shipped

- **zero-frame (09-01)** — `pcmFrames === 0` throws instead of a silent empty clip.
- **stall-8s-short (09-04 class / "1:55 of 2:03")** — `"audio arriving after a finish re-arms playback"`.
- **stale-queued (09-15 class)** — `"a late append is not stranded when the finish check races it"`, `"a pending append blocks the finish"`.
- **suspended-no-PCM (09-21 class)** — `"suspended shared context with no buffered PCM waits for unlock without rebuilding"`, `"autoplay-blocked PCM remains unscheduled until output is actually running"`.
- **silent-while-playing/device-switch (09-22, this fix)** — `"silent output while the clock advances normally → rebuild without waiting for a stalled clock; recovers audibly (09-22 device-switch)"` + `"silence detector ignores a genuine download underrun (nothing scheduled) and a user pause"` (false-positive guard).
- **native-output-device-switch (09-23, this fix, whip 461 3rd recurrence)** — `"native output-device-changed event rebuilds while playing, no-ops while paused"` + `"native output-device-changed event while never playing does not rebuild"`.

All 35 tests in the file pass together (`bun test test/readaloud-transport.test.ts`; was 33 before this fix); the new `FakeAnalyser` defaults to `energy = 1` (loud) so none of the pre-existing tests changed behavior.

## 5 · UNVERIFIED

- **Not reproduced live end-to-end with a real macOS default-output switch
  during this fix** (no live AirPods↔speakers toggle was performed on the
  running app during the fix window — whip 154 forbids daemon
  restarts/kills, and toggling Pascal's live audio devices out from under him
  was avoided as too disruptive mid-task). The mechanism (G) is derived from
  `migrateContext`'s own pre-existing, dated code comment plus the observed
  09-22 symptom matching it exactly; the fix is a real, tested detector for
  "clock fine, no energy", not a reproduction of the exact device-switch
  trigger.
- **Whether WebKit's `devicechange` truly never fires for a default-only
  reassignment (vs. sometimes-but-unreliably)** — asserted from the existing
  code comment (09-15) and public WebKit behavior reports, not instrumented
  fresh in this session.
- **AnalyserNode ground truth**: it taps the WebAudio graph's own render
  path, not physical hardware. If a future WebKit build keeps *both*
  `ctx.currentTime` *and* the analyser's render callback free-running into a
  fully dead sink (i.e. the render loop never actually stalls even absent
  hardware), this detector would not catch it either. A native (Tauri/Rust
  CoreAudio) bridge is now added as H — see below.
- **Deploy lag as a compounding cause**: the running `/Applications/
  gaia-daemon.app` build (Sep 19 19:31) was found to predate the 09-21
  `28d6398f` shared-context commit already in `main` — i.e. Pascal was
  running code *older* than the last "permanent" fix when this bug was
  reported. Whether every 09-01→09-22 "regression" was a real code
  regression vs. some fraction being stale-build lag was not fully
  disambiguated; this fix's activation step (below) closes that gap for now
  by hot-patching the served asset directly, but the underlying
  build→install cadence gap is a process issue, not a code one.
- **H (native CoreAudio detector) is UNVERIFIED end-to-end**: the Rust/Swift-side listener and JS listener are each unit- and code-tested, but the running `/Applications/gaia-daemon.app` `gaia-shell` binary was NOT restarted during this fix (whip law: never kill/restart the live shell) — only `web/src/readaloud.js` is hot (server serves `web/` with `no-store`). H requires the newly-built `gaia-shell` binary to be installed and the app relaunched before it takes effect; until then, live traffic still has zero coverage for the hardware-switch case beyond G's (known-insufficient) graph check. See the fix commit message / summon report for the exact staged binary path and install step.
- **H not reproduced live with a real AirPods↔speakers toggle** (same reasoning as G's equivalent bullet — no live device toggle was performed mid-task; the debounced dispatch path was verified by code reading + the Rust build succeeding, not a live CoreAudio callback firing).
