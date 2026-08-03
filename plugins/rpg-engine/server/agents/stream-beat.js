/**
 * server/agents/stream-beat.js — shared streaming helper.
 *
 * Generalized version of P1's narration streaming: streams LLM deltas as live
 * event ops, then commits the final result on completion. Strips stray fenced
 * JSON from the final text.
 *
 * Used by dm-agent and npc-agent.
 */

/**
 * Strip stray fenced ```json``` blocks from text.
 */
function stripFences(text) {
  return String(text || '').replace(/```(?:json)?\s*[\s\S]*?```/gi, '').trim();
}

/**
 * Stream an LLM call, broadcasting live deltas and committing the final result.
 *
 * @param {object} params
 * @param {object} params.llm                    — LlmClient instance
 * @param {Array<{role:string,content:string}>} params.messages
 * @param {string} params.eventName              — e.g. 'narration' or 'dialogue'
 * @param {object} params.baseData               — fields set on every event (by, speaker, name, accent...)
 * @param {(msg:object)=>void} params.broadcast   — server broadcast (live-only)
 * @param {(ops:object[], from:string)=>object} params.applyAndBroadcast — canonical commit
 * @param {string} params.role                   — 'dm' or 'npc' (passed to llm.stream opts for provider branching)
 * @param {number} [params.streamId]
 * @param {number} [params.streamRetries]        — retries on llm.stream() failure; default 1,
 *   falls back to env TTRPG_STREAM_RETRIES
 * @returns {Promise<string>} — the full final text
 */
export async function streamBeat({
  llm,
  messages,
  eventName,
  baseData,
  broadcast,
  applyAndBroadcast,
  role,
  streamId,
  streamRetries,
}) {
  const maxRetries = streamRetries ?? Number(process.env.TTRPG_STREAM_RETRIES ?? 1);

  const runStream = async () => {
    let text = '';
    for await (const { delta } of llm.stream(messages, { role })) {
      text += delta;
      broadcast({
        type: 'ops',
        ops: [{
          op: 'event',
          name: eventName,
          data: { ...baseData, streamId, delta },
        }],
      });
    }
    return text;
  };

  let fullText;
  let retriesLeft = maxRetries;
  while (true) {
    try {
      fullText = await runStream();
      break;
    } catch (e) {
      if (retriesLeft > 0) {
        console.warn(`[stream-beat] llm.stream() failed, retrying (${retriesLeft} left):`, e.message || e);
        retriesLeft--;
        continue;
      }
      throw e;
    }
  }

  // Strip any stray fenced JSON defensively
  fullText = stripFences(fullText);

  // Canonical commit: final done event
  applyAndBroadcast([{
    op: 'event',
    name: eventName,
    data: { ...baseData, streamId, text: fullText, done: true },
  }], baseData.by || 'dm');

  return fullText;
}
