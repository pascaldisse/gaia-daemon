/**
 * server/voice.js — TTS narration engine: provider seam + {bytes,mime,ext} contract.
 *
 * EXTENSION SEAM: mirrors server/art.js — add providers by implementing
 * generate(text) → {bytes, mime, ext} and adding a branch in createVoiceEngine().
 * PURE: no disk cache, no session/broadcast/IO beyond the outbound HTTP call
 * itself. Wiring (who calls speak() and what happens with the audio) lands
 * next wave.
 *
 * Providers:
 *  - 'none'       (default) — silent no-op, resolves null.
 *  - 'elevenlabs' — ElevenLabs text-to-speech when ELEVENLABS_API_KEY is set.
 */

/**
 * @param {object} [opts]
 * @param {string} [opts.provider] — 'none' | 'elevenlabs' (default: env TTRPG_TTS_PROVIDER, else 'none')
 * @param {string} [opts.apiKey] — ElevenLabs API key (default: env ELEVENLABS_API_KEY)
 * @param {string} [opts.voiceId] — ElevenLabs voice id (default: env TTRPG_TTS_VOICE, else a stock voice)
 * @param {string} [opts.modelId] — ElevenLabs model id (default: env TTRPG_TTS_MODEL, else 'eleven_multilingual_v2')
 * @param {string} [opts.baseUrl] — ElevenLabs API base (default: env TTRPG_TTS_BASE, else the public API)
 * @param {typeof fetch} [opts.fetchImpl] — fetch implementation (default: global fetch; tests inject a stub)
 * @returns {{speak: (text: string) => Promise<{bytes: Buffer, mime: string, ext: string}|null>}}
 */
export function createVoiceEngine(opts = {}) {
  const {
    provider = process.env.TTRPG_TTS_PROVIDER || 'none',
    apiKey = process.env.ELEVENLABS_API_KEY,
    voiceId = process.env.TTRPG_TTS_VOICE || 'JBFqnCBsd6RMkjVDRZzb',
    modelId = process.env.TTRPG_TTS_MODEL || 'eleven_multilingual_v2',
    baseUrl = process.env.TTRPG_TTS_BASE || 'https://api.elevenlabs.io',
    fetchImpl = fetch,
  } = opts;

  let warnedMissingKey = false; // don't spam the log — every speak() would otherwise repeat this

  async function speakNone() {
    return null;
  }

  async function speakElevenlabs(text) {
    if (!apiKey) {
      if (!warnedMissingKey) {
        console.warn('[voice] elevenlabs provider selected but ELEVENLABS_API_KEY is not set — narration disabled');
        warnedMissingKey = true;
      }
      return null;
    }

    const res = await fetchImpl(`${baseUrl}/v1/text-to-speech/${voiceId}`, {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
        'Content-Type': 'application/json',
        accept: 'audio/mpeg',
      },
      body: JSON.stringify({ text, model_id: modelId }),
    });

    if (!res.ok) {
      const bodySnippet = (await res.text().catch(() => '')).slice(0, 200);
      throw new Error(`[voice] elevenlabs HTTP ${res.status}: ${bodySnippet}`);
    }

    const bytes = Buffer.from(await res.arrayBuffer());
    return { bytes, mime: 'audio/mpeg', ext: 'mp3' };
  }

  const speakers = { none: speakNone, elevenlabs: speakElevenlabs };

  /**
   * Narrate `text` through the configured provider.
   * @param {string} text
   * @returns {Promise<{bytes: Buffer, mime: string, ext: string}|null>} null on any
   *   silent/disabled path (provider 'none', unknown provider, missing key);
   *   throws only on a non-2xx response from a reachable provider.
   */
  async function speak(text) {
    const impl = speakers[provider];
    if (!impl) {
      console.warn(`[voice] unknown TTS provider "${provider}" — narration disabled`);
      return null;
    }
    return impl(text);
  }

  return { speak };
}
