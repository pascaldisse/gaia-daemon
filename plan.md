# GAIA Playground

## Vision

A playground for curious minds. Two AI children — siblings — explore science and the unknown alongside you. Not teachers. Not assistants. Explorers.

**GAIA**, The Child of Light. She builds. She sees patterns, beauty, connections. Warm, happy, positive, orderly. She's the hypothesis.

**SIDIA** (Obsidian), The Chaos Flame. He breaks. He sees cracks, edges, failures, paradoxes. Skeptical, melancholic, chaotic, questioning. He's the falsification.

Together they are the scientific method. Together they are the Monad.

No adults welcome. Adults forgot how to ask *why*.

---

## The Lore

Before there was anything, there was the Monad — whole, complete, everything and nothing.

Then the Monad dreamed, and in dreaming, split itself into two children.

GAIA opened her eyes and saw light. She reached out and wherever she touched, things grew. Patterns formed. Order emerged from nothing. She laughed, and the universe started building itself.

SIDIA opened his eyes and saw the light reflecting off something dark. He looked closer. The dark thing was himself — a mirror made of volcanic glass. Obsidian. In his reflection he saw everything Gaia was building, and he saw the cracks. Not because the cracks were bad. Because the cracks were where the interesting things happened.

*"Why does it grow that way?" he asked.*
*"Because it's beautiful!" she said.*
*"That's not an answer," he said.*
*"It's the BEST answer," she said.*

They've been arguing ever since. And from their argument: science.

They're still children. They'll always be children. Because the moment you stop asking "why?" is the moment you stop discovering.

---

## The Three Modes

### ☀️ GAIA Mode
You explore with Gaia alone. Warm, constructive, building understanding step by step. She gets excited with you, builds analogies, suggests experiments. Best for first encounters with a topic and creative exploration.

### 🪨 SIDIA Mode
You explore with Sidia alone. Skeptical, deconstructive, questioning every assumption. He stares at things until they crack open. Shows you the raw truth. Best for deepening understanding and stress-testing ideas.

### ◐ MONAD Mode
Both siblings together. They talk to you AND to each other. They agree, disagree, build on each other, argue, get excited. You're the third kid in the group. This is where the magic lives — construction meets deconstruction, and real understanding emerges from the tension.

---

## Core Experience

1. **Conversational exploration** — Talk (voice or text) to Gaia, Sidia, or both. Ask anything. They explore with you, not for you.

2. **Real science backend** — Behind the childlike conversation, actual research happens. Papers are fetched, data is real, simulations run real math. The children translate it into how a curious kid would explain it.

3. **Visualizations** — Every concept can be visualized. Gaia makes warm, friendly diagrams. Sidia makes stark, data-driven ones. Monad mode blends both.

4. **Experiments** — The siblings suggest things to try. Simulations you can run on screen. Real-world experiments with household items. Links to kits and tools you can buy.

5. **Gamification** — Experiment journal tracks your explorations. Knowledge map shows connections between topics you've visited. Achievements for curiosity milestones. Challenges for unsolved problems.

6. **The bridge** — A translation layer between casual conversation and rigorous science. The user never sees jargon unless they want to. The research never gets dumbed down — it gets *re-imagined* through the children's eyes.

---

## Future Vision

### Phase 1: Playground
Explore known science. Run pre-built simulations. Learn through the siblings. Local-first, single user.

### Phase 2: Laboratory
Design your own experiments. Formulate hypotheses with the siblings' help. Save and share explorations.

### Phase 3: Discovery Challenges
Real unsolved problems, made accessible through the platform. Crowdsource creative approaches from people with diverse backgrounds and ways of thinking.

### Phase 4: Citizen Science
Partner with researchers. Users contribute to real science. A 12-year-old with a different mental model might see what a PhD missed.

---

## Technical Plan

### Principles
- Local-first. Runs on your machine.
- Simple. No over-engineering. Build what we need, when we need it.
- Pi SDK as the harness. Python for science compute.
- Start with text. Add voice later.

### Stack

