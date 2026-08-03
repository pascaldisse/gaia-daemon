/**
 * client/kernel/view.js — Reconcile store events to DOM.
 *
 * One-directional: store.onChange → view.handle(event).
 * Granular, no diffing. Switches on event kind + component name.
 *
 * P2: 4-lane transcript — narration, dialogue, system, player actions.
 * Generalizes streaming accumulation to any event with streamId.
 *
 * EXTENSION SEAM: add new component rendering in renderComponent().
 * New event kinds in handle().
 *
 * Based on GAIA's client/kernel/view.js reconciler pattern.
 */

import { el, clear } from './dom.js';
import { WorldView } from './worldview.js';

export class View {
  /**
   * @param {object} store — SessionStore instance
   */
  constructor(store) {
    this.store = store;

    // DOM refs
    this.entityListEl = document.getElementById('entity-list');
    this.transcriptEl = document.getElementById('transcript-entries');
    this.sceneAreaEl = document.getElementById('scene-area');

    // Set by main.js — this client's player name; picks which PC is "mine".
    this.myName = null;

    // Track rendered entity elements for granular updates
    this._entityEls = new Map(); // id → DOM element
    this._entityDetailEls = new Map(); // id → detail panel element

    // Stream-aware event rendering: map streamId → {element, text}
    this._streamEls = new Map();

    // Scoped player HUD container (lazy-created in #inspector).
    this._playerHudEl = null;

    // Set by main.js — clicking a present NPC / item / exit sends an action.
    this.onAction = null;

    // The walkable world (canvas). Lazy — created on first tile-bearing scene.
    this.worldview = null;

    // Subscribe to store
    store.onChange((event) => this.handle(event));
  }

  /** Entry point for all store events. */
  handle(event) {
    switch (event.kind) {
      case 'snapshot':
        this._rebuildAll();
        break;
      case 'spawn':
        this._addEntity(event.id);
        this._refreshScoped();
        break;
      case 'set':
      case 'merge':
        this._updateEntity(event.id, event.component);
        // Presence-in-room, HP, quests, combat all depend on cross-entity state,
        // so re-derive the scoped views wholesale (cheap, small DOM).
        this._refreshScoped();
        break;
      case 'despawn':
        this._removeEntity(event.id);
        this._refreshScoped();
        break;
      case 'event':
        this._handleEvent(event);
        break;
      case 'action':
        this._handleAction(event);
        break;
      case 'reset':
        this._rebuildAll();
        break;
    }
  }

  // ---- Full rebuild (on snapshot/reset) ----

  _rebuildAll() {
    clear(this.entityListEl);
    this._entityEls.clear();
    this._entityDetailEls.clear();

    for (const [id, comps] of this.store.entities) {
      this._addEntity(id);
    }

    this._refreshScoped();
  }

  /** Re-derive the scoped player HUD + the scene area (combat HUD or location). */
  _refreshScoped() {
    this._renderPlayerHud();
    this._renderEncounterHud();
  }

  // ---- Entity list ----

  _addEntity(id) {
    const comps = this.store.entities.get(id);
    if (!comps) return;

    // Skip presence entities in the entity list
    if (comps.presence) return;

    const identity = comps.identity || {};
    const status = comps.status || {};

    const name = identity.name || id;
    const kind = identity.kind || '?';
    const aliveBadge = status.alive === false
      ? ' ☠'
      : (comps.status ? ' ♥' : '');

    const row = el('div', {
      className: 'flex items-center gap-2 p-1 rounded hover:bg-gray-800 cursor-pointer transition-colors text-gray-300',
      'data-entity-id': id,
    }, [
      el('span', { className: 'text-xs text-gray-500 w-16 shrink-0' }, [kind]),
      el('span', { className: 'font-medium' }, [name + aliveBadge]),
    ]);

    row.addEventListener('click', () => this._toggleDetail(id, row));

    this.entityListEl.appendChild(row);
    this._entityEls.set(id, row);
  }

  _updateEntity(id, component) {
    // Re-render this entity's row
    const row = this._entityEls.get(id);
    if (!row) return;

    const comps = this.store.entities.get(id);
    if (!comps) { this._removeEntity(id); return; }

    const identity = comps.identity || {};
    const status = comps.status || {};
    const name = identity.name || id;
    const kind = identity.kind || '?';
    const aliveBadge = status.alive === false
      ? ' ☠'
      : (comps.status ? ' ♥' : '');

    const spans = row.querySelectorAll('span');
    if (spans.length >= 2) {
      spans[0].textContent = kind;
      spans[1].textContent = name + aliveBadge;
    }

    const detail = this._entityDetailEls.get(id);
    if (detail) {
      this._renderDetail(id, detail);
    }
  }

  _removeEntity(id) {
    const row = this._entityEls.get(id);
    if (row) {
      row.remove();
      this._entityEls.delete(id);
    }
    const detail = this._entityDetailEls.get(id);
    if (detail) {
      detail.remove();
      this._entityDetailEls.delete(id);
    }
  }

  // ---- Detail panel (component inspector) ----

  _toggleDetail(id, row) {
    const existing = this._entityDetailEls.get(id);
    if (existing) {
      existing.remove();
      this._entityDetailEls.delete(id);
      return;
    }

    const detail = el('div', {
      className: 'ml-6 mb-2 text-xs bg-gray-800 rounded p-2 space-y-1 border border-gray-700',
    });

    this._renderDetail(id, detail);

    row.after(detail);
    this._entityDetailEls.set(id, detail);
  }

  _renderDetail(id, detailEl) {
    const comps = this.store.entities.get(id);
    if (!comps) return;

    clear(detailEl);

    for (const [compName, compValue] of Object.entries(comps)) {
      if (compName === 'persist') continue;
      this._renderComponent(detailEl, compName, compValue);
    }
  }

