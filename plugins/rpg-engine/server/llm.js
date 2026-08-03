/**
 * server/llm.js — LlmClient interface + DeepSeek adapter + Mock client.
 *
 * EXTENSION SEAM: add new providers by implementing the LlmClient interface
 * and adding a branch in createLlmClient(). The engine never references
 * a specific provider.
 *
 * SECURITY: API key is read ONLY from process.env, never logged, never
 * written to any file, never sent to the client.
 */

import OpenAI from 'openai';

// ---- LlmClient interface (documentation, not enforced) ----
//
// class LlmClient {
//   async *stream(messages, opts) → yields {delta}
//   async complete(messages, opts) → {text, usage}
//   async structured(messages, zodSchema, opts) → Zod-validated object
// }

// ---- Reasoning-leak stripper ----
//
// DeepSeek sometimes leaks an inline reasoning preamble into message content
// despite thinking:{type:'disabled'} — shape observed: text begins with a
// bracket tag like '[分析]' followed by numbered analysis lines, then
// (optionally) a section tag like '[叙述]' and/or a blank line, then the
// real narration. Also guards against stray <think>...</think> blocks.

const REASONING_TAG_RE = /^\[(分析|思考|推理|analysis|reasoning|thinking)\]/i;
const SECTION_TAG_LINE_RE = /^\[[^\]\n]+\]\s*$/;
const BLANK_LINE_RE = /\n\s*\n/;

/**
 * Strip leaked reasoning preambles from a complete text block.
 * Never destroys clean text: if the text doesn't start with a reasoning
 * tag or <think>, it is returned trimmed and untouched.
 * @param {string} text
 * @returns {string}
 */
export function stripReasoning(text) {
  if (!text) return '';

  let out = text;

  // Remove all <think>...</think> blocks (non-greedy, global, dotall).
  out = out.replace(/<think>[\s\S]*?<\/think>/g, '');

  // Unclosed <think> at the start → drop everything.
  if (/^\s*<think>/i.test(out) && !/<\/think>/i.test(text)) {
    return '';
  }

  const trimmed = out.trim();
  if (!REASONING_TAG_RE.test(trimmed)) {
    // Not a reasoning preamble — never destroy clean text.
    return out === text ? text.trim() : trimmed;
  }

  // Look for the next section-tag line (e.g. [叙述], [narration]) — return
  // everything after it.
  const lines = trimmed.split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (SECTION_TAG_LINE_RE.test(lines[i].trim())) {
      return lines.slice(i + 1).join('\n').trim();
    }
  }

  // Else fall back to the first blank line — return everything after it.
  const blankMatch = trimmed.match(BLANK_LINE_RE);
  if (blankMatch) {
    return trimmed.slice(blankMatch.index + blankMatch[0].length).trim();
  }

  // Whole thing was analysis.
  return '';
}

/**
 * Stateful filter for the streaming path — buffers the head of a delta
 * stream to detect a leaked reasoning preamble before any tokens reach
 * the live broadcast, then passes everything through untouched once it's
 * clear the stream is (or has become) clean narration.
 */
export class ReasoningStreamFilter {
  #buffer = '';
  #passthrough = false;

  /**
   * Feed the next delta chunk.
   * @param {string} delta
   * @returns {string} — text safe to emit now (may be '')
   */
  push(delta) {
    if (this.#passthrough) return delta;

    this.#buffer += delta;

    const head = this.#buffer.replace(/^\s+/, '');
    if (head.length === 0) return '';

    // A first char that isn't '[' or '<' can never become a reasoning tag
    // or a <think> block, however few chars we've seen — decide right away.
    const ambiguous = head[0] === '[' || head[0] === '<';
    if (!ambiguous) {
      this.#passthrough = true;
      const out = this.#buffer;
      this.#buffer = '';
      return out;
    }

    if (this.#buffer.length < 16) {
      // Not enough buffered yet to tell '<think' apart from an unrelated
      // '<'-prefixed string, or to locate a strip boundary — keep buffering.
      return '';
    }

    const looksLikeReasoning = head.startsWith('[') || /^<think/i.test(head);
    if (!looksLikeReasoning) {
      // Clearly clean — flip to passthrough and release the buffer.
      this.#passthrough = true;
      const out = this.#buffer;
      this.#buffer = '';
      return out;
    }

    // Looks like reasoning — try to find the strip boundary already.
    return this.#tryDrainReasoning();
  }

  /** Attempt to strip the buffered reasoning preamble; returns emittable text or ''. */
  #tryDrainReasoning() {
    // Closed <think> block.
    const thinkClose = this.#buffer.match(/<\/think>/i);
    if (thinkClose) {
      const rest = this.#buffer.slice(thinkClose.index + thinkClose[0].length);
      this.#buffer = '';
      this.#passthrough = true;
      return rest;
    }

    const trimmed = this.#buffer.replace(/^\s+/, '');
    if (REASONING_TAG_RE.test(trimmed)) {
      const lines = trimmed.split('\n');
      for (let i = 1; i < lines.length; i++) {
        if (SECTION_TAG_LINE_RE.test(lines[i].trim())) {
          const rest = lines.slice(i + 1).join('\n');
          this.#buffer = '';
          this.#passthrough = true;
          return rest;
        }
      }
      const blankMatch = trimmed.match(BLANK_LINE_RE);
      if (blankMatch) {
        const rest = trimmed.slice(blankMatch.index + blankMatch[0].length);
        this.#buffer = '';
        this.#passthrough = true;
        return rest;
      }
    }

    // Boundary not found yet — keep buffering.
    return '';
  }