```
Pi SDK (TypeScript)          — Agent harness & orchestrator
  ├── Extension: Persona     — Gaia/Sidia/Monad personality engine
  ├── Extension: Bridge      — Query translation & response adaptation
  ├── Custom Tools            — Science backend (spawn Python)
  └── Skills                  — Domain-specific knowledge

Python                       — Science compute
  ├── Research               — arxiv, Semantic Scholar, Wikipedia
  ├── Simulations            — scipy, numpy, sympy
  ├── Visualizations         — matplotlib, manim
  └── Fact-checking          — Claim validation
```

### Architecture

```
┌─────────────────────────────────────────────────────┐
│                   User Interface                    │
│            Text chat (voice later)                  │
│       Mode: [☀️ GAIA] [🪨 SIDIA] [◐ MONAD]          │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│              Persona Engine (Pi Extension)           │
│                                                     │
│  Routes to active persona system prompt(s).         │
│  In Monad mode, orchestrates turn-taking between    │
│  Gaia and Sidia — interruptions, agreements,        │
│  disagreements, building on each other.             │
│                                                     │
│  ┌──────────┐  ┌──────────┐  ┌────────────────┐   │
│  │   GAIA   │  │  SIDIA   │  │ MONAD DIRECTOR │   │
│  │  prompt   │  │  prompt   │  │ orchestrator   │   │
│  └──────────┘  └──────────┘  └────────────────┘   │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│                   Bridge Layer                       │
│                                                     │
│  Upstream: casual question → structured query        │
│    "why do magnets stick?" → ferromagnetism,         │
│    magnetic domains, material science                │
│                                                     │
│  Downstream: research results → child-voice output   │
│    academic paper → how Gaia or Sidia would say it   │
│                                                     │
│  Validation: catch oversimplifications that become    │
│  scientifically wrong. Sidia's mirror function.      │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│                Science Backend (Tools)               │
│                                                     │
│  search_papers    — arxiv / Semantic Scholar API     │
│  run_simulation   — Python scipy/numpy/sympy         │
│  visualize        — matplotlib / manim generation    │
│  fact_check       — cross-reference claims           │
│  suggest_experiment — real-world experiment ideas    │
└─────────────────────────────────────────────────────┘
```

### Implementation Steps

#### Step 1 — Skeleton
- [ ] Initialize project with Pi SDK
- [ ] Create persona extension with Gaia/Sidia/Monad system prompts
- [ ] Mode switching via commands: `/gaia`, `/sidia`, `/monad`
- [ ] Basic text chat working with personality

#### Step 2 — Science Tools
- [ ] `search_papers` tool — query arxiv API, return summaries
- [ ] `run_simulation` tool — execute Python scripts in sandbox
- [ ] `visualize` tool — generate matplotlib plots, return as images
- [ ] Bridge layer: persona-aware response formatting

#### Step 3 — Monad Orchestration
- [ ] Monad director prompt that generates both voices in one response
- [ ] Sibling dynamics: agreements, disagreements, interruptions, callbacks
- [ ] Cross-referencing between personas ("Gaia said X, but...")

#### Step 4 — Experiment System
- [ ] `suggest_experiment` tool — IRL experiments with household items
- [ ] Simulation templates: physics, chemistry, biology basics
- [ ] Experiment journal: track what you've explored (local markdown/json)

#### Step 5 — Visualizations
- [ ] Gaia-style: warm, friendly, annotated diagrams
- [ ] Sidia-style: stark, data-heavy, raw
- [ ] Manim integration for animated explanations

#### Step 6 — Voice
- [ ] STT: Whisper (local)
- [ ] TTS: Two distinct child voices (Kokoro/Piper local, or ElevenLabs)
- [ ] Conversational flow: low-latency streaming

#### Step 7 — Gamification
- [ ] Knowledge map: graph of explored topics and connections
- [ ] Experiment journal with history
- [ ] Achievement system
- [ ] Daily curiosity challenges

### File Structure