  /** EXTENSION SEAM: add rendering for new components here. */
  _renderComponent(parent, name, value) {
    const container = el('div', { className: 'mt-1' });

    const header = el('div', {
      className: 'text-gray-500 uppercase tracking-wider font-semibold mb-0.5',
      textContent: name,
    });
    container.appendChild(header);

    switch (name) {
      case 'identity': container.appendChild(this._renderIdentity(value)); break;
      case 'status': container.appendChild(this._renderStatus(value)); break;
      case 'stats': container.appendChild(this._renderStats(value)); break;
      case 'place': container.appendChild(this._renderPlace(value)); break;
      case 'persona': container.appendChild(this._renderPersona(value)); break;
      case 'inventory': container.appendChild(this._renderInventory(value)); break;
      case 'quest': container.appendChild(this._renderQuest(value)); break;
      case 'presence': container.appendChild(this._renderPresence(value)); break;
      case 'knowledge': container.appendChild(this._renderKnowledge(value)); break;
      case 'agent': container.appendChild(this._renderAgent(value)); break;
      case 'encounter': container.appendChild(this._renderEncounter(value)); break;
      default:
        container.appendChild(el('div', { className: 'text-gray-400 italic' }, [
          typeof value === 'object' ? JSON.stringify(value).slice(0, 100) : String(value),
        ]));
    }

    parent.appendChild(container);
  }

  _renderIdentity(v) {
    return el('div', { className: 'text-gray-300 space-y-0.5' }, [
      el('div', {}, [`Name: ${v.name || '?'}`]),
      el('div', {}, [`Kind: ${v.kind || '?'}`]),
      v.description ? el('div', {}, [`"${v.description}"`]) : '',
    ].filter(Boolean));
  }

  _renderStatus(v) {
    return el('div', { className: 'text-gray-300' }, [
      `Alive: ${v.alive !== false ? 'yes' : 'no'}`,
      v.conditions && v.conditions.length > 0 ? ` · ${v.conditions.join(', ')}` : '',
    ].join(''));
  }

  _renderStats(v) {
    return el('div', { className: 'text-gray-300' }, [
      `HP: ${v.hp ?? '?'} / ${v.maxHp ?? '?'}`,
    ].join(''));
  }

  _renderPlace(v) {
    const loc = v.locationId || '(none)';
    const conns = (v.connections || []).map(c => c.targetId || c.label || '?').join(', ');
    return el('div', { className: 'text-gray-300' }, [
      `Location: ${loc}`,
      conns ? ` · Exits: ${conns}` : '',
    ].join(''));
  }

  _renderPersona(v) {
    return el('div', { className: 'text-gray-300 space-y-0.5' }, [
      v.personality ? el('div', {}, [`Personality: ${v.personality}`]) : '',
      v.backstory ? el('div', {}, [`Backstory: ${v.backstory}`]) : '',
      v.voice ? el('div', {}, [`Voice: ${v.voice}`]) : '',
    ].filter(Boolean));
  }

  _renderInventory(v) {
    const items = (v.items || []).map(i => i.id || i.name || '?').join(', ') || '(empty)';
    return el('div', { className: 'text-gray-300' }, [`Items: ${items}`]);
  }

  _renderQuest(v) {
    return el('div', { className: 'text-gray-300' }, [
      `Phase: ${v.phase || '?'} · Step: ${v.currentStep ?? 0}/${(v.steps || []).length}`,
    ].join(''));
  }

  _renderPresence(v) {
    return el('div', { className: 'text-gray-300' }, [
      `${v.who || '?'} (${v.seat || '?'} / ${v.mode || '?'})`,
    ].join(''));
  }

  _renderKnowledge(v) {
    const facts = (v.facts || []).map(f => el('li', {}, [`F: ${f}`]));
    const secrets = (v.secrets || []).map(s => el('li', {}, [`S: ${s}`]));
    return el('div', { className: 'text-gray-300' }, [
      el('ul', { className: 'list-disc list-inside' }, [...facts, ...secrets]),
    ]);
  }

  _renderAgent(v) {
    return el('div', { className: 'text-gray-300 space-y-0.5' }, [
      el('div', {}, [`Enabled: ${v.enabled !== false ? 'yes' : 'no'}`]),
      v.accent ? el('div', {}, [`Accent: ${v.accent}`]) : '',
      v.model ? el('div', {}, [`Model: ${v.model}`]) : '',
    ].filter(Boolean));
  }

  // ---- Events: 4-lane transcript ----

