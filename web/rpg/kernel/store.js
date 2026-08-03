/**
 * client/kernel/store.js — SessionStore.
 * Client-side mirror of server entities. Never authoritative.
 *
 * Based on GAIA's client/kernel/world.js store pattern.
 */

export class SessionStore {
  entities = new Map();       // id → { componentName: value }
  listeners = new Set();      // onChange callbacks

  /**
   * Full replace from server snapshot.
   * Emits {kind:'snapshot'}.
   */
  applySnapshot(entities) {
    this.entities = new Map();
    for (const [id, comps] of Object.entries(entities)) {
      this.entities.set(id, { ...comps });
    }
    this._emit({ kind: 'snapshot' });
  }

  /**
   * Apply incremental ops from server broadcast.
   * Emits per-op events for view reconciliation.
   */
  applyOps(ops) {
    for (const op of ops) {
      switch (op.op) {
        case 'spawn': {
          // Broadcasts carry the full op (with components) — no reconstruction needed.
          const comps = {};
          if (op.components) {
            for (const [name, val] of Object.entries(op.components)) {
              comps[name] = (val && typeof val === 'object') ? { ...val } : val;
            }
          }
          if (op.id) {
            this.entities.set(op.id, comps);
            this._emit({ kind: 'spawn', id: op.id });
          }
          break;
        }
        case 'set': {
          if (op.id && this.entities.has(op.id)) {
            const comps = this.entities.get(op.id);
            if (op.component) {
              if (op.value === null || op.value === undefined) {
                delete comps[op.component];
              } else if (Array.isArray(op.value)) {
                comps[op.component] = [...op.value];
              } else if (typeof op.value === 'object') {
                comps[op.component] = { ...op.value };
              } else {
                comps[op.component] = op.value;
              }
            }
            this._emit({ kind: 'set', id: op.id, component: op.component });
          }
          break;
        }
        case 'merge': {
          if (op.id) {
            if (!this.entities.has(op.id)) {
              this.entities.set(op.id, {});
            }
            const comps = this.entities.get(op.id);
            if (op.component && op.value) {
              if (!comps[op.component]) comps[op.component] = {};
              Object.assign(comps[op.component], op.value);
            }
            this._emit({ kind: 'merge', id: op.id, component: op.component });
          }
          break;
        }
        case 'despawn': {
          if (op.id && this.entities.has(op.id)) {
            this.entities.delete(op.id);
            this._emit({ kind: 'despawn', id: op.id });
          }
          break;
        }
        case 'event': {
          this._emit({ kind: 'event', name: op.name, data: op.data });
          break;
        }
        case 'action':
          // Broadcast to view for transcript rendering
          this._emit({ kind: 'action', text: op.text, by: op.by });
          break;
        case 'roll':
          // Journaled but no UI for now
          break;
        case 'reset':
          this._emit({ kind: 'reset', scene: op.scene });
          break;
      }
    }
  }

  /**
   * Subscribe to store changes.
   * @param {(event:object)=>void} fn
   * @returns {()=>void} unsubscribe
   */
  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  _emit(event) {
    for (const fn of this.listeners) {
      try { fn(event); } catch (_) { /* ignore */ }
    }
  }
}