  /**
   * Flush any remaining buffered text at the end of the stream, applying
   * stripReasoning to whatever wasn't already resolved.
   * @returns {string}
   */
  flush() {
    if (this.#passthrough) return '';
    const out = stripReasoning(this.#buffer);
    this.#buffer = '';
    return out;
  }
}

// ---- DeepSeek client ----

export class DeepSeekClient {
  #client;
  #model;
  #sessionId;

  /**
   * @param {object} opts
   * @param {string} opts.apiKey       — DeepSeek API key (from env)
   * @param {string} [opts.baseURL]    — default https://api.deepseek.com
   * @param {string} [opts.model]      — default deepseek-v4-flash
   * @param {string} [opts.sessionId]  — passed as user_id for cache isolation
   */
  constructor({ apiKey, baseURL, model, sessionId }) {
    if (!apiKey) {
      throw new Error('DeepSeekClient requires an apiKey');
    }
    this.#client = new OpenAI({
      apiKey,
      baseURL: baseURL || 'https://api.deepseek.com',
      timeout: 120_000,
    });
    this.#model = model || 'deepseek-v4-flash';
    this.#sessionId = sessionId || 'default';
  }

  /**
   * Stream narration tokens for live broadcast.
   * @param {Array<{role:string,content:string}>} messages
   * @param {object} [opts]
   * @param {number} [opts.maxTokens]  — default 4096
   * @returns {AsyncIterable<{delta:string}>}
   */
  async *stream(messages, opts = {}) {
    const maxTokens = opts.maxTokens || 4096;
    const stream = await this.#callWithRetry(() =>
      this.#client.chat.completions.create({
        model: this.#model,
        messages,
        stream: true,
        max_tokens: maxTokens,
        ...this.#extraBody(),
      })
    );

    const filter = new ReasoningStreamFilter();
    for await (const chunk of stream) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        const clean = filter.push(delta);
        if (clean) {
          yield { delta: clean };
        }
      }
    }
    const rest = filter.flush();
    if (rest) {
      yield { delta: rest };
    }
  }

  /**
   * Non-streaming completion call.
   * @param {Array<{role:string,content:string}>} messages
   * @param {object} [opts]
   * @param {number} [opts.maxTokens] — default 4096
   * @returns {Promise<{text:string, usage:object}>}
   */
  async complete(messages, opts = {}) {
    const maxTokens = opts.maxTokens || 4096;
    const response = await this.#callWithRetry(() =>
      this.#client.chat.completions.create({
        model: this.#model,
        messages,
        max_tokens: maxTokens,
        ...this.#extraBody(),
      })
    );

    const text = response.choices?.[0]?.message?.content || '';
    return { text: stripReasoning(text), usage: response.usage || {} };
  }

  /**
   * Structured output call — JSON mode + lenient parse + Zod validation.
   * @param {Array<{role:string,content:string}>} messages
   * @param {import('zod').ZodSchema} schema — Zod schema to validate against
   * @param {object} [opts]
   * @param {number} [opts.maxTokens] — default 4096
   * @param {number} [opts.parseRetries] — re-asks on LlmParseError before throwing;
   *   default 1, falls back to env TTRPG_LLM_PARSE_RETRIES
   * @returns {Promise<{parsed:object, raw:string, usage:object}>}
   */
  async structured(messages, schema, opts = {}) {
    const maxTokens = opts.maxTokens || 4096;
    const parseRetries = opts.parseRetries ?? Number(process.env.TTRPG_LLM_PARSE_RETRIES ?? 1);

    // JSON mode requires the word "json" in the prompt and response_format
    const jsonMessages = [...messages];
    // Ensure the last message mentions JSON
    const last = jsonMessages[jsonMessages.length - 1];
    if (last && last.role === 'user') {
      last.content = `${last.content}\n\nYou must respond with valid JSON only.`;
    } else {
      jsonMessages.push({ role: 'user', content: 'You must respond with valid JSON only.' });
    }

    return withParseRetry(() => this.#structuredOnce(jsonMessages, schema, maxTokens), parseRetries);
  }

  async #structuredOnce(jsonMessages, schema, maxTokens) {
    const response = await this.#callWithRetry(() =>
      this.#client.chat.completions.create({
        model: this.#model,
        messages: jsonMessages,
        max_tokens: maxTokens,
        response_format: { type: 'json_object' },
        ...this.#extraBody(),
      })
    );

    const raw = response.choices?.[0]?.message?.content || '';
    const usage = response.usage || {};

    // Lenient parse
    const { parseModelOutput } = await import('../shared/parse.js');
    const parseResult = parseModelOutput(raw);

    if (!parseResult.ok || !parseResult.value) {
      throw new LlmParseError('Failed to parse structured output', raw, parseResult.error);
    }

    // Zod validate
    const zodResult = schema.safeParse(parseResult.value);
    if (!zodResult.success) {
      throw new LlmParseError(
        'Structured output failed schema validation',
        raw,
        zodResult.error.errors.map(e => `[${e.path.join('.')}] ${e.message}`).join('; ')
      );
    }

    return { parsed: zodResult.data, raw, usage };
  }

  // ---- internals ----

  #extraBody() {
    return {
      thinking: { type: 'disabled' },
      user_id: `session-${this.#sessionId}`,
    };
  }

  async #callWithRetry(fn) {
    let attempt = 0;
    const maxAttempts = 3;
    while (true) {
      try {
        return await fn();
      } catch (e) {
        attempt++;
        const status = e.status || e.code;
        // 429, 500, 503 → retry with backoff
        if ((status === 429 || status === 500 || status === 503 || status === 'rate_limit_exceeded')
            && attempt < maxAttempts) {
          const delay = Math.min(1000 * Math.pow(2, attempt - 1), 8000);
          console.warn(`[llm] API error ${status}, retrying in ${delay}ms (attempt ${attempt}/${maxAttempts})`);
          await new Promise(r => setTimeout(r, delay));
          continue;
        }
        throw e;
      }
    }
  }
}

