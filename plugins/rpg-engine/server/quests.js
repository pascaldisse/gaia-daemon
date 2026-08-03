/**
 * server/quests.js — quest + progression orchestrator.
 *
 * The pure rules live in shared/quest-triggers.js (trigger evaluation) and
 * shared/progression.js (XP/leveling). This module wires them into the live
 * session: after every player turn `evaluate()` advances/completes quests whose
 * current-step trigger is now satisfied, grants rewards (XP + items) as ops, and
 * applies level-ups. `awardXp()` is also called by combat on victory.
 *
 * Deterministic (no LLM). Quest banners use event:system kind:'quest'|'levelup';
 * completion also emits a deterministic DM-voice narration line.
 */

import { pendingAdvances } from '../shared/quest-triggers.js';
import { applyXp } from '../shared/progression.js';
import { expandOp } from '../shared/effects.js';
import { findPc, findPcs } from '../shared/space.js';

const MAX_ADVANCE_GUARD = 30; // a quest can advance several steps in one evaluate

export function createQuestEngine({ session, broadcast, applyAndBroadcast }) {
  const nameOf = (id) => ((session.entities.get(id) || {}).identity || {}).name || id;

  function questBanner(phase, text, extra = {}) {
    applyAndBroadcast([{ op: 'event', name: 'system', data: { kind: 'quest', phase, text, ...extra } }], 'quest');
  }

  function narrate(text) {
    applyAndBroadcast([{ op: 'event', name: 'narration', data: { text, done: true, by: 'dm' } }], 'quest');
  }

  /** Grant item rewards to the PC (giveItem is semantic → expand first). */
  function grantItems(items) {
    const pc = findPc(session.entities);
    if (!pc || !Array.isArray(items)) return;
    const pcId = pc[0];
    for (const item of items) {
      const ops = expandOp(session.entities, { op: 'giveItem', id: pcId, item });
      if (ops.length) applyAndBroadcast(ops, 'quest');
      questBanner('reward', `You receive ${item.name || item.id}.`);
    }
  }

  /**
   * Award XP to the PC and apply any resulting level-up.
   * Shared by quest completion and combat victory.
   * @param {number} amount
   * @param {string} reason — short label for the banner
   */
  function awardXp(amount, reason) {
    if (!amount || amount <= 0) return;
    // Party XP: every living PC advances together (shared pool, no bookkeeping).
    const pcs = findPcs(session.entities);
    if (!pcs.length) return;
    questBanner('xp', `+${amount} XP${reason ? ` (${reason})` : ''}.`);
    for (const [pcId, comps] of pcs) {
      if ((comps.status || {}).alive === false) continue;
      const res = applyXp(comps.stats || {}, amount, comps.progression);
      applyAndBroadcast([{ op: 'merge', id: pcId, component: 'stats', value: res.stats }], 'quest');
      applyAndBroadcast([{ op: 'merge', id: pcId, component: 'progression', value: res.progression }], 'quest');
      if (res.leveledUp) {
        const name = ((comps.identity || {}).name) || pcId;
        applyAndBroadcast([{
          op: 'event', name: 'system',
          data: { kind: 'levelup', text: `${name} reaches level ${res.toLevel}!`, level: res.toLevel, id: pcId },
        }], 'quest');
        narrate(`Hard-won experience settles in — ${name} advances to level ${res.toLevel}.`);
      }
    }
  }

  /**
   * Re-evaluate active quests against current state. Advances/completes any whose
   * current-step trigger is satisfied, looping until stable (a quest may clear
   * several already-satisfied steps at once). Grants rewards on completion.
   */
  async function evaluate() {
    let guard = 0;
    while (guard++ < MAX_ADVANCE_GUARD) {
      const advances = pendingAdvances(session.entities);
      if (!advances.length) break;

      for (const adv of advances) {
        const comps = session.entities.get(adv.questId);
        const quest = comps && comps.quest;
        if (!quest) continue;
        const name = nameOf(adv.questId);

        if (adv.completes) {
          applyAndBroadcast([{ op: 'merge', id: adv.questId, component: 'quest', value: { phase: 'completed' } }], 'quest');
          questBanner('complete', `Quest complete: ${name}.`, { questId: adv.questId });
          narrate(`"${name}" is done — that thread of the story closes.`);
          const rewards = adv.rewards || {};
          if (rewards.items && rewards.items.length) grantItems(rewards.items);
          if (rewards.xp) awardXp(rewards.xp, `quest: ${name}`);
          if (Array.isArray(quest.onComplete) && quest.onComplete.length) {
            applyAndBroadcast(quest.onComplete, 'quest');
          }
        } else {
          applyAndBroadcast([{ op: 'merge', id: adv.questId, component: 'quest', value: { currentStep: adv.toStep } }], 'quest');
          const stepText = (quest.steps || [])[adv.toStep] || '';
          questBanner('advance', `Quest updated — ${name}: ${stepText}`, { questId: adv.questId, step: adv.toStep });
        }
      }
    }
  }

  return { evaluate, awardXp };
}
