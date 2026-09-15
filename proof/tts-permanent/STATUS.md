# TTS playback · 2026-09-15
§Recon · base1ecc58d; lane/tts-permanent; live daemon/voice/browser untouched
Backend healthy→Nyari15:15:43,200/44582PCMbytes; no re-probe.
Native app-tools9333 passive screenshot→ended0:22/0:22; console→selected-room subscription only. Original0:04 stall NOT reproduced.
Native debug_server.rs447–474→evaluate/screenshot/navigate only; Network.* unimplemented, empty-success fallback. Live network history unavailable; no injected instrumentation on user screen.
Source hazards→readaloud.js: interruption always migrates; close-await lacks destruction/pause guard; no focus/gesture retries; pending resume never surfaces autoplay denial; no independent stalled-clock watchdog.
Acceptance→actual WKWebView/NMS alt-tab + audible output OPEN; no Chromium substitution claim.
