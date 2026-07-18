
## 2026-07-18 — summarizer meta-text leaks into displayed thinking
Sighting (room chat-mroprax1-r3rn ~22:01): displayed thinking read "I notice
the next thinking appears to be fragmented and incoherent — it seems to be
discussing some kind of code refactoring..." — that is Anthropic's thinking-
summarizer commenting ON raw thinking, rendered by our reveal-thinking path
as if it were the agent's thinking. Display-only (raw blocks ride the
session; cognition unaffected) but confusing/alarming for the user. First
sighting; no recall priors. Candidate fix: detect summarizer meta-voice
lines in claude-thinking-proxy output and tag them visually as
[summarizer] instead of agent thinking.