// ---- Mock client (no network, deterministic) ----

export class MockLlmClient {
  #sessionId;

  constructor({ sessionId } = {}) {
    this.#sessionId = sessionId || 'mock';
  }

  /**
   * Yields canned text branching on opts.role:
   *   - 'dm' → narrative world-voice prose
   *   - 'npc' → short in-character quoted line echoing input
   *   - default → legacy P1 narration
   */
  async *stream(messages, opts = {}) {
    const actionText = this.#extractActionText(messages);
    const role = opts.role || 'dm';

    let parts;
    if (role === 'npc') {
      const snippet = (actionText || 'hello').slice(0, 40);
      parts = [
        `"Ah, `,
        `'${snippet}'`,
        ` you say? `,
        `Aye, I've heard stranger things in this tavern."`,
      ];
    } else {
      parts = [
        `You ${actionText || 'act'}. `,
        `The world responds to your action. `,
        `The air is thick with possibility. `,
        `The scene shifts subtly around you. `,
        `What will you do next?`,
      ];
    }

    for (const part of parts) {
      await new Promise(r => setTimeout(r, 50));
      yield { delta: part };
    }
  }

  async complete(messages, _opts = {}) {
    const actionText = this.#extractActionText(messages);
    return {
      text: `You ${actionText || 'act'}. The world responds.`,
      usage: { prompt_tokens: 100, completion_tokens: 20 },
    };
  }

