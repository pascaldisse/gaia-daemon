/**
 * client/kernel/musicplayer.js — WS-driven track-based music player.
 *
 * Handles server pushes of {type:'music', mood, track}: when `track` is
 * non-null, loops <audio src="<serverBase>/music/"+track>. Distinct from the
 * procedural ambient engine (kernel/music.js) — this plays an authored audio
 * file a DM/addon cues explicitly over the websocket; both can run side by
 * side (this player owns its own toolbar controls).
 *
 * Autoplay policy: browsers block audio playback before a user gesture. A
 * cue that arrives first is queued; the first pointerdown/keydown anywhere
 * on the page unlocks playback and immediately plays the queued cue.
 */

export class TrackMusicPlayer {
  /**
   * @param {{volumeSlider?:HTMLInputElement, muteButton?:HTMLElement, serverBase?:string}} opts
   */
  constructor({ volumeSlider, muteButton, serverBase = '' } = {}) {
    this.serverBase = serverBase;
    this.volumeSlider = volumeSlider || null;
    this.muteButton = muteButton || null;

    this.audio = document.createElement('audio');
    this.audio.loop = true;
    this.audio.preload = 'auto';

    this._muted = false;
    try { this._muted = localStorage.getItem('ttrpg_track_muted') === 'on'; } catch { /* storage unavailable */ }

    let volume = 0.6;
    try {
      const saved = parseFloat(localStorage.getItem('ttrpg_track_volume'));
      if (Number.isFinite(saved)) volume = Math.max(0, Math.min(1, saved));
    } catch { /* storage unavailable */ }

    this.audio.volume = volume;
    this.audio.muted = this._muted;

    this._unlocked = false;
    this._pendingTrack = null; // queued track filename awaiting the first gesture

    this._wireControls();
    this._wireUnlock();
  }

  _wireControls() {
    if (this.volumeSlider) {
      this.volumeSlider.value = String(this.audio.volume);
      this.volumeSlider.addEventListener('input', () => {
        const v = parseFloat(this.volumeSlider.value);
        if (Number.isFinite(v)) this.audio.volume = Math.max(0, Math.min(1, v));
        try { localStorage.setItem('ttrpg_track_volume', String(this.audio.volume)); } catch { /* ok */ }
      });
    }
    if (this.muteButton) {
      this._paintMute();
      this.muteButton.addEventListener('click', () => {
        this._muted = !this._muted;
        this.audio.muted = this._muted;
        try { localStorage.setItem('ttrpg_track_muted', this._muted ? 'on' : 'off'); } catch { /* ok */ }
        this._paintMute();
      });
    }
  }

  _paintMute() {
    if (!this.muteButton) return;
    this.muteButton.textContent = this._muted ? '🔇' : '🔊';
    this.muteButton.title = this._muted ? 'Unmute track' : 'Mute track';
  }

  /** First gesture anywhere unlocks playback and flushes any queued cue. */
  _wireUnlock() {
    const unlock = () => {
      if (this._unlocked) return;
      this._unlocked = true;
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      if (this._pendingTrack != null) {
        const track = this._pendingTrack;
        this._pendingTrack = null;
        this._play(track);
      }
    };
    window.addEventListener('pointerdown', unlock, { once: true });
    window.addEventListener('keydown', unlock, { once: true });
  }

  /**
   * Handle a raw server WS message. No-op for anything but {type:'music'}.
   * @param {object} msg
   */
  handleServerMessage(msg) {
    if (!msg || msg.type !== 'music') return;
    if (msg.track == null) {
      this._pendingTrack = null;
      this.audio.pause();
      this.audio.removeAttribute('src');
      return;
    }
    if (!this._unlocked) {
      this._pendingTrack = msg.track; // queued until the first gesture
      return;
    }
    this._play(msg.track);
  }

  _play(track) {
    const src = `${this.serverBase}/music/${track}`;
    if (this.audio.src !== src) this.audio.src = src;
    this.audio.play().catch(() => {
      // Still blocked (or the file 404s) — try again on the next gesture.
      this._pendingTrack = track;
      this._unlocked = false;
      this._wireUnlock();
    });
  }
}