  /**
   * Handle an event op from the store.
   * Routes to the appropriate renderer based on event name.
   */
  _handleEvent(event) {
    switch (event.name) {
      case 'narration':
        this._handleStreamingEvent(event.data, 'narration');
        break;
      case 'dialogue':
        this._handleStreamingEvent(event.data, 'dialogue');
        break;
      case 'system': {
        const d = event.data || {};
        // HUD-only noise never reaches the story: the combat HUD already renders
        // the projected timeline queue and the overdrive meters.
        if ((d.kind === 'combat' && d.phase === 'timeline') || d.kind === 'meter') break;
        if (d.kind === 'roll') {
          this._handleRollEvent(d);
        } else {
          this._handleStreamingEvent(d, 'system');
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * Handle an action from the player (broadcast from server after journaling).
   */
  _handleAction(event) {
    const text = event.text || '';
    const by = event.by || 'You';
    this._appendTranscriptEntry('action', {
      by,
      text,
      done: true,
    });
  }

  /**
   * P3: render dice roll result as a centered, muted line.
   */
  _handleRollEvent(data) {
    const text = data.text || 'Unknown roll';
    const detail = data.detail || {};
    const success = detail.success !== undefined ? detail.success : null;

    const entry = el('div', { className: 'py-1 text-center' }, [
      el('span', {
        className: 'text-xs px-2 py-0.5 rounded ' + (success === true
          ? 'text-green-400/70 bg-green-900/20'
          : success === false
          ? 'text-red-400/70 bg-red-900/20'
          : 'text-gray-500 bg-gray-800/50 italic'),
        textContent: text,
      }),
    ]);

    this._getTranscriptContainer().appendChild(entry);
    this._scrollToBottom();
  }

  /**
   * Generalized streaming event handler — works for narration, dialogue, system.
   * - delta events with streamId: find/create entry, accumulate text
   * - done:true events with streamId: finalize entry
   * - events without streamId: render as single complete entry
   */
  _handleStreamingEvent(data, eventName) {
    if (!data) return;

    const streamId = data.streamId;

    if (streamId) {
      const existing = this._streamEls.get(streamId);

      if (data.done) {
        // Finalize — render as complete entry
        const finalText = data.text || (existing ? existing.text : '');
        const mergedData = { ...data, text: finalText, done: true };
        this._appendTranscriptEntry(eventName, mergedData);

        // Remove streaming element if it exists
        if (existing) {
          existing.element.remove();
          this._streamEls.delete(streamId);
        }
        return;
      }

      if (data.delta) {
        if (existing) {
          // Append delta to existing streaming entry
          existing.text += data.delta;
          this._updateStreamingEntry(existing, eventName, data);
        } else {
          // Create new streaming entry
          const entryEl = this._createStreamingEntry(eventName, data);
          this._getTranscriptContainer().appendChild(entryEl);
          this._streamEls.set(streamId, { element: entryEl, text: data.delta });
        }
      }
    } else {
      // No streamId — render as single complete entry
      this._appendTranscriptEntry(eventName, data);
    }

    this._scrollToBottom();
  }

  /**
   * Append a completed transcript entry (non-streaming).
   */
  _appendTranscriptEntry(eventName, data) {
    const container = this._getTranscriptContainer();
    const entryEl = this._renderTranscriptEntry(eventName, data, true);
    container.appendChild(entryEl);
    this._scrollToBottom();
  }

  /**
   * Create a streaming entry (delta-only, will be updated via _updateStreamingEntry).
   */
  _createStreamingEntry(eventName, data) {
    return this._renderTranscriptEntry(eventName, data, false);
  }

  /**
   * Update an existing streaming entry's text content.
   */
  _updateStreamingEntry(existing, eventName, data) {
    // Simple approach: replace inner content of the text area
    const textEl = existing.element.querySelector('[data-transcript-text]');
    if (textEl) {
      textEl.textContent = existing.text;
    }
  }

  /**
   * Render a single transcript entry element based on event name.
   * 4 lanes:
   *   - narration (by:'dm'): full-width prose, muted-gold "narrator" styling
   *   - dialogue: speaker chip with accent color, bubble styling
   *   - system: compact, muted, centered
   *   - action: right-aligned "You: <text>"
   *
   * @param {string} eventName — 'narration', 'dialogue', 'system', 'action'
   * @param {object} data — event data {text, delta, done, by, speaker, name, accent, ...}
   * @param {boolean} done — whether this is the finalized entry
   * @returns {HTMLElement}
   */
  _renderTranscriptEntry(eventName, data, done) {
    switch (eventName) {
      case 'narration':
        return this._renderNarrationEntry(data, done);
      case 'dialogue':
        return this._renderDialogueEntry(data, done);
      case 'system':
        return this._renderSystemEntry(data, done);
      case 'action':
        return this._renderActionEntry(data, done);
      default:
        return this._renderGenericEntry(data, eventName, done);
    }
  }

  /**
   * DM narration lane: full-width prose, muted-gold styling, no chip.
   */
  _renderNarrationEntry(data, done) {
    const text = data.delta || data.text || '';
    const isStreaming = !done && !!data.streamId;

    const classes = 'py-2 border-b border-gray-800 last:border-0';
    const textClasses = 'text-amber-200/80 italic leading-relaxed';

    const entry = el('div', { className: classes }, [
      el('div', { className: 'flex items-start gap-2' }, [
        el('span', {
          className: 'text-xs text-amber-600/60 uppercase tracking-wider shrink-0 mt-0.5 w-16 text-right',
          textContent: 'narrator',
        }),
        el('span', {
          className: textClasses + (isStreaming ? '' : ''),
          'data-transcript-text': '',
          textContent: isStreaming ? text : text,
        }),
      ]),
    ]);

    return entry;
  }

  /**
   * NPC dialogue lane: speaker chip (name) with accent color, quote/bubble styling.
   */
  _renderDialogueEntry(data, done) {
    const text = data.delta || data.text || '';
    const speaker = data.name || data.speaker || 'NPC';
    const accent = data.accent || '#4a9eff';
    const isStreaming = !done && !!data.streamId;

    // Portrait: the speaker's generated art if they have any; initial otherwise.
    const portrait = el('div', {
      className: 'w-8 h-8 rounded-full shrink-0 border border-dashed flex items-center justify-center text-xs overflow-hidden',
      style: `border-color:${accent}66; color:${accent}`,
      textContent: speaker.charAt(0).toUpperCase(),
    });
    if (data.by) {
      const port = typeof __TTRPG_PORT__ !== 'undefined' ? __TTRPG_PORT__ : '8420';
      const img = el('img', {
        src: `http://${location.hostname}:${port}/art/${encodeURIComponent(data.by)}`,
        className: 'w-full h-full object-cover',
        alt: speaker,
      });
      img.onload = () => {
        portrait.textContent = '';
        portrait.classList.remove('border-dashed');
        portrait.appendChild(img);
      };
    }

    const entry = el('div', { className: 'py-2 border-b border-gray-800 last:border-0' }, [
      el('div', { className: 'flex items-start gap-2' }, [
        portrait,
        // Speaker chip + text
        el('div', { className: 'flex-1 min-w-0' }, [
          el('span', {
            className: 'inline-block text-xs font-semibold px-2 py-0.5 rounded-full mb-1',
            style: `background:${accent}22; color:${accent}; border:1px solid ${accent}44`,
            textContent: speaker,
          }),
          el('div', {
            className: 'text-gray-200 leading-relaxed',
            'data-transcript-text': '',
            textContent: isStreaming ? text : `"${text}"`,
          }),
        ]),
      ]),
    ]);

    return entry;
  }

  /**
   * System lane: compact, muted, centered.
   */
  _renderSystemEntry(data, done) {
    const text = data.delta || data.text || '';
    const isStreaming = !done && !!data.streamId;

    const entry = el('div', { className: 'py-1 text-center' }, [
      el('span', {
        className: 'text-xs text-gray-600 italic',
        'data-transcript-text': '',
        textContent: isStreaming ? text : text,
      }),
    ]);

    return entry;
  }

  /**
   * Player action lane: right-aligned "You: <text>".
   */
  _renderActionEntry(data, done) {
    const text = data.text || '';
    const by = data.by || 'You';

    const entry = el('div', { className: 'py-1 text-right' }, [
      el('span', { className: 'text-xs text-blue-400/60 mr-1' }, [`${by}:`]),
      el('span', { className: 'text-blue-200' }, [text]),
    ]);

    return entry;
  }

  /**
   * Generic fallback for unknown event types.
   */
  _renderGenericEntry(data, eventName, done) {
    const text = data.delta || data.text || JSON.stringify(data);
    const entry = el('div', { className: 'py-1 border-b border-gray-800 last:border-0' }, [
      el('span', { className: 'text-xs text-gray-500 mr-2' }, [eventName]),
      el('span', { className: 'text-gray-400' }, [text]),
    ]);
    return entry;
  }

  // ---- Helpers ----

  /**
   * Get the transcript container element (create inside #narration-log if missing).
   */
  _getTranscriptContainer() {
    if (this.transcriptEl) return this.transcriptEl;
    const log = document.getElementById('narration-log');
    if (log) {
      this.transcriptEl = el('div', { id: 'transcript-entries', className: 'text-sm space-y-0' });
      log.appendChild(this.transcriptEl);
      return this.transcriptEl;
    }
    console.warn('[view] No transcript container found');
    return document.body;
  }

  _scrollToBottom() {
    const log = document.getElementById('narration-log');
    if (log) {
      log.scrollTop = log.scrollHeight;
    }
  }

  /**
   * Replay journal history into the transcript (refresh keeps the story).
   * Only ephemeral story ops are rendered — state ops are already in the snapshot.
   * @param {Array<object>} entries — journal entries from GET /events
   */
  backfill(entries) {
    if (!Array.isArray(entries) || !entries.length) return;
    const container = this._getTranscriptContainer();
    let rendered = 0;
    for (const e of entries) {
      if (e.op === 'action' && e.text) {
        container.appendChild(this._renderTranscriptEntry('action', { by: e.by || 'You', text: e.text, done: true }, true));
        rendered++;
      } else if (e.op === 'event' && ['narration', 'dialogue', 'system'].includes(e.name)) {
        const d = e.data || {};
        if (!d.text) continue; // streaming deltas never reach the journal; only finals carry text
        if ((d.kind === 'combat' && d.phase === 'timeline') || d.kind === 'meter') continue;
        if (d.kind === 'roll') {
          const detail = d.detail || {};
          const success = detail.success !== undefined ? detail.success : null;
          container.appendChild(el('div', { className: 'py-1 text-center' }, [
            el('span', {
              className: 'text-xs px-2 py-0.5 rounded ' + (success === true
                ? 'text-green-400/70 bg-green-900/20' : success === false
                ? 'text-red-400/70 bg-red-900/20' : 'text-gray-500 bg-gray-800/50 italic'),
              textContent: d.text,
            }),
          ]));
        } else {
          container.appendChild(this._renderTranscriptEntry(e.name, { ...d, done: true }, true));
        }
        rendered++;
      }
    }
    if (rendered) {
      container.appendChild(el('div', { className: 'py-2 text-center text-[10px] uppercase tracking-widest text-gray-600' },
        ['— session resumes —']));
    }
    this._scrollToBottom();
  }

  // ---- Combat HUD (P5) ----

  _renderEncounterHud() {
    const entity = this.store.entities.get('encounter');
    const enc = entity && entity.encounter ? entity.encounter : null;

    if (!enc || !enc.active) {
      // Not in combat → show the current location as the scene.
      this._renderSceneLocation();
      return;
    }

    const round = enc.round;
    const order = enc.order || [];
    const turnIndex = enc.turnIndex;
    const enemies = new Set(enc.enemies || []);
    const isTimeline = enc.mode === 'timeline';
    // Timeline mode has no fixed `order` — list every combatant; "current" is turnOf.
    const combatants = isTimeline ? [...(enc.allies || []), ...(enc.enemies || [])] : order;
    const currentId = isTimeline ? enc.turnOf : order[turnIndex];

    clear(this.sceneAreaEl);
    this.sceneAreaEl.className = 'bg-gray-900 rounded-lg border border-gray-700 p-3 min-h-[200px] overflow-y-auto';

    // Round header
    this.sceneAreaEl.appendChild(
      el('div', { className: 'text-center mb-3' }, [
        el('span', { className: 'text-lg font-bold text-yellow-400' }, [`⚔ Round ${round}`]),
      ])
    );

    // C2: the visible CTB turn bar — upcoming actor chips from enc.queue.
    if (isTimeline && (enc.queue || []).length) {
      this.sceneAreaEl.appendChild(this._renderTurnBar(enc.queue, currentId, enemies));
    }

    // Combatant rows
    const orderContainer = el('div', { className: 'space-y-1' });

    for (let i = 0; i < combatants.length; i++) {
      const id = combatants[i];
      const comps = this.store.entities.get(id);
      if (!comps) continue;

      const identity = comps.identity || {};
      const stats = comps.stats || {};
      const status = comps.status || {};
      const name = identity.name || id;
      const hp = stats.hp ?? '?';
      const maxHp = stats.maxHp ?? '?';
      const alive = status.alive !== false;
      const isCurrent = id === currentId;
      const isEnemy = enemies.has(id);

      const hpPercent = maxHp > 0 ? Math.max(0, Math.min(100, (hp / maxHp) * 100)) : 100;
      const barColor = hpPercent > 50 ? 'bg-green-500' : hpPercent > 25 ? 'bg-yellow-500' : 'bg-red-500';

      const row = el('div', {
        className: `flex items-center gap-2 p-2 rounded ${isCurrent ? 'bg-gray-700 border border-yellow-600' : ''} ${!alive ? 'opacity-50' : ''}`,
      }, [
        el('span', { className: 'text-xs text-gray-500 w-6 shrink-0' }, [String(i + 1)]),
        el('span', {
          className: `font-medium text-sm ${alive ? (isEnemy ? 'text-red-300' : 'text-blue-300') : 'text-gray-500 line-through'}`,
          textContent: name + (isCurrent ? ' ◀' : ''),
        }),
        el('div', { className: 'flex-1 h-4 bg-gray-800 rounded overflow-hidden ml-2' }, [
          el('div', {
            className: `h-full ${barColor} rounded transition-all`,
            style: `width:${hpPercent}%`,
          }),
        ]),
        el('span', { className: 'text-xs text-gray-400 w-16 text-right shrink-0' }, [
          `${hp}/${maxHp}`,
        ]),
      ]);

      // C5: overdrive meter pip (limit-break charge).
      const od = (comps.meter && comps.meter.overdrive) || 0;
      if (od > 0) {
        const odPct = Math.max(0, Math.min(100, od));
        row.appendChild(el('div', {
          className: 'h-2 w-10 bg-gray-900 rounded overflow-hidden shrink-0 border border-amber-700/40',
          title: `Overdrive ${od}/100`,
        }, [
          el('div', { className: `h-full ${odPct >= 100 ? 'bg-amber-300 animate-pulse' : 'bg-amber-500'}`, style: `width:${odPct}%` }),
        ]));
      }

      // C1: active status chips (bleed/stun/rage/…).
      const statuses = (comps.statuses && comps.statuses.list) || [];
      if (statuses.length) {
        row.appendChild(el('div', { className: 'flex gap-1 ml-1 shrink-0' },
          statuses.map(s => el('span', {
            className: 'text-[10px] px-1 rounded bg-purple-900/40 text-purple-300 border border-purple-700/40',
            title: `${s.kind}${s.magnitude != null ? ` ×${s.magnitude}` : ''}${s.remaining ? ` (${s.remaining} left)` : ''}`,
          }, [`${s.kind}${s.remaining ? ` ${s.remaining}` : ''}`]))));
      }

      orderContainer.appendChild(row);
    }

    this.sceneAreaEl.appendChild(orderContainer);

    // C4: zone lanes (combatant chips + hazard markers + a "move here" affordance).
    const pcForZones = this._findPc();
    if ((enc.zones || []).length && pcForZones) {
      this.sceneAreaEl.appendChild(this._renderZones(enc, pcForZones[0], currentId));
    }

    // C1: when it's the PC's turn, render the Move menu + target picker.
    const pcPair = this._findPc();
    if (pcPair) {
      const [pcId, pc] = pcPair;
      const moves = (pc.moves && pc.moves.list) || [];
      if (currentId === pcId && moves.length) {
        this.sceneAreaEl.appendChild(this._renderMoveMenu(pcId, moves, enc));
      } else {
        this._selectedMove = null;
      }
    }
  }

  /**
   * C2 turn bar: a horizontal strip of upcoming actor chips (name + accent + HP pip),
   * current actor highlighted. Driven by the encounter's projected `queue`.
   */
  _renderTurnBar(queue, currentId, enemies) {
    const bar = el('div', { className: 'flex items-center gap-1 mb-3 overflow-x-auto pb-1' });
    bar.appendChild(el('span', { className: 'text-[10px] uppercase tracking-wider text-gray-500 shrink-0 mr-1' }, ['Next']));
    queue.forEach((id, i) => {
      const comps = this.store.entities.get(id) || {};
      const name = (comps.identity || {}).name || id;
      const stats = comps.stats || {};
      const hp = stats.hp ?? '?';
      const maxHp = stats.maxHp ?? '?';
      const isEnemy = enemies.has(id);
      const isNow = i === 0 || id === currentId;
      const accent = isEnemy ? 'text-red-300 border-red-700/50' : 'text-blue-300 border-blue-700/50';
      bar.appendChild(el('div', {
        className: `shrink-0 px-2 py-0.5 rounded border text-[11px] ${accent} ${isNow ? 'bg-yellow-900/30 ring-1 ring-yellow-600' : 'bg-gray-800/60'}`,
        title: `${name} — ${hp}/${maxHp}`,
      }, [`${name.split(' ').slice(-1)[0]} ${hp}`]));
    });
    return bar;
  }

  /**
   * C4 zone lanes: each authored zone as a labeled lane with the combatants standing
   * in it, hazard markers, and a "move here" button when the PC is elsewhere.
   */
  _renderZones(enc, pcId, currentId) {
    const zones = enc.zones || [];
    const enemies = new Set(enc.enemies || []);
    const combatants = [...(enc.allies || []), ...(enc.enemies || [])];
    const hazardsByZone = {};
    for (const h of (enc.hazards || [])) (hazardsByZone[h.zoneId] = hazardsByZone[h.zoneId] || []).push(h);
    const pcZone = ((this.store.entities.get(pcId) || {}).position || {}).zoneId || 'field';

    const wrap = el('div', { className: 'mt-3 grid grid-cols-2 gap-2' });
    for (const z of zones) {
      const here = combatants.filter(id => {
        const c = this.store.entities.get(id);
        return c && ((c.position || {}).zoneId || 'field') === z.id && (c.status || {}).alive !== false;
      });
      const haz = hazardsByZone[z.id] || [];
      const isPcHere = pcZone === z.id;

      const lane = el('div', {
        className: 'p-2 rounded border ' + (isPcHere ? 'border-yellow-700 bg-gray-800' : 'border-gray-700 bg-gray-800/40'),
      });
      lane.appendChild(el('div', { className: 'flex items-center justify-between mb-1' }, [
        el('span', { className: 'text-xs font-semibold text-gray-300' }, [z.label + ((z.tags || []).length ? ` [${z.tags.join(',')}]` : '')]),
        isPcHere ? el('span', { className: 'text-[10px] text-yellow-500' }, ['you are here'])
          : el('button', {
            className: 'text-[10px] px-1.5 py-0.5 bg-gray-700 hover:bg-gray-600 rounded text-emerald-300',
            onclick: () => this._send(`I move to ${z.label}`, undefined, undefined, z.id),
          }, ['move here']),
      ]));
      if (haz.length) {
        lane.appendChild(el('div', { className: 'text-[10px] text-orange-400 mb-1' }, ['🔥 ' + haz.map(h => `${h.kind}${h.remaining ? ` (${h.remaining})` : ''}`).join(', ')]));
      }
      if (here.length) {
        for (const id of here) {
          const c = this.store.entities.get(id);
          const nm = (c.identity || {}).name || id;
          lane.appendChild(el('div', {
            className: `text-xs ${enemies.has(id) ? 'text-red-300' : 'text-blue-300'} ${id === currentId ? 'font-bold' : ''}`,
          }, [(id === currentId ? '▶ ' : '') + nm]));
        }
      } else {
        lane.appendChild(el('div', { className: 'text-[10px] text-gray-600 italic' }, ['(empty)']));
      }
      wrap.appendChild(lane);
    }
    return wrap;
  }

  /**
   * C1 Move menu: render the PC's Moves as buttons. Self-target Moves (heal/buff/
   * utility) fire immediately; offensive Moves arm a target picker over living enemies.
   */
  _renderMoveMenu(pcId, moves, enc) {
    const SELF_TYPES = new Set(['heal', 'buff', 'utility']);
    const wrap = el('div', { className: 'mt-3 border-t border-gray-700 pt-2' });
    wrap.appendChild(el('div', { className: 'text-[10px] uppercase tracking-wider text-gray-500 mb-1' }, ['Your move']));

    const btns = el('div', { className: 'flex flex-wrap gap-1' });
    for (const m of moves) {
      btns.appendChild(el('button', {
        className: 'text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 text-gray-200 '
          + (this._selectedMove === m.name ? 'ring-1 ring-yellow-500' : ''),
        title: m.special || m.type || '',
        onclick: () => {
          if (SELF_TYPES.has(m.type)) {
            this._selectedMove = null;
            this._send(`I use ${m.name}`, m.name);
          } else {
            this._selectedMove = m.name;
            this._refreshScoped();
          }
        },
      }, [m.name]));
    }
    wrap.appendChild(btns);

    if (this._selectedMove) {
      const living = (enc.enemies || []).filter(id => {
        const c = this.store.entities.get(id);
        return c && (c.status || {}).alive !== false;
      });
      wrap.appendChild(el('div', { className: 'text-[10px] uppercase tracking-wider text-gray-500 mt-2 mb-1' }, [`Target for ${this._selectedMove}`]));
      const tg = el('div', { className: 'flex flex-wrap gap-1' });
      for (const id of living) {
        const name = ((this.store.entities.get(id) || {}).identity || {}).name || id;
        tg.appendChild(el('button', {
          className: 'text-xs px-2 py-1 rounded bg-red-900/50 hover:bg-red-800 text-red-200',
          onclick: () => {
            const mv = this._selectedMove;
            this._selectedMove = null;
            this._send(`I use ${mv} on ${name}`, mv, id);
          },
        }, [name]));
      }
      wrap.appendChild(tg);
    }
    return wrap;
  }

  // ---- Scoped player view (You / Here / Quests) ----
  //
  // Mirrors shared/space.js scoping (findPc / entitiesAt / exits) so the player
  // only sees the room they're in — present NPCs, items on the ground, and exits
  // — never the whole world. NPCs/items/exits are clickable to act.

  /** All [id, comps] player characters (the party). */
  _findPcs() {
    const out = [];
    for (const [id, comps] of this.store.entities) {
      if ((comps.identity || {}).kind === 'pc') out.push([id, comps]);
    }
    return out;
  }

  /** The PC THIS client drives: controller === my name, else an unbound PC, else the first. */
  _findPc() {
    const pcs = this._findPcs();
    if (!pcs.length) return null;
    if (this.myName) {
      const my = this.myName.toLowerCase();
      const mine = pcs.find(([_id, c]) => ((c.agent || {}).controller || '').toLowerCase() === my);
      if (mine) return mine;
      const unbound = pcs.find(([_id, c]) => !(c.agent || {}).controller);
      if (unbound) return unbound;
    }
    return pcs[0];
  }

  /** Entities physically present at a location (carried items naturally excluded). */
  _entitiesAt(locId, { kinds, includeDead = false, exclude } = {}) {
    const out = [];
    if (!locId) return out;
    for (const [id, comps] of this.store.entities) {
      if (id === locId || id === exclude) continue;
      if ((comps.place || {}).locationId !== locId) continue;
      const kind = (comps.identity || {}).kind;
      if (kinds && !kinds.includes(kind)) continue;
      if (!includeDead && (comps.status || {}).alive === false) continue;
      out.push([id, comps]);
    }
    return out;
  }

  /** Send a player action (set by main.js → net.sendAction). C1: move/target; C4: zone. */
  _send(text, move, target, zone) {
    if (typeof this.onAction === 'function') this.onAction(text, move, target, zone);
  }

  /** A clickable HUD row that dispatches an action when clicked. */
  _clickRow(label, actionText, colorClass = 'text-gray-300') {
    const row = el('div', {
      className: `text-sm ${colorClass} cursor-pointer rounded px-1 py-0.5 hover:bg-gray-700/60 transition-colors`,
      onclick: () => this._send(actionText),
      title: actionText,
    }, [label]);
    return row;
  }

  /** Rebuild the scoped player HUD inside #inspector (above the debug dump). */
  _renderPlayerHud() {
    const inspector = document.getElementById('inspector');
    if (!inspector) return;
    if (!this._playerHudEl || !this._playerHudEl.parentNode) {
      this._playerHudEl = el('div', { id: 'player-hud', className: 'flex flex-col gap-3' });
      inspector.insertBefore(this._playerHudEl, inspector.firstChild);
    }
    clear(this._playerHudEl);

    const pcPair = this._findPc();
    if (!pcPair) {
      this._playerHudEl.appendChild(
        el('div', { className: 'text-gray-600 text-sm italic p-2' }, ['Waiting for the world…']),
      );
      return;
    }
    const [pcId, pc] = pcPair;
    const locId = (pc.place || {}).locationId || null;
    const loc = locId ? this.store.entities.get(locId) : null;

    // The world clock (P4): day + phase, always in view.
    const ws = this.store.entities.get('world-state');
    if (ws && ws.clock) {
      const icons = { morning: '🌅', afternoon: '☀️', evening: '🌇', night: '🌙' };
      this._playerHudEl.appendChild(
        el('div', { className: 'px-3 py-1.5 bg-gray-800 rounded border border-gray-700 text-xs text-gray-300 flex items-center gap-2' }, [
          el('span', {}, [icons[ws.clock.phase] || '🕰']),
          el('span', { className: 'text-amber-200/90' }, [`Day ${ws.clock.day}`]),
          el('span', { className: 'text-gray-500' }, ['·']),
          el('span', { className: 'capitalize' }, [ws.clock.phase || 'morning']),
        ]),
      );
    }

    // Every party member at a glance; my own sheet expanded.
    for (const [id, comps] of this._findPcs()) {
      this._playerHudEl.appendChild(this._renderYouCard(comps, id === pcId));
    }
    this._playerHudEl.appendChild(this._renderHereCard(pcId, locId, loc));
    const quests = this._renderQuestsCard();
    if (quests) this._playerHudEl.appendChild(quests);
  }

  /** Party-member card: name, level/XP, HP bar, conditions, inventory chips. */
  _renderYouCard(pc, isMine = true) {
    const identity = pc.identity || {};
    const stats = pc.stats || {};
    const status = pc.status || {};
    const controller = (pc.agent || {}).controller || null;
    const hp = stats.hp ?? '?';
    const maxHp = stats.maxHp ?? '?';
    const pct = (typeof hp === 'number' && maxHp > 0) ? Math.max(0, Math.min(100, (hp / maxHp) * 100)) : 100;
    const barColor = pct > 50 ? 'bg-green-500' : pct > 25 ? 'bg-yellow-500' : 'bg-red-500';
    const inv = (pc.inventory && pc.inventory.items) || [];
    const conds = status.conditions || [];

    return el('div', { className: 'p-3 bg-gray-800 rounded border border-gray-700' }, [
      el('div', { className: 'flex items-baseline justify-between mb-2' }, [
        el('span', { className: 'font-semibold text-gray-100' }, [
          identity.name || 'You',
          isMine
            ? el('span', { className: 'ml-2 text-[10px] px-1.5 py-0.5 rounded bg-blue-900/60 text-blue-300 align-middle' }, ['YOU'])
            : (controller ? el('span', { className: 'ml-2 text-[10px] text-gray-500 align-middle' }, [controller]) : ''),
        ]),
        el('span', { className: 'text-xs text-yellow-400 font-bold' }, [
          `Lv ${stats.level || 1}`,
          el('span', { className: 'text-gray-500 font-normal ml-1' }, [`· XP ${stats.xp || 0}`]),
        ]),
      ]),
      el('div', { className: 'flex items-center gap-2 mb-2' }, [
        el('div', { className: 'flex-1 h-3 bg-gray-900 rounded overflow-hidden' }, [
          el('div', { className: `h-full ${barColor} rounded transition-all`, style: `width:${pct}%` }),
        ]),
        el('span', { className: 'text-xs text-gray-400 w-14 text-right' }, [`${hp}/${maxHp}`]),
      ]),
      conds.length ? el('div', { className: 'text-xs text-amber-400/80 mb-2' }, [conds.join(', ')]) : '',
      el('div', { className: 'flex flex-wrap gap-1' },
        inv.length
          ? inv.map(i => el('span', { className: 'text-xs px-2 py-0.5 bg-gray-700 rounded text-gray-300' },
              [(i.name || i.id) + (i.qty > 1 ? ` ×${i.qty}` : '')]))
          : [el('span', { className: 'text-xs text-gray-600 italic' }, ['(empty pack)'])],
      ),
    ].filter(Boolean));
  }

  /** "Here" card: current location + present people / items / exits, all clickable. */
  _renderHereCard(pcId, locId, loc) {
    const card = el('div', { className: 'p-3 bg-gray-800 rounded border border-gray-700 flex flex-col gap-2' });
    card.appendChild(el('div', { className: 'text-[10px] uppercase tracking-wider text-gray-500' }, ['Here']));
    card.appendChild(el('div', { className: 'font-medium text-gray-200' }, [
      (loc && loc.identity && loc.identity.name) || 'Nowhere',
    ]));

    const npcs = this._entitiesAt(locId, { kinds: ['npc'], includeDead: true, exclude: pcId });
    const items = this._entitiesAt(locId, { kinds: ['item'], exclude: pcId });
    const exits = ((loc && loc.place && loc.place.connections) || [])
      .filter(c => c.targetId && this.store.entities.get(c.targetId));

    if (npcs.length) {
      const group = el('div', {}, [
        el('div', { className: 'text-[10px] uppercase tracking-wider text-gray-600 mb-0.5' }, ['People']),
      ]);
      for (const [id, comps] of npcs) {
        const name = (comps.identity || {}).name || id;
        if ((comps.status || {}).alive === false) {
          group.appendChild(el('div', { className: 'text-sm text-gray-600 line-through px-1 py-0.5' }, [name]));
          continue;
        }
        const hostile = !!(comps.flags && comps.flags.hostile);
        group.appendChild(this._clickRow(
          (hostile ? '⚔ ' : '💬 ') + name,
          hostile ? `attack the ${name}` : `talk to ${name}`,
          hostile ? 'text-red-300' : 'text-blue-300',
        ));
      }
      card.appendChild(group);
    }

    if (items.length) {
      const group = el('div', {}, [
        el('div', { className: 'text-[10px] uppercase tracking-wider text-gray-600 mb-0.5' }, ['Items']),
      ]);
      for (const [id, comps] of items) {
        const name = (comps.identity || {}).name || id;
        group.appendChild(el('div', { className: 'flex items-center justify-between gap-2 px-1 py-0.5' }, [
          el('span', {
            className: 'text-sm text-gray-300 cursor-pointer hover:text-white',
            onclick: () => this._send(`examine the ${name}`),
            title: `examine the ${name}`,
          }, [name]),
          el('button', {
            className: 'text-[10px] px-1.5 py-0.5 bg-gray-700 hover:bg-gray-600 rounded text-gray-300 shrink-0',
            onclick: (e) => { e.stopPropagation(); this._send(`take the ${name}`); },
            title: `take the ${name}`,
          }, ['take']),
        ]));
      }
      card.appendChild(group);
    }

    if (exits.length) {
      const group = el('div', {}, [
        el('div', { className: 'text-[10px] uppercase tracking-wider text-gray-600 mb-0.5' }, ['Exits']),
      ]);
      for (const c of exits) {
        const target = this.store.entities.get(c.targetId);
        const tname = (target && target.identity && target.identity.name) || c.label || c.targetId;
        group.appendChild(this._clickRow(`→ ${c.label || tname}`, `go to ${tname}`, 'text-emerald-300'));
      }
      card.appendChild(group);
    }

    if (!npcs.length && !items.length && !exits.length) {
      card.appendChild(el('div', { className: 'text-sm text-gray-600 italic' }, ['Nothing of note here.']));
    }

    return card;
  }

  /** "Quests" card (active + recently completed), or null if none. */
  _renderQuestsCard() {
    const quests = [];
    for (const [, comps] of this.store.entities) {
      if ((comps.identity || {}).kind === 'quest' && comps.quest && comps.quest.phase !== 'available') {
        quests.push(comps);
      }
    }
    if (!quests.length) return null;

    const card = el('div', { className: 'p-3 bg-gray-800 rounded border border-gray-700 flex flex-col gap-1' });
    card.appendChild(el('div', { className: 'text-[10px] uppercase tracking-wider text-gray-500' }, ['Quests']));

    for (const q of quests) {
      const qc = q.quest;
      const name = (q.identity && q.identity.name) || '?';
      const steps = qc.steps || [];
      const cur = qc.currentStep ?? 0;
      if (qc.phase === 'completed') {
        card.appendChild(el('div', { className: 'text-gray-600 line-through text-sm' }, [`✓ ${name}`]));
      } else {
        const sd = steps[cur];
        const stepText = typeof sd === 'string' ? sd : (sd && sd.text ? sd.text : `Step ${cur + 1}`);
        card.appendChild(el('div', {}, [
          el('div', { className: 'text-gray-300 font-medium text-sm' }, [name]),
          el('div', { className: 'text-gray-500 text-xs' }, [`${cur + 1}/${steps.length} — ${stepText}`]),
        ]));
      }
    }
    return card;
  }

  /** Scene area (non-combat): the current location as title + prose + image slot. */
  _renderSceneLocation() {
    const pcPair = this._findPc();
    const locId = pcPair ? (pcPair[1].place || {}).locationId : null;
    const loc = locId ? this.store.entities.get(locId) : null;

    if (!loc) {
      clear(this.sceneAreaEl);
      this.sceneAreaEl.className = 'bg-gray-900 rounded-lg border border-gray-700 flex items-center justify-center min-h-[200px]';
      this.sceneAreaEl.appendChild(el('span', { className: 'text-gray-600 text-sm' }, ['[ scene ]']));
      return;
    }

    const id = loc.identity || {};
    const port = typeof __TTRPG_PORT__ !== 'undefined' ? __TTRPG_PORT__ : '8420';
    const serverBase = `http://${location.hostname}:${port}`;

    // THE WALKABLE WORLD: locations with a tile grid render as a live canvas —
    // point-click walking, exits travel, enemies hand off into combat. The
    // worldview persists across store re-renders (same location ⇒ same canvas,
    // the avatar keeps walking).
    if (loc.tiles && this.onAction) {
      if (!this.worldview) {
        this.worldview = new WorldView({
          store: this.store,
          onAction: (text, move, target, zone) => this.onAction(text, move, target, zone),
          serverBase,
        });
      }
      const samePlace = this.worldview.locId === locId &&
        this.worldview.wrap && this.worldview.wrap.parentElement === this.sceneAreaEl;
      if (samePlace) {
        this.worldview.mount(this.sceneAreaEl, locId, pcPair[0]); // token refresh only
        return;
      }
      clear(this.sceneAreaEl);
      this.sceneAreaEl.className = 'bg-gray-900 rounded-lg border border-gray-700 p-3 min-h-[200px] overflow-y-auto flex flex-col';
      // The painted scene stays as a slim atmosphere banner above the map.
      if ((loc.art || {}).prompt) {
        const frame = el('div', { className: 'rounded overflow-hidden border border-gray-800 mb-2 bg-gray-800/40' }, []);
        const img = el('img', {
          src: `${serverBase}/art/${encodeURIComponent(locId)}`,
          alt: id.name || 'scene',
          className: 'w-full max-h-24 object-cover block opacity-90',
        });
        img.onerror = () => frame.remove();
        frame.appendChild(img);
        this.sceneAreaEl.appendChild(frame);
      }
      if (this.worldview.mount(this.sceneAreaEl, locId, pcPair[0])) return;
      // fall through to the prose scene if mounting failed
    }

    clear(this.sceneAreaEl);
    this.sceneAreaEl.className = 'bg-gray-900 rounded-lg border border-gray-700 p-5 min-h-[200px] overflow-y-auto flex flex-col';
    // Scene art from the server's art engine (GET /art/<locId>, cache-first;
    // 404 = no art.prompt on this location → the frame simply hides itself).
    if ((loc.art || {}).prompt) {
      const frame = el('div', { className: 'rounded overflow-hidden border border-gray-800 mb-4 bg-gray-800/40' }, []);
      const img = el('img', {
        src: `${serverBase}/art/${encodeURIComponent(locId)}`,
        alt: id.name || 'scene',
        className: 'w-full max-h-72 object-cover block',
      });
      img.onerror = () => frame.remove();
      frame.appendChild(img);
      this.sceneAreaEl.appendChild(frame);
    }
    this.sceneAreaEl.appendChild(el('div', { className: 'text-amber-300/90 font-semibold text-lg mb-1' }, [id.name || 'Here']));
    if (id.description) {
      this.sceneAreaEl.appendChild(el('div', { className: 'text-gray-400 text-sm leading-relaxed' }, [id.description]));
    }
  }

  _renderEncounter(v) {
    const orderPreview = (v.order || []).map(id => {
      const comps = this.store.entities.get(id);
      return comps && comps.identity ? comps.identity.name : id;
    }).join(' → ');

    return el('div', { className: 'text-gray-300 space-y-0.5' }, [
      el('div', {}, [`Active: ${v.active ? 'yes' : 'no'}`]),
      el('div', {}, [`Round: ${v.round} · Turn: ${v.turnIndex}`]),
      el('div', {}, [`Mode: ${v.mode}`]),
      el('div', {}, [`Allies: ${(v.allies || []).join(', ')}`]),
      el('div', {}, [`Enemies: ${(v.enemies || []).join(', ')}`]),
      el('div', {}, [`Order: ${orderPreview}`]),
    ].filter(Boolean));
  }
}