  /**
   * Returns a deterministic result branching on opts.role:
   *   - 'adjudicate' → P3: keyword-heuristic ruling
   *   - 'routing' → returns {targets:[<first present npc>], note:''}
   *   - default → legacy P1 op batch
   */
  async structured(messages, _schema, opts = {}) {
    const actionText = this.#extractActionText(messages);

    // ---- P3: Adjudicate branch ----
    if (opts.role === 'adjudicate') {
      return this.#mockAdjudicate(actionText, messages);
    }

    // ---- P3: Canonize branch (narrate-then-canonize) ----
    if (opts.role === 'canonize') {
      return this.#mockCanonize(actionText);
    }

    // ---- C3/C4: improvised combat action → check + status/hazard/board-exploit ----
    if (opts.role === 'combat-adjudicate') {
      const txt = (actionText || '').toLowerCase();
      const sys = JSON.stringify(messages);
      const target = (sys.match(/npc-[a-z0-9-]+/) || ['npc-imp-1'])[0];
      // zone of the first enemy: "npc-...@<zone>"
      const zone = (sys.match(/npc-[a-z0-9-]+@([a-z0-9-]+)/) || [])[1] || 'field';
      // C4: set a surface alight ("kick the brazier into the oil")
      if (/brazier|oil|fire|torch|ignite|flame|burn/.test(txt)) {
        return this.#jsonResult({ checks: [{ check: 'necro-test', dc: 1, reason: 'kicking the brazier into the oil' }], ops: [{ op: 'spawnHazard', zoneId: zone, kind: 'fire', magnitude: 3, remaining: 3 }] });
      }
      // C4: exploit the board ("shove it off the balcony edge") — lethal on a ledge
      if (/shove|push|throw .* off|balcony|ledge|edge|over the rail/.test(txt)) {
        return this.#jsonResult({ checks: [{ check: 'necro-test', dc: 1, reason: 'shoving it off the edge' }], ops: [{ op: 'damage', id: target, amount: 6 }] });
      }
      if (/sand|dirt|eyes|blind|grit/.test(txt)) {
        return this.#jsonResult({ checks: [{ check: 'necro-test', dc: 1, reason: 'flinging grit in its eyes' }], ops: [{ op: 'applyStatus', id: target, kind: 'blind', remaining: 2 }] });
      }
      if (/trip|knock|tackle/.test(txt)) {
        return this.#jsonResult({ checks: [{ check: 'necro-test', dc: 1, reason: 'knocking it down' }], ops: [{ op: 'applyStatus', id: target, kind: 'stun', remaining: 1 }] });
      }
      return this.#jsonResult({ checks: [], ops: [] });
    }

    // ---- C3: morale-broken enemy decision ----
    if (opts.role === 'combat-decide') {
      return this.#jsonResult({ intent: 'flee', say: "This ain't worth dyin' for — I'm gone!" });
    }

    // ---- P8: Worldgen branch (deterministic "charge with meaning") ----
    if (opts.role === 'worldgen') {
      return this.#mockWorldgen(messages);
    }

    // Routing mode: return JSON routing result
    if (opts.role === 'routing') {
      // Extract first NPC id from the present NPCs list in the prompt
      const npcIdMatch = (actionText || '').match(/"(npc-[^"]+)"/) || [];
      return {
        parsed: {
          targets: npcIdMatch[1] ? [npcIdMatch[1]] : [],
          note: '',
        },
        raw: JSON.stringify({ targets: npcIdMatch[1] ? [npcIdMatch[1]] : [], note: '' }),
        usage: { prompt_tokens: 50, completion_tokens: 20 },
      };
    }

    const truncated = (actionText || 'acted').slice(0, 80);

