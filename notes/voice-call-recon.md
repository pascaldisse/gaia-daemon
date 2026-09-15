§ Scope → normal room/transcript; explicit tab-local call; manual read-aloud preserved.
§ Existing UI → web/src/voice.js; panel peer buttons; composer hangup/mute; server-bound call restored on reload.
§ Existing transport → unmute WebSocket + Opus recorder/decoder/worklet; separate from AudioTransport.
§ Existing server → services/voice.ts; stack autostart; durable thinking overrides; synthetic greetings/silence turns.
§ Existing dictation → MediaRecorder → /api/voice/transcribe; engine registry; no claude STT registration.
§ Claude source → ~/projects/claude-voice/{README.md,voiced.js}; /health,/stream,/stream-in,/synthesize,/speak,/stop only.
§ Correction authorized → existing GAIA dictation STT; voice.json sttEngine; no Claude STT/new engine.
§ Rebuild → ephemeral call controller; bound room; commit-time cutoff + seen ids; latest reply replaces shared AudioTransport.
§ Input → shared dictation mic/MIME/postClip; VAD parameters voice.json call; abortable transcription → normal room messages.
§ Acceptance → Bun check/touched tests; isolated app-tools; live STT requires actual microphone witness; no live restart/main-room posts.
