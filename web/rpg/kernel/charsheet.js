/**
 * client/kernel/charsheet.js — Character sheet panel.
 *
 * Toggled by the 'C' key (ignored while typing/copying — see dom.js
 * isTypingContext). Shows the protagonist — name, stats, inventory — read
 * straight from client-held entity state (SessionStore mirror). Graceful
 * when any field is missing. Mirrors the overlay pattern used by the quest
 * journal (kernel/journal.js) and the addons settings panel (kernel/addons.js).
 */

import { el, isTypingContext } from './dom.js';

export class CharacterSheet {
  /**
   * @param {{store:object, who:(string|(()=>string))}} opts
   * @param {object} opts.store — SessionStore instance (entities mirror)
   * @param {string|Function} opts.who — this client's player name, or a
   *   getter for it (identity can change after session-zero — see main.js)
   */
  constructor({ store, who }) {
    this.store = store;
    this.who = who;
    this.overlay = null;
    this._escHandler = null;

    window.addEventListener('keydown', (e) => {
      if (isTypingContext(e)) return;
      if (e.key === 'c' || e.key === 'C') this.toggle();
    });
  }

  toggle() {
    if (this.overlay) this.close();
    else this.open();
  }

  /** The PC this client drives: controller === who, else an unbound PC, else the first. */
  _findPc() {
    const whoVal = typeof this.who === 'function' ? this.who() : this.who;
    const my = (whoVal || '').toLowerCase();
    let unbound = null;
    let first = null;
    for (const [id, comps] of this.store.entities) {
      if ((comps.identity || {}).kind !== 'pc') continue;
      if (!first) first = [id, comps];
      const controller = ((comps.agent || {}).controller || '').toLowerCase();
      if (my && controller === my) return [id, comps];
      if (!controller && !unbound) unbound = [id, comps];
    }
    return unbound || first;
  }

  open() {
    this.close();
    const pcPair = this._findPc();
    const panel = el('div', {
      className: 'bg-gray-900 border border-gray-700 rounded-lg w-full max-w-lg max-h-[80vh] overflow-y-auto p-4 flex flex-col gap-3',
    }, [
      el('div', { className: 'flex items-center' }, [
        el('span', { className: 'text-amber-300 font-bold' }, ['🧾 Character Sheet']),
        el('div', { className: 'flex-1' }),
        el('button', {
          className: 'text-gray-500 hover:text-gray-300 text-lg leading-none',
          onclick: () => this.close(),
        }, ['✕']),
      ]),
      pcPair
        ? this._renderSheet(pcPair[1], pcPair[0])
        : el('div', { className: 'text-gray-500 italic text-sm py-4 text-center' }, ['No character yet']),
    ]);

    const overlay = el('div', {
      className: 'fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-6',
    }, [panel]);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) this.close(); });

    document.body.appendChild(overlay);
    this.overlay = overlay;

    this._escHandler = (e) => { if (e.key === 'Escape') this.close(); };
    window.addEventListener('keydown', this._escHandler);
  }

  close() {
    if (this.overlay) { this.overlay.remove(); this.overlay = null; }
    if (this._escHandler) { window.removeEventListener('keydown', this._escHandler); this._escHandler = null; }
  }

  _renderSheet(pc, entityId) {
    const identity = pc.identity || {};
    const stats = pc.stats || {};
    const status = pc.status || {};
    const inv = (pc.inventory && pc.inventory.items) || [];
    const progression = pc.progression;
    const canSpend = !!progression && progression.unspentPoints > 0;

    const statRows = [
      ['HP', 'hp', stats.hp != null ? `${stats.hp}${stats.maxHp != null ? ` / ${stats.maxHp}` : ''}` : '?'],
      // level/xp are earned, never bought — no spend key on these rows.
      ['Level', null, stats.level ?? '?'],
      ['XP', null, stats.xp ?? '?'],
    ];
    if (status.alive === false) statRows.push(['Status', null, 'dead']);
    else if ((status.conditions || []).length) statRows.push(['Conditions', null, status.conditions.join(', ')]);

    return el('div', { className: 'flex flex-col gap-3' }, [
      el('div', {}, [
        el('div', { className: 'text-lg font-semibold text-gray-100' }, [identity.name || 'Unnamed']),
        identity.description ? el('div', { className: 'text-sm text-gray-500 italic' }, [identity.description]) : '',
      ].filter(Boolean)),
      progression
        ? el('div', { className: 'flex items-center gap-2 text-sm text-gray-300' }, [
          el('span', {}, [`Level ${progression.level} — XP ${progression.xp}`]),
          progression.unspentPoints > 0
            ? el('span', { className: 'text-amber-300 font-semibold' }, [`Points to spend: ${progression.unspentPoints}`])
            : '',
        ].filter(Boolean))
        : '',
      el('div', { className: 'grid grid-cols-2 gap-1 text-sm' },
        statRows.map(([label, key, val]) => el('div', { className: 'text-gray-300 flex items-center gap-1' }, [
          `${label}: ${val}`,
          canSpend && key
            ? el('button', {
              className: 'text-amber-400 hover:text-amber-200 text-xs px-1 leading-none border border-amber-700/50 rounded',
              onclick: () => this._spendPoint(entityId, key),
            }, ['+'])
            : '',
        ].filter(Boolean)))),
      el('div', {}, [
        el('div', { className: 'text-[10px] uppercase tracking-wider text-gray-500 mb-1' }, ['Inventory']),
        inv.length
          ? el('div', { className: 'flex flex-wrap gap-1' },
            inv.map(i => el('span', { className: 'text-xs px-2 py-0.5 bg-gray-800 rounded text-gray-300' },
              [(i.name || i.id || '?') + (i.qty > 1 ? ` ×${i.qty}` : '')])))
          : el('div', { className: 'text-xs text-gray-600 italic' }, ['(empty pack)']),
      ]),
    ].filter(Boolean));
  }

  /**
   * Spend one unspent progression point on `stat` for `entityId`. The server
   * broadcasts the resulting entity delta on success, which drives the sheet's
   * existing update/re-render path — no optimistic local mutation here.
   * @param {string} entityId
   * @param {string} stat
   */
  _spendPoint(entityId, stat) {
    fetch('/progression/spend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entityId, stat }),
    }).then((res) => {
      if (!res.ok) console.warn(`[charsheet] spend '${stat}' failed: ${res.status}`);
    }).catch((err) => console.warn(`[charsheet] spend '${stat}' errored:`, err));
  }
}