    return {
      parsed: {
        narration: `You ${actionText || 'act'}. The world responds to your action. The air is thick with possibility. The scene shifts subtly around you. What will you do next?`,
        ops: [
          {
            op: 'merge',
            id: 'world-state',
            component: 'flags',
            value: { lastAction: truncated },
          },
        ],
        checks: [],
      },
      raw: JSON.stringify({
        narration: `You ${actionText || 'act'}. The world responds...`,
        ops: [{ op: 'merge', id: 'world-state', component: 'flags', value: { lastAction: truncated } }],
        checks: [],
      }),
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    };
  }

  /**
   * Deterministic canonize for offline testing — extract consequence ops from keywords.
   * Honors outcome: if the (outcome-aware) narration/results mention failure, record nothing.
   */
  #mockCanonize(actionText) {
    const txt = (actionText || '').toLowerCase();
    if (/failure|→ miss|fumble|failed|misses/.test(txt)) {
      return { parsed: { ops: [], actors: [] }, raw: '{"ops":[],"actors":[]}', usage: { prompt_tokens: 60, completion_tokens: 5 } };
    }
    // D3 grounding backstop: prose that named an off-scene drifter → report it ungrounded
    // so the engine spawns it (no pure-text actor survives a turn).
    let actors = [];
    if (/\bdrifter named (\w+)/.test(txt)) {
      const name = txt.match(/\bdrifter named (\w+)/)[1];
      actors = [{ name: name.charAt(0).toUpperCase() + name.slice(1), hostile: false, archetype: 'drifter' }];
    }
    let ops = [];
    if (txt.includes('attack') || txt.includes('strike') || txt.includes('swing')) {
      ops = [{ op: 'damage', id: 'npc-marta', amount: 4 }];
    } else if (txt.includes('torch')) {
      // take (not giveItem) → the world item entity leaves the ground.
      ops = [{ op: 'take', id: 'pc-hero', item: { id: 'item-torch', name: 'Wall Torch' } }];
    } else if (txt.includes('crate')) {
      ops = [{ op: 'take', id: 'pc-hero', item: { id: 'item-crate', name: 'Lashed Cargo Crate' } }];
    } else if (txt.includes('search') || txt.includes('examine') || txt.includes('force') ||
               txt.includes('pick') || txt.includes('lock') || txt.includes('strongbox') ||
               txt.includes('box') || txt.includes('key')) {
      ops = [{ op: 'take', id: 'pc-hero', item: { id: 'item-key', name: 'Brass Key' } }];
    }
    return { parsed: { ops, actors }, raw: JSON.stringify({ ops, actors }), usage: { prompt_tokens: 80, completion_tokens: 20 } };
  }

  /**
   * Deterministic worldgen for offline testing — names a location + its
   * inhabitants, or a quest, by parsing the ids out of the prompt. Mirrors the
   * shape server/worldgen.js expects (LocationChargeSchema / QuestChargeSchema).
   */
  #mockWorldgen(messages) {
    const user = this.#extractActionText(messages);

    // Quest charge call → {name, description, steps}
    if (/"steps"/.test(user) && !/"inhabitants"/.test(user)) {
      return this.#jsonResult({
        name: 'The Mock Errand',
        description: 'A deterministic quest woven for offline testing.',
        steps: ['Reach the lair.', 'Defeat the foes guarding it.', 'Seize the prize.'],
      });
    }

    // Location charge call → {name, description, artPrompt, inhabitants[]}
    const locId = (user.match(/Location id:\s*(\S+)/) || [])[1] || 'loc-?';
    const ids = [...user.matchAll(/^\s*-\s*(\S+)\s+—/gm)].map(m => m[1]);
    const inhabitants = ids.map((id) => {
      const n = parseInt((id.match(/(\d+)/) || [])[1] || '0', 10);
      if (id.startsWith('enemy')) return { id, name: `Mock Foe ${n}`, description: 'A snarling test enemy.', personality: 'Brutish and territorial.' };
      if (id.startsWith('item'))  return { id, name: `Mock Object ${n}`, description: 'A curious test object.' };
      if (id.startsWith('pc'))    return { id, name: 'Mock Wanderer', description: 'The test protagonist.' };
      return {
        id, name: `Mock Townsperson ${n}`, description: 'A talkative test villager.',
        personality: 'Chatty and helpful.', backstory: 'Born inside the test suite.',
        voice: 'Plain and even.', facts: [`Knows the way around ${locId}.`], secrets: ['Hides a test flag.'],
      };
    });
    return this.#jsonResult({
      name: `Mock ${locId}`,
      description: `A procedurally-described location (${locId}).`,
      artPrompt: `mock art for ${locId}`,
      inhabitants,
    });
  }

  /**
   * Deterministic adjudication for offline testing.
   * Keyword heuristics on player text.
   */
  #mockAdjudicate(actionText, messages) {
    const txt = (actionText || '').toLowerCase();

    // ---- D2/D4: world-first fight staging ----
    // Only when the prompt advertises spawn power (ruleset ships actorTemplates) AND
    // the action reads like starting a fight from nothing → spawn hostiles + open combat.
    const canSpawn = /STAGE THE WORLD/.test(JSON.stringify(messages));
    if (canSpawn && /\b(initiate|start|pick|begin)\b[^.]*\bfight\b|spoiling for a fight|fight\b[^.]*\b(everyone|them all)\b/.test(txt)) {
      return this.#jsonResult({
        speakTo: null, checks: [], ops: [],
        spawns: [{ archetype: 'groomsman', hostile: true, count: 3 }],
        beginCombat: true,
      });
    }

    // ---- Action checks (before conversation routing) ----

    // Attack keywords
    if (txt.includes('attack') || txt.includes('strike') || txt.includes('hit') || txt.includes('swing')) {
      return this.#jsonResult({
        speakTo: null,
        checks: [{ ability: 'str', skill: undefined, dc: 13, reason: 'attacking' }],
        ops: [{ op: 'damage', id: 'npc-marta', amount: 4 }],
      });
    }

    // Search/examine/investigate
    if (txt.includes('search') || txt.includes('examine') || txt.includes('investigate')) {
      return this.#jsonResult({
        speakTo: null,
        checks: [{ ability: 'wis', skill: 'perception', dc: 12, reason: 'searching the area' }],
        ops: [{ op: 'giveItem', id: 'pc-hero', item: { id: 'item-key', name: 'Brass Key' } }],
      });
    }

    // Force/break/smash
    if (txt.includes('force') || txt.includes('break') || txt.includes('smash') || txt.includes('bash')) {
      return this.#jsonResult({
        speakTo: null,
        checks: [{ ability: 'str', skill: 'athletics', dc: 14, reason: 'forcing it open' }],
        ops: [{ op: 'giveItem', id: 'pc-hero', item: { id: 'item-key', name: 'Brass Key' } }],
      });
    }

    // Pick lock
    if (txt.includes('pick') && (txt.includes('lock') || txt.includes('chest') || txt.includes('box'))) {
      return this.#jsonResult({
        speakTo: null,
        checks: [{ ability: 'dex', skill: 'sleight of hand', dc: 15, reason: 'picking the lock' }],
        ops: [{ op: 'giveItem', id: 'pc-hero', item: { id: 'item-key', name: 'Brass Key' } }],
      });
    }

    // Take/grab/pick up → no-check take op (world entity leaves the ground)
    if (txt.includes('take') || txt.includes('grab') || txt.includes('pick up')) {
      return this.#jsonResult({
        speakTo: null,
        checks: [],
        ops: [{ op: 'take', id: 'pc-hero', item: { id: 'item-torch', name: 'Wall Torch' } }],
      });
    }

    // Pure look/observe → narration only (no checks, no ops)
    if (txt.startsWith('look') || txt.startsWith('observe') || txt.startsWith('watch') || txt === 'look') {
      return this.#jsonResult({ speakTo: null, checks: [], ops: [] });
    }

    // ---- Conversation routing ----
    const npcNames = this.#extractNpcNames(messages);
    const greetMatch = txt.match(/^(hello|hi|hey|greetings|good)\b/);
    const npcNameInText = npcNames.find(n => txt.includes(n.toLowerCase()));

    if (greetMatch || npcNameInText) {
      const firstNpc = npcNames[0] || null;
      const npcId = firstNpc ? this.#extractNpcIdForName(firstNpc, messages) : null;
      return this.#jsonResult({ speakTo: npcId, note: '', checks: [], ops: [] });
    }

    // Default: pure narration
    return this.#jsonResult({ speakTo: null, checks: [], ops: [] });
  }

  /** Extract NPC names from the system prompt context. */
  #extractNpcNames(messages) {
    const names = [];
    for (const m of messages) {
      if (m.role === 'system') {
        const re = /- (\w+) \(id: "([^"]+)"\)/g;
        let match;
        while ((match = re.exec(m.content)) !== null) {
          names.push(match[1]);
        }
      }
    }
    return names;
  }

  /** Extract NPC id for a given name from messages. */
  #extractNpcIdForName(name, messages) {
    for (const m of messages) {
      if (m.role === 'system') {
        const re = new RegExp(`- ${name} \\(id: "([^"]+)"\\)`);
        const match = re.exec(m.content);
        if (match) return match[1];
      }
    }
    return null;
  }

  /** Build a {parsed, raw, usage} result from a plain object. */
  #jsonResult(obj) {
    return {
      parsed: obj,
      raw: JSON.stringify(obj),
      usage: { prompt_tokens: 150, completion_tokens: 60 },
    };
  }

  #extractActionText(messages) {
    // Find the last user message that is NOT a JSON instruction
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === 'user' && !m.content.startsWith('Now output')) {
        return m.content || '';
      }
    }
    return '';
  }
}

