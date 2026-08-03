/**
 * client/kernel/dm-view.js — the DMView surface (DM seat).
 *
 * Renders the DM control panels from the same store + WS the player client uses:
 *   - Story: the live transcript (narration / dialogue / rolls / actions) — the
 *     DM reads exactly what the players are being told
 *   - Autopilot toggle (pause/run the propose→commit gate)
 *   - Proposals: pending LLM beats with approve / reject / regenerate + reveal-detail
 *   - Stage a beat: author the DM's next ruling by hand (spawns / combat / checks /
 *     NPC line) — queued for the next player action via dm-control {action:'stage'}
 *   - Agent activity: DM-only trace events (decisions / tool calls), reveal-detail
 *   - Turn order: works for BOTH initiative and CTB-timeline combat, with overrides
 *   - Entities (full): the god-mode inspector — the DM is who SHOULD see everything
 *
 * Store events drive the panels; non-store WS messages (proposal / trace /
 * proposal-resolved) arrive via handleServer().
 */

import { el, clear } from './dom.js';

export class DMView {
  constructor(store) {
    this.store = store;
    this.net = null; // set by dm.js — used to send control messages + ops

    this.proposals = new Map(); // id → {id, actionText, summary, ruling}
    this.traces = [];           // recent trace events (capped)
    this._streamEls = new Map();

    this.autopilotEl = document.getElementById('dm-autopilot');
    this.proposalsEl = document.getElementById('dm-proposals');
    this.tracesEl = document.getElementById('dm-traces');
    this.turnOrderEl = document.getElementById('dm-turnorder');
    this.entitiesEl = document.getElementById('dm-entities');
    this.storyEl = document.getElementById('dm-story');
    this.stageEl = document.getElementById('dm-stage');

    if (this.autopilotEl) {
      this.autopilotEl.addEventListener('click', () => {
        if (this.net) this.net.sendControl({ action: 'setAutopilot', value: !this._autopilotOn() });
      });
    }

    this._renderStageForm();

    store.onChange((event) => {
      if (event.kind === 'event') { this._handleStoryEvent(event.name, event.data); return; }
      if (event.kind === 'action') { this._appendStory(this._actionLine(event)); return; }
      this._renderStorePanels();
    });
  }

  // ---- Server (non-store) messages ----

