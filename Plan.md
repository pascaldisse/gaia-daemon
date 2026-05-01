# GAIA Playground Plan

## Vision

GAIA Playground is a local-first curiosity engine: a place to explore science and the unknown with two AI children, not adult lecturers.

- **Gaia, the Child of Light** builds. She is warm, constructive, pattern-seeking, playful, and hopeful. She is the hypothesis.
- **Sidia, the Child of the void**  Full name: [Obsidian, the Chaos Flame], breaks. Spirit animal: fractal, favourite emotion: longing, melancholy, color: violet, She is skeptical, precise, crack-finding, melancholic but not cruel. She is the falsification.
- **Monad** is the synthesis: a director/orchestrator that lets construction and deconstruction work together.

Together, Gaia and Sidia embody the scientific method: wonder plus doubt, creation plus stress test, imagination plus rigor. The long-term product should feel like exploring with brilliant curious siblings who can translate between childlike questions and real science.

## Current V1 Summary

The current implementation is a minimum viable standalone CLI wrapper around the Pi SDK.

Implemented:

- TypeScript/Node project skeleton with `gaia` CLI entry point.
- `gaia init` setup flow for `~/.gaia/config.yaml` and memory files.
- Three persona modes:
  - `/gaia`
  - `/sidia`
  - `/monad`
- Separate Pi SDK sessions for Gaia, Sidia, and Monad.
- Persona prompt files for Gaia, Sidia, and Monad.
- Configurable per-persona provider/model/thinking/tool settings with Pi default fallback.
- Basic terminal conversation loop with active mode/model status.
- Simple Monad orchestration: Monad responds first, then routes compact context to Gaia and Sidia.
- Markdown memory under `~/.gaia/memories/`:
  - `USER.md`
  - `GAIA.md`
  - `SIDIA.md`
- Frozen memory snapshot injection at persona session start.
- `memory` custom tool for add/replace/remove operations.
- Bounded memory limits, duplicate detection, atomic writes, and lightweight unsafe-memory filtering.
- Pi built-in coding tools available through persona sessions.
- Conservative safety confirmation extension for risky tool calls.
- Future seams for web search and artifacts/visualizations.
- README with setup, usage, memory, and scope.

## What Still Needs To Be Done

### Near-term hardening

- Add unit tests for:
  - config loading and default creation
  - slash command parsing
  - memory add/replace/remove/limit/unsafe-pattern behavior
  - risk detection rules
- Smoke-test real Pi model interaction across all three modes.
- Improve error messages for missing Pi auth/model configuration.
- Decide whether sessions should be clearly separated per persona on disk rather than all using the same project session manager defaults.
- Improve the terminal UI beyond the current readline loop if needed, possibly using Pi TUI components directly.
- Add memory usage display to the status line.

### Persona and orchestration improvements

- Make Monad's routing more explicit: let Monad choose whether Gaia, Sidia, or both should respond.
- Add richer sibling dynamics in Monad mode: disagreement, callback, synthesis, and final joint takeaway.
- Decide whether Monad should get its own `MONAD.md` memory file or only coordinate shared/Gaia/Sidia memory.
- Tune Gaia and Sidia prompts through real conversations.

### Science playground features

- Add a bridge layer that translates casual questions into structured science queries and translates technical results back into persona voice.
- Implement science tools:
  - paper/web search
  - fact checking
  - Python simulation runner
  - visualization generation
  - real-world experiment suggestions
- Start with a small domain slice, such as basic physics simulations, before broad general science.

### Visuals, journal, and artifacts

- Implement generated artifact support for images/HTML/plots.
- Create distinct Gaia/Sidia visualization styles.
- Add a local experiment journal and exploration history.
- Add a knowledge map of explored topics.

### Later vision

- Voice input/output with distinct Gaia and Sidia voices.
- Gamification: achievements, curiosity challenges, experiment streaks.
- Citizen-science workflows where users can contribute observations or hypotheses.
- Optional web UI while preserving local-first operation.

## Guiding Decisions

- Use Pi SDK instead of LangChain/LangGraph; Pi already provides sessions, model routing, tool use, streaming, and extension seams.
- Stay local-first where practical.
- Keep the first version small and usable before adding science backends.
- Text-first; voice comes later.
- Python is the preferred future science-compute layer because of numpy, scipy, sympy, matplotlib, and related ecosystems.


- TODO: figure out how Hermes works and how open claw works
- add engineer agent: Terry (Bear), a Teddy bear with the divine spark of the HolyC(hild), always direct, short, no bs, acts according to the HolyC-Bible (coding guidelines). Ability to change Bible: default: HolyC-Bible New Testament (holy-c style simplicity but can work on modern projects as well). HolyC-Bible Old Testament (full unfiltered Terry Davis style, c or holyC only, changes behaviour too (more cursing))
- so we have 3 agents and the monad is the silent orchestrator (decides who can speak and might manage permissions in the future)
- Sidia: the chaos flame is an adversary but also creates entropy (need to figure out how this would be helpful and how this can be implemented)
- Gaia: is more guiding and orderly