// ---- Factory ----

/**
 * Create an LlmClient based on LLM_PROVIDER env var.
 *
 * - 'mock' → MockLlmClient (no key needed)
 * - 'deepseek' (default) → DeepSeekClient (requires DEEPSEEK_API_KEY)
 * - 'novita' → DeepSeekClient against Novita's OpenAI-compatible API (requires NOVITA_API_KEY)
 * - 'gaia' → DeepSeekClient (it's a thin OpenAI-wrapper) against a `gaia serve`
 *   endpoint — GAIA_SERVE_URL (default http://localhost:8799/v1, `gaia serve`'s
 *   own default port). No real API key needed; `gaia serve` doesn't check one,
 *   the openai client just needs a non-empty string (GAIA_SERVE_TOKEN or a
 *   placeholder).
 * - Falls back to MockLlmClient if deepseek is selected but no key is set
 *
 * @returns {DeepSeekClient|MockLlmClient}
 */
export function createLlmClient() {
  const provider = process.env.LLM_PROVIDER || 'deepseek';

  if (provider === 'gaia') {
    const baseURL = process.env.GAIA_SERVE_URL || 'http://localhost:8799/v1';
    console.log(`[llm] Using DeepSeekClient via gaia serve (baseURL: ${baseURL})`);
    return new DeepSeekClient({
      apiKey: process.env.GAIA_SERVE_TOKEN || 'gaia-serve-local',
      baseURL,
      model: process.env.GAIA_SERVE_MODEL || 'gaia-monad',
      sessionId: process.env.TTRPG_SAVE || 'default',
    });
  }

  if (provider === 'mock') {
    console.log('[llm] Using MockLlmClient (no network calls)');
    return new MockLlmClient({ sessionId: process.env.TTRPG_SAVE || 'default' });
  }

  if (provider === 'deepseek') {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      console.warn('[llm] DEEPSEEK_API_KEY not set — falling back to MockLlmClient');
      return new MockLlmClient({ sessionId: process.env.TTRPG_SAVE || 'default' });
    }
    console.log(`[llm] Using DeepSeekClient (model: ${process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash'})`);
    return new DeepSeekClient({
      apiKey,
      baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
      model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash',
      sessionId: process.env.TTRPG_SAVE || 'default',
    });
  }

  if (provider === 'novita') {
    const apiKey = process.env.NOVITA_API_KEY;
    if (!apiKey) {
      console.warn('[llm] NOVITA_API_KEY not set — falling back to MockLlmClient');
      return new MockLlmClient({ sessionId: process.env.TTRPG_SAVE || 'default' });
    }
    const model = process.env.NOVITA_MODEL || 'meta-llama/llama-3.2-3b-instruct';
    console.log(`[llm] Using DeepSeekClient via Novita (model: ${model})`);
    return new DeepSeekClient({
      apiKey,
      baseURL: process.env.NOVITA_BASE_URL || 'https://api.novita.ai/v3/openai',
      model,
      sessionId: process.env.TTRPG_SAVE || 'default',
    });
  }

  console.warn(`[llm] Unknown LLM_PROVIDER "${provider}" — falling back to MockLlmClient`);
  return new MockLlmClient({ sessionId: process.env.TTRPG_SAVE || 'default' });
}

// ---- Custom error ----

export class LlmParseError extends Error {
  constructor(message, raw, parseError) {
    super(message);
    this.name = 'LlmParseError';
    this.raw = raw;
    this.parseError = parseError;
  }
}

/**
 * Run `attempt` and re-ask (re-run) on LlmParseError up to `retries` times,
 * warning on each re-ask. Rethrows the final LlmParseError once exhausted.
 * Any non-LlmParseError error propagates immediately without retry.
 * @param {() => Promise<T>} attempt — one structured-output call + parse + validate
 * @param {number} retries — number of re-asks after the first attempt
 * @returns {Promise<T>}
 * @template T
 */
export async function withParseRetry(attempt, retries) {
  let retriesLeft = retries;
  while (true) {
    try {
      return await attempt();
    } catch (e) {
      if (e instanceof LlmParseError && retriesLeft > 0) {
        console.warn(`[llm] structured parse failed, re-asking (${retriesLeft} left)`);
        retriesLeft--;
        continue;
      }
      throw e;
    }
  }
}
