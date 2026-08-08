/**
 * server/music.js — mood-driven music cues (server side only).
 *
 * Server owns mood → track resolution; the client just plays whatever cue it
 * receives (see docs on the {"type":"music",...} event contract). Dependency-free,
 * disk-backed: drop mood-prefixed audio files in tracksDir and the engine finds
 * them by filename convention, e.g. "eerie-crypt.mp3" for mood "eerie".
 */

import fs from 'node:fs';
import path from 'node:path';

const TRACK_EXT_RE = '(?:mp3|ogg|wav)';

/** Escape a string for safe embedding inside a RegExp source. */
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @param {object} [opts]
 * @param {string} [opts.tracksDir] — directory to search for track files (default: env TTRPG_MUSIC_DIR, else 'assets/music').
 * @param {string} [opts.defaultMood] — mood used when a scene names none (default: 'ambient').
 * @param {Record<string,string>} [opts.moodMap] — optional mood alias → track-search-prefix remap
 *   (e.g. {spooky: 'eerie'}), so a scene's reported mood can differ from the audio file naming
 *   convention without touching the broadcast event's `mood` field.
 * @returns {{tracksDir:string, defaultMood:string, cueForScene: (scene:object) => {type:'music', mood:string, track:string|null}}}
 */
export function createMusicEngine(opts = {}) {
  const tracksDir = path.resolve(opts.tracksDir || process.env.TTRPG_MUSIC_DIR || 'assets/music');
  const defaultMood = opts.defaultMood || 'ambient';
  const moodMap = opts.moodMap || {};

  /** First file in tracksDir whose name starts with `mood` and has an audio extension. Never throws. */
  function trackFor(mood) {
    let files;
    try {
      files = fs.readdirSync(tracksDir);
    } catch {
      return null; // tracksDir missing (or unreadable) — no track, not an error
    }
    const re = new RegExp(`^${escapeRegExp(mood)}.*\\.${TRACK_EXT_RE}$`, 'i');
    return files.filter(f => re.test(f)).sort()[0] || null;
  }

  /**
   * The music cue for a scene: {type:'music', mood, track}.
   * mood = scene.mood || scene.tags?.mood || defaultMood (broadcast verbatim, unmapped).
   * track = first matching file for moodMap[mood] || mood, or null if none/tracksDir missing.
   * @param {object} [scene] — {mood?, tags?:{mood?}}
   */
  function cueForScene(scene = {}) {
    const mood = (scene && scene.mood) || (scene && scene.tags && scene.tags.mood) || defaultMood;
    const track = trackFor(moodMap[mood] || mood);
    return { type: 'music', mood, track };
  }

  return { tracksDir, defaultMood, moodMap, cueForScene };
}
