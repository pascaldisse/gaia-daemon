/**
 * client/kernel/suggestions.js — deterministic, local action prompts.
 *
 * Derives concise next actions only from the client SessionStore mirror.
 */

/**
 * Return up to six useful actions for the party's current location.
 * @param {object} store — SessionStore instance
 * @returns {string[]}
 */
export function deriveSuggestions(store) {
  const entities = store && store.entities;
  if (!entities) return [];

  const encounter = entities.get('encounter');
  if (encounter && encounter.encounter && encounter.encounter.active) return [];

  let locationId = null;
  for (const [, comps] of entities) {
    if ((comps.identity || {}).kind === 'pc' && (comps.place || {}).locationId) {
      locationId = comps.place.locationId;
      break;
    }
  }
  if (!locationId) return [];

  const suggestions = [];
  const add = (text) => {
    if (text && !suggestions.includes(text) && suggestions.length < 6) suggestions.push(text);
  };
  const isHere = (comps) => (comps.place || {}).locationId === locationId
    && (comps.status || {}).alive !== false;

  // Threats precede conversation, then routes, then the current quest prompt.
  for (const [, comps] of entities) {
    if (!isHere(comps) || !(comps.flags || {}).hostile) continue;
    const name = (comps.identity || {}).name;
    if (name) add(`attack ${name}`);
  }
  for (const [, comps] of entities) {
    if (!isHere(comps) || (comps.identity || {}).kind !== 'npc' || (comps.flags || {}).hostile) continue;
    const name = (comps.identity || {}).name;
    if (name) add(`talk to ${name}`);
  }

  const place = entities.get(locationId);
  for (const connection of ((place && place.place) || {}).connections || []) {
    const label = connection.label || connection.targetId;
    if (label) add(`go ${label}`);
  }

  for (const [, comps] of entities) {
    const quest = comps.quest;
    if (!quest || quest.phase === 'available' || quest.phase === 'completed') continue;
    const step = (quest.steps || [])[quest.currentStep ?? 0];
    const prompt = typeof step === 'string' ? step : (step && (step.hint || step.description));
    if (prompt) add(prompt);
    if (suggestions.length >= 6) break;
  }

  return suggestions;
}