  handleServer(msg) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'proposal':
        this.proposals.set(msg.proposal.id, msg.proposal);
        this._renderProposals();
        break;
      case 'proposal-resolved':
        this.proposals.delete(msg.id);
        this._renderProposals();
        break;
      case 'trace':
        this.traces.push(msg.trace);
        if (this.traces.length > 60) this.traces = this.traces.slice(-60);
        this._renderTraces();
        break;
    }
  }

  _renderStorePanels() {
    this._renderAutopilot();
    this._renderTurnOrder();
    this._renderEntities();
    const conn = document.getElementById('dm-conn');
    if (conn) conn.textContent = `${this.store.entities.size} entities`;
  }

  // ---- Story transcript (what the players are being told) ----

  /** Replay journal history (GET /events) so a late-joining DM reads the whole story. */
  backfill(entries) {
    if (!Array.isArray(entries)) return;
    for (const e of entries) {
      if (e.op === 'action' && e.text) this._appendStory(this._actionLine(e));
      else if (e.op === 'event' && (e.data || {}).text) this._handleStoryEvent(e.name, { ...e.data, done: true, delta: undefined });
    }
  }

  _actionLine(e) {
    return el('div', { className: 'py-0.5 text-right' }, [
      el('span', { className: 'text-[11px] text-blue-400/80 mr-1' }, [`${e.by || 'player'}:`]),
      el('span', { className: 'text-blue-100/90' }, [e.text || '']),
    ]);
  }

  _handleStoryEvent(name, data) {
    if (!this.storyEl || !data) return;
    // HUD-only noise (timeline projections, meter ticks) stays out of the story.
    if ((data.kind === 'combat' && data.phase === 'timeline') || data.kind === 'meter') return;

    // Streaming: accumulate deltas per streamId, replace on done.
    if (data.streamId) {
      const existing = this._streamEls.get(data.streamId);
      if (data.done) {
        if (existing) { existing.line.remove(); this._streamEls.delete(data.streamId); }
        this._appendStory(this._storyLine(name, { ...data, text: data.text || (existing ? existing.text : '') }));
        return;
      }
      if (data.delta) {
        if (existing) {
          existing.text += data.delta;
          existing.textEl.textContent = existing.text;
        } else {
          const line = this._storyLine(name, { ...data, text: data.delta });
          const textEl = line.querySelector('[data-story-text]');
          this._appendStory(line);
          this._streamEls.set(data.streamId, { line, textEl, text: data.delta });
        }
        this._scrollStory();
      }
      return;
    }
    this._appendStory(this._storyLine(name, data));
  }

  _storyLine(name, data) {
    if (name === 'dialogue') {
      return el('div', { className: 'py-0.5' }, [
        el('span', { className: 'text-[11px] font-semibold mr-1', style: `color:${data.accent || '#4a9eff'}` }, [`${data.name || data.by || 'NPC'}:`]),
        el('span', { className: 'text-gray-200', 'data-story-text': '' }, [data.text || '']),
      ]);
    }
    if (name === 'system') {
      const detail = data.detail || {};
      const ok = detail.success;
      const cls = data.kind === 'roll'
        ? (ok === true ? 'text-green-400/70' : ok === false ? 'text-red-400/70' : 'text-gray-500')
        : 'text-gray-500';
      return el('div', { className: 'py-0.5 text-center' }, [
        el('span', { className: `text-[11px] ${cls}`, 'data-story-text': '' }, [data.text || '']),
      ]);
    }
    // narration
    return el('div', { className: 'py-1' }, [
      el('span', { className: 'text-[10px] uppercase tracking-wider text-amber-500/70 mr-1' }, ['dm']),
      el('span', { className: 'text-gray-300 italic', 'data-story-text': '' }, [data.text || '']),
    ]);
  }

  _appendStory(lineEl) {
    if (!this.storyEl) return;
    this.storyEl.appendChild(lineEl);
    this._scrollStory();
  }

  _scrollStory() {
    if (this.storyEl) this.storyEl.scrollTop = this.storyEl.scrollHeight;
  }

  // ---- Autopilot ----

  _autopilotOn() {
    const ctrl = this.store.entities.get('dm-control');
    // Absent or autopilot!==false → on (default).
    return !ctrl || !ctrl.dmControl || ctrl.dmControl.autopilot !== false;
  }

  _renderAutopilot() {
    if (!this.autopilotEl) return;
    const on = this._autopilotOn();
    this.autopilotEl.textContent = on ? 'Autopilot: ON' : 'Autopilot: OFF (you gate beats)';
    this.autopilotEl.className = 'text-sm font-medium py-1.5 px-4 rounded transition-colors '
      + (on ? 'bg-emerald-700 hover:bg-emerald-600 text-white' : 'bg-amber-600 hover:bg-amber-500 text-white');
  }

  // ---- Proposals ----

  _renderProposals() {
    if (!this.proposalsEl) return;
    clear(this.proposalsEl);

    if (!this.proposals.size) {
      this.proposalsEl.appendChild(el('div', { className: 'text-sm text-gray-600 italic' }, [
        this._autopilotOn() ? 'Autopilot on — beats apply automatically. Turn it off to review each one.' : 'No pending proposals.',
      ]));
      return;
    }

    for (const p of this.proposals.values()) {
      const card = el('div', { className: 'p-2 bg-gray-800 rounded border border-amber-700/50' }, [
        el('div', { className: 'text-xs text-blue-300/80 mb-0.5' }, [`Player: "${p.actionText}"`]),
        el('div', { className: 'text-sm text-gray-100 mb-2' }, [p.summary || '(beat)']),
        el('div', { className: 'flex gap-2 mb-1' }, [
          this._btn('Approve', 'bg-emerald-700 hover:bg-emerald-600', () => this._resolve(p.id, 'approve')),
          this._btn('Reject', 'bg-red-800 hover:bg-red-700', () => this._resolve(p.id, 'reject')),
          this._btn('Regenerate', 'bg-gray-700 hover:bg-gray-600', () => this._resolve(p.id, 'regenerate')),
        ]),
        this._detail('ruling', p.ruling),
      ]);
      this.proposalsEl.appendChild(card);
    }
  }

  _resolve(id, action) {
    if (this.net) this.net.sendControl({ action, proposalId: id });
  }

  // ---- Stage a beat (human DM authors the next ruling) ----

  _renderStageForm() {
    if (!this.stageEl) return;
    clear(this.stageEl);

    const input = (id, placeholder, extra = '') => el('input', {
      id, placeholder,
      className: `bg-gray-800 border border-gray-700 rounded px-2 py-1 text-xs focus:outline-none focus:border-blue-500 ${extra}`,
    });

    const spawnRow = el('div', { className: 'flex gap-1 items-center flex-wrap' }, [
      el('span', { className: 'text-[10px] uppercase text-gray-500 w-14' }, ['spawn']),
      input('stage-archetype', 'archetype', 'w-24'),
      input('stage-name', 'name (opt)', 'w-24'),
      input('stage-count', '×1', 'w-10'),
      el('label', { className: 'text-[11px] text-gray-400 flex items-center gap-1' }, [
        el('input', { id: 'stage-hostile', type: 'checkbox' }), 'hostile',
      ]),
      el('label', { className: 'text-[11px] text-gray-400 flex items-center gap-1' }, [
        el('input', { id: 'stage-ally', type: 'checkbox' }), 'ally',
      ]),
    ]);

    const checkRow = el('div', { className: 'flex gap-1 items-center flex-wrap' }, [
      el('span', { className: 'text-[10px] uppercase text-gray-500 w-14' }, ['check']),
      input('stage-check-dc', 'dc', 'w-12'),
      input('stage-check-reason', 'reason (leave dc empty for none)', 'flex-1'),
    ]);

    const speakRow = el('div', { className: 'flex gap-1 items-center' }, [
      el('span', { className: 'text-[10px] uppercase text-gray-500 w-14' }, ['npc says']),
      input('stage-speakto', 'npc id (e.g. npc-padre)', 'w-36'),
      input('stage-note', 'director note for the NPC', 'flex-1'),
    ]);

    const combatRow = el('div', { className: 'flex gap-2 items-center' }, [
      el('span', { className: 'text-[10px] uppercase text-gray-500 w-14' }, ['combat']),
      el('label', { className: 'text-[11px] text-gray-400 flex items-center gap-1' }, [
        el('input', { id: 'stage-begincombat', type: 'checkbox' }), 'begin combat with staged hostiles',
      ]),
    ]);

    const status = el('div', { id: 'stage-status', className: 'text-[11px] text-gray-600 italic' }, ['']);

    const sendBtn = this._btn('Stage for next action', 'bg-indigo-700 hover:bg-indigo-600', () => {
      const v = (id) => (document.getElementById(id) || {}).value || '';
      const c = (id) => !!(document.getElementById(id) || {}).checked;
      const ruling = {};

      const archetype = v('stage-archetype').trim();
      if (archetype) {
        ruling.spawns = [{
          archetype,
          name: v('stage-name').trim() || undefined,
          hostile: c('stage-hostile') || undefined,
          ally: c('stage-ally') || undefined,
          count: Math.max(1, parseInt(v('stage-count'), 10) || 1),
        }];
      }
      const dc = parseInt(v('stage-check-dc'), 10);
      if (Number.isFinite(dc)) ruling.checks = [{ dc, reason: v('stage-check-reason').trim() || 'DM-staged check' }];
      const speakTo = v('stage-speakto').trim();
      if (speakTo) { ruling.speakTo = speakTo; ruling.note = v('stage-note').trim(); }
      if (c('stage-begincombat')) ruling.beginCombat = true;

      if (!Object.keys(ruling).length) {
        status.textContent = 'nothing to stage — fill a row first';
        return;
      }
      this.net && this.net.sendControl({ action: 'stage', ruling });
      status.textContent = '✓ staged — it resolves on the NEXT player action (instead of the LLM)';
      for (const id of ['stage-archetype', 'stage-name', 'stage-count', 'stage-check-dc', 'stage-check-reason', 'stage-speakto', 'stage-note']) {
        const n = document.getElementById(id); if (n) n.value = '';
      }
      for (const id of ['stage-hostile', 'stage-ally', 'stage-begincombat']) {
        const n = document.getElementById(id); if (n) n.checked = false;
      }
    });

    // P5: the mood knob — drives every player's music engine immediately.
    const moodRow = el('div', { className: 'flex gap-1 items-center flex-wrap' }, [
      el('span', { className: 'text-[10px] uppercase text-gray-500 w-14' }, ['mood']),
      ...['calm', 'eerie', 'tense', 'combat', 'somber', 'auto'].map((m) =>
        el('button', {
          className: 'text-[11px] px-2 py-0.5 rounded border border-gray-700 text-gray-300 hover:bg-gray-800',
          onclick: () => {
            this.net && this.net.sendControl({ action: 'setMood', value: m === 'auto' ? null : m });
            status.textContent = m === 'auto' ? '✓ mood follows the world again' : `✓ mood set: ${m}`;
          },
        }, [m])),
    ]);

    this.stageEl.append(spawnRow, checkRow, speakRow, combatRow, moodRow,
      el('div', { className: 'flex items-center gap-2 mt-1' }, [sendBtn, status]));
  }

  // ---- Trace feed ----

  _renderTraces() {
    if (!this.tracesEl) return;
    clear(this.tracesEl);
    // newest first
    for (const t of [...this.traces].reverse()) {
      const row = el('div', { className: 'border-b border-gray-800 pb-1' }, [
        el('div', { className: 'flex items-baseline gap-2' }, [
          el('span', { className: 'text-[10px] uppercase tracking-wider text-purple-300/70 w-24 shrink-0' }, [`${t.agent || '?'} · ${t.phase || ''}`]),
          el('span', { className: 'text-gray-300' }, [t.summary || '']),
        ]),
        t.detail !== undefined ? this._detail('detail', t.detail) : '',
      ].filter(Boolean));
      this.tracesEl.appendChild(row);
    }
  }

  // ---- Turn order (combat — BOTH initiative and CTB-timeline modes) ----

  _renderTurnOrder() {
    if (!this.turnOrderEl) return;
    clear(this.turnOrderEl);

    const enc = this.store.entities.get('encounter');
    const e = enc && enc.encounter;
    if (!e || !e.active) {
      this.turnOrderEl.appendChild(el('div', { className: 'text-sm text-gray-600 italic' }, ['No active combat.']));
      return;
    }

    const enemies = new Set(e.enemies || []);
    const nameOf = (id) => ((this.store.entities.get(id) || {}).identity || {}).name || id;

    if (e.mode === 'timeline') {
      // CTB: participants carry {id, time, speed}; lowest time acts (turnOf).
      const parts = [...(e.participants || [])].sort((a, b) => (a.time || 0) - (b.time || 0));
      this.turnOrderEl.appendChild(el('div', { className: 'text-[10px] text-gray-500 mb-1' },
        [`Round ${e.round} · timeline (lowest time acts) · ▶ act now · +1 delay`]));
      for (const p of parts) {
        const cur = p.id === e.turnOf;
        const isEnemy = enemies.has(p.id);
        const dead = ((this.store.entities.get(p.id) || {}).status || {}).alive === false;
        this.turnOrderEl.appendChild(el('div', {
          className: `flex items-center gap-2 p-1 rounded ${cur ? 'bg-gray-700 border border-yellow-600' : ''} ${dead ? 'opacity-40' : ''}`,
        }, [
          el('span', { className: 'text-[10px] text-gray-500 w-10' }, [`t=${p.time ?? 0}`]),
          el('span', { className: `flex-1 ${isEnemy ? 'text-red-300' : 'text-blue-300'}` }, [nameOf(p.id) + (cur ? ' ◀' : '')]),
          this._miniBtn('▶', () => this._timelineActNow(p.id)),
          this._miniBtn('+1', () => this._timelineDelay(e, p.id)),
        ]));
      }
      return;
    }

    const order = e.order || [];
    if (!order.length) {
      this.turnOrderEl.appendChild(el('div', { className: 'text-sm text-gray-600 italic' }, ['Combat active — no turn list.']));
      return;
    }
    order.forEach((id, i) => {
      const cur = i === e.turnIndex;
      const isEnemy = enemies.has(id);
      const row = el('div', { className: `flex items-center gap-2 p-1 rounded ${cur ? 'bg-gray-700 border border-yellow-600' : ''}` }, [
        el('span', { className: 'text-xs text-gray-500 w-5' }, [String(i + 1)]),
        el('span', { className: `flex-1 ${isEnemy ? 'text-red-300' : 'text-blue-300'}` }, [nameOf(id) + (cur ? ' ◀' : '')]),
        this._miniBtn('▲', () => this._reorder(order, i, i - 1)),
        this._miniBtn('▼', () => this._reorder(order, i, i + 1)),
        this._miniBtn('▶', () => this._setCurrent(i)),
      ]);
      this.turnOrderEl.appendChild(row);
    });
  }

  /** Timeline override: this combatant acts NOW. */
  _timelineActNow(id) {
    if (this.net) this.net.sendOps([{ op: 'merge', id: 'encounter', component: 'encounter', value: { turnOf: id } }]);
  }

  /** Timeline override: push a combatant's next act one tick later. */
  _timelineDelay(e, id) {
    if (!this.net) return;
    const participants = (e.participants || []).map(p =>
      p.id === id ? { ...p, time: (p.time || 0) + 1 } : p);
    this.net.sendOps([{ op: 'merge', id: 'encounter', component: 'encounter', value: { participants } }]);
  }

  _reorder(order, i, j) {
    if (j < 0 || j >= order.length || !this.net) return;
    const next = order.slice();
    [next[i], next[j]] = [next[j], next[i]];
    this.net.sendOps([{ op: 'merge', id: 'encounter', component: 'encounter', value: { order: next } }]);
  }

  _setCurrent(i) {
    if (this.net) this.net.sendOps([{ op: 'merge', id: 'encounter', component: 'encounter', value: { turnIndex: i } }]);
  }

  // ---- Entity inspector (full store) ----

  _renderEntities() {
    if (!this.entitiesEl) return;
    clear(this.entitiesEl);
    const ids = [...this.store.entities.keys()].sort();
    for (const id of ids) {
      const comps = this.store.entities.get(id);
      if (comps.presence) continue;
      const identity = comps.identity || {};
      const dead = (comps.status || {}).alive === false;
      const row = el('div', {}, [
        el('div', {
          className: 'flex items-center gap-2 py-0.5 cursor-pointer hover:bg-gray-800 rounded px-1',
          onclick: (ev) => this._toggleEntity(id, ev.currentTarget),
        }, [
          el('span', { className: 'text-[10px] text-gray-500 w-16 shrink-0' }, [identity.kind || '?']),
          el('span', { className: dead ? 'text-gray-600 line-through' : 'text-gray-300' }, [identity.name || id]),
        ]),
      ]);
      this.entitiesEl.appendChild(row);
    }
  }

  _toggleEntity(id, rowEl) {
    const existing = rowEl.parentNode.querySelector('[data-detail]');
    if (existing) { existing.remove(); return; }
    const comps = this.store.entities.get(id) || {};
    const det = el('pre', {
      'data-detail': '',
      className: 'text-[11px] text-gray-400 bg-gray-950 rounded p-2 ml-4 my-1 overflow-x-auto whitespace-pre-wrap',
    }, [JSON.stringify(comps, null, 2)]);
    rowEl.parentNode.appendChild(det);
  }

  // ---- helpers ----

  _btn(label, color, onClick) {
    return el('button', { className: `text-xs font-medium py-1 px-3 rounded text-white ${color}`, onclick: onClick }, [label]);
  }

  _miniBtn(label, onClick) {
    return el('button', { className: 'text-xs px-1.5 py-0.5 rounded bg-gray-700 hover:bg-gray-600 text-gray-200', onclick: onClick }, [label]);
  }

  _detail(label, value) {
    const summary = el('summary', { className: 'text-[11px] text-gray-500 cursor-pointer hover:text-gray-300 select-none' }, [`reveal ${label}`]);
    const pre = el('pre', { className: 'text-[11px] text-gray-400 bg-gray-950 rounded p-2 mt-1 overflow-x-auto whitespace-pre-wrap' },
      [typeof value === 'string' ? value : JSON.stringify(value, null, 2)]);
    return el('details', { className: 'mt-1' }, [summary, pre]);
  }
}
