/**
 * shared/parse.js — lenient model-output JSON extractor.
 *
 * Tries strict JSON.parse, strips ```json fences, extracts first balanced {…}.
 * Returns the FULL parsed object untouched — no shape or op filtering here.
 * Shape validation belongs to the caller's (permissive) Zod schema; op
 * validation happens at the point of application, where a single bad op is
 * skipped instead of nuking the whole ruling.
 *
 * PURE — no imports from server/ or client/.
 */

/**
 * Extract a JSON object from raw model output.
 * Never throws — always returns {ok, value?, error?, raw}.
 *
 * @param {string} raw — the raw text from the LLM
 * @returns {{ok:boolean, value?:object, error?:string, raw:string}}
 */
export function parseModelOutput(raw) {
  const trimmed = (raw || '').trim();
  if (!trimmed) {
    return { ok: false, error: 'Empty model output', raw: '' };
  }

  let parsed;

  // 1. Try strict JSON.parse
  try {
    parsed = JSON.parse(trimmed);
  } catch (_) {
    // 2. Strip ```json fences
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenceMatch) {
      try {
        parsed = JSON.parse(fenceMatch[1].trim());
      } catch (_2) {
        // continue to balanced extract
      }
    }

    // 3. Extract first balanced {…} object
    if (!parsed) {
      const objStart = trimmed.indexOf('{');
      if (objStart !== -1) {
        let depth = 0;
        let inString = false;
        let escape = false;
        for (let i = objStart; i < trimmed.length; i++) {
          const ch = trimmed[i];
          if (escape) { escape = false; continue; }
          if (ch === '\\') { escape = true; continue; }
          if (ch === '"') { inString = !inString; continue; }
          if (inString) continue;
          if (ch === '{') depth++;
          else if (ch === '}') {
            depth--;
            if (depth === 0) {
              const candidate = trimmed.slice(objStart, i + 1);
              try {
                parsed = JSON.parse(candidate);
              } catch (_3) {
                // last resort failed
              }
              break;
            }
          }
        }
      }
    }
  }

  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'Model output not parseable as JSON', raw: trimmed };
  }

  return { ok: true, value: parsed, raw: trimmed };
}