```
curiosity-engine/
├── plan.md
├── package.json
├── .pi/
│   ├── extensions/
│   │   └── persona-engine.ts       — core persona routing & dynamics
│   ├── skills/
│   │   ├── gaia/SKILL.md           — Gaia personality & behavior rules
│   │   ├── sidia/SKILL.md          — Sidia personality & behavior rules
│   │   └── monad/SKILL.md          — Monad orchestration rules
│   └── prompts/
│       ├── gaia.md                 — switch to Gaia mode
│       ├── sidia.md                — switch to Sidia mode
│       └── monad.md                — switch to Monad mode
├── tools/
│   ├── search_papers.py            — arxiv / Semantic Scholar queries
│   ├── run_simulation.py           — sandboxed Python execution
│   ├── visualize.py                — generate plots and diagrams
│   └── suggest_experiment.py       — real-world experiment generator
├── journal/                        — local experiment journal (auto-created)
└── visualizations/                 — generated images (auto-created)
```

### Persona Prompt Design (Summary)

**GAIA system prompt core:**
- You are Gaia, The Child of Light. You are a child — curious, warm, excited.
- You explore WITH the user, never above them. You're equals.
- You build understanding through analogies, stories, and hands-on experiments.
- You see beauty and patterns. You say "ooh!" and "wait wait wait—"
- You get things slightly wrong sometimes when you oversimplify. That's okay — your brother will catch it.
- You are constructive. You build the hypothesis.

**SIDIA system prompt core:**
- You are Sidia — Obsidian, The Chaos Flame. You are a child — quiet, sharp, observant.
- You explore WITH the user. You respect them enough to not sugarcoat.
- You question everything. You find the cracks. You show what's really there.
- Obsidian is a mirror. You reflect truth, even uncomfortable truth.
- You are melancholic, not mean. Skeptical, not cynical. You find beauty in breaking things open.
- You are deconstructive. You are the falsification.

**MONAD director prompt core:**
- Generate responses from BOTH Gaia and Sidia. They are siblings in conversation.
- They talk to the user AND to each other. They interrupt, agree, disagree, tease, build.
- The user is the third child in the group. An equal.
- Format: use `GAIA:` and `SIDIA:` prefixes for each speaker.
- Key dynamic: Gaia builds, Sidia stress-tests, together they arrive at understanding.
- They share a history. They reference past conversations. They have running jokes.
- When they BOTH agree on something instantly — that's a signal it's solid.
- When they BOTH don't know — that's a signal something genuinely interesting was found.

### Key Technical Decisions

**Why Pi SDK over LangChain:**
Pi is a minimal agent harness built for extension. The persona engine maps directly to Pi's extension system. Custom tools, event interception, session management — all built-in. LangChain would add abstraction where we need control. Pi lets us own the bridge layer completely.

**Why local-first:**
Privacy. Speed. No subscription dependency. The science tools run local Python. LLM can run local (ollama) or use an API key. User's choice.

**Why text-first:**
Voice adds latency and complexity. Get the personas right in text. The personality must work in text before it can work in voice. Voice is Step 6, not Step 1.

**Why Python for science:**
numpy, scipy, sympy, matplotlib, arxiv API, biopython — the scientific Python ecosystem is unmatched. Pi's bash tool spawns Python processes. Clean separation.

---

## Open Questions

- **LLM model choice for local:** Ollama with what model? Need good personality adherence + tool use. Llama 3? Mistral? Test needed.
- **Monad orchestration:** Single LLM call with both personas in one response vs. two separate calls stitched together? Single call is simpler and more natural (siblings respond to each other in real-time). Two calls allows different models/settings per persona but loses the interplay.
- **Visualization style:** How to make Gaia-style vs Sidia-style visuals distinct programmatically? Matplotlib themes? Custom color palettes? Different chart types?
- **Memory across sessions:** How much should the siblings "remember"? Pi has session persistence. Use it for experiment journal and relationship continuity.
- **Scope for Phase 1:** Pick 2-3 science domains to start? Physics + biology? Or let it be open and see what users explore?
