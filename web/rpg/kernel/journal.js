/**
 * client/kernel/journal.js — Quest journal overlay.
 *
 * Toggled by the 'J' key (ignored while typing/copying — see dom.js
 * isTypingContext) or a 📜 toolbar button. Lists every quest entity the
 * client already holds in its SessionStore mirror (id, title/name, phase,
 * currentStep) — read-only, no fetch, no ops. Mirrors the overlay pattern
 * used by the addons settings panel (kernel/addons.js).
 */

import { el, isTypingContext } from './dom.js';

export class QuestJournal {
  /**
   * @param {{store:object, button?:HTMLElement}} opts
   * @param {object} opts.store — SessionStore instance (entities mirror)
   * @param {HTMLElement} [opts.button] — toolbar button that also toggles the overlay
   */
  constructor({ store, button }) {
    this.store = store;
    this.overlay = null;
    this._escHandler = null;

    if (button) button.addEventListener('click', () => this.toggle());

    window.addEventListener('keydown', (e) => {
      if (isTypingContext(e)) return;
      if (e.key === 'j' || e.key === 'J') this.toggle();
    });
  }

  toggle() {
    if (this.overlay) this.close();
    else this.open();
  }

  open() {
    this.close();
    const panel = el('div', {
      className: 'bg-gray-900 border border-gray-700 rounded-lg w-full max-w-lg max-h-[80vh] overflow-y-auto p-4 flex flex-col gap-3',
    }, [
      el('div', { className: 'flex items-center' }, [
        el('span', { className: 'text-amber-300 font-bold' }, ['📜 Quest Journal']),
        el('div', { className: 'flex-1' }),
        el('button', {
          className: 'text-gray-500 hover:text-gray-300 text-lg leading-none',
          onclick: () => this.close(),
        }, ['✕']),
      ]),
      this._renderQuests(),
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

  /** Render from whatever quest entities the client already received. */
  _renderQuests() {
    const quests = [];
    for (const [id, comps] of this.store.entities) {
      const identity = comps.identity || {};
      if (identity.kind !== 'quest' || !comps.quest) continue;
      quests.push({ id, identity, quest: comps.quest });
    }

    if (!quests.length) {
      return el('div', { className: 'text-gray-500 italic text-sm py-4 text-center' }, ['No quests yet']);
    }

    const list = el('div', { className: 'flex flex-col gap-2' });
    for (const q of quests) {
      const title = q.identity.name || q.id;
      const phase = q.quest.phase || '?';
      const step = q.quest.currentStep ?? 0;
      const total = (q.quest.steps || []).length;
      list.appendChild(el('div', { className: 'p-2 bg-gray-800 rounded border border-gray-700' }, [
        el('div', { className: 'font-medium text-gray-200 text-sm' }, [title]),
        el('div', { className: 'text-xs text-gray-500' }, [
          `Phase: ${phase}` + (total ? ` · Step ${step + 1}/${total}` : ''),
        ]),
      ]));
    }
    return list;
  }
}
