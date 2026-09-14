const LOCK_NAME = "gaia-auto-tts";
const LEASE_KEY = "gaia-auto-tts-owner";
const DEFAULT_LEASE_TIMINGS = Object.freeze({
  leaseMs: 6_000,
  heartbeatMs: 2_000,
  arbitrationMs: 40,
});

/** @typedef {{ owner: string, expiresAt: number }} Lease */
/** @typedef {{ leaseMs?: number, heartbeatMs?: number, arbitrationMs?: number }} LeaseTimings */
/** @typedef {{ request(name: string, options: { ifAvailable: boolean }, callback: (lock: object|null) => Promise<void>): Promise<unknown> }} LockManagerLike */
/**
 * @typedef {object} AutoTtsOwnerOptions
 * @property {{ locks?: LockManagerLike }|null} [navigator]
 * @property {Storage|null} [storage]
 * @property {{ addEventListener(type: string, listener: (event: Event) => void): void, removeEventListener(type: string, listener: (event: Event) => void): void }|null} [eventTarget]
 * @property {() => number} [now]
 * @property {() => string} [makeId]
 * @property {(callback: () => void, milliseconds: number) => ReturnType<typeof setInterval>} [setInterval]
 * @property {(timer: ReturnType<typeof setInterval>) => void} [clearInterval]
 * @property {(callback: () => void, milliseconds: number) => ReturnType<typeof setTimeout>} [setTimeout]
 * @property {LeaseTimings} [timings]
 * @property {() => void} [onLost]
 */

/**
 * Cross-tab exclusive ownership for automatic TTS playback.
 * Web Locks → strict browser arbitration. Storage fallback → lease + verify + heartbeat;
 * localStorage lacks atomic compare-and-set, so simultaneous contenders cannot receive
 * the absolute exclusion guarantee supplied by Web Locks.
 */
export class AutoTtsOwner {
  /** @param {AutoTtsOwnerOptions} [options] */
  constructor(options = {}) {
    const root = globalThis;
    this._navigator = options.navigator === undefined ? root.navigator : options.navigator;
    this._storage = options.storage === undefined ? readDefaultStorage(root) : options.storage;
    this._eventTarget = options.eventTarget === undefined ? defaultEventTarget(root) : options.eventTarget;
    this._now = options.now ?? (() => Date.now());
    this._makeId = options.makeId ?? (() => globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`);
    this._setInterval = options.setInterval ?? ((callback, milliseconds) => setInterval(callback, milliseconds));
    this._clearInterval = options.clearInterval ?? ((timer) => clearInterval(timer));
    this._setTimeout = options.setTimeout ?? ((callback, milliseconds) => setTimeout(callback, milliseconds));
    this._timings = { ...DEFAULT_LEASE_TIMINGS, ...options.timings };
    this._onLost = options.onLost ?? (() => {});
    this._id = this._makeId();
    this._mode = /** @type {"locks"|"lease"|null} */ (null);
    this._owned = false;
    this._disposed = false;
    this._lostNotified = false;
    /** @type {Promise<boolean>|null} */
    this._acquiring = null;
    /** @type {(() => void)|null} */
    this._releaseLock = null;
    /** @type {ReturnType<typeof setInterval>|null} */
    this._heartbeat = null;
    this._storageListener = /** @param {Event} event */ (event) => {
      const storageEvent = /** @type {StorageEvent} */ (event);
      if (storageEvent.key === LEASE_KEY || storageEvent.key === null) this._validateLease();
    };
  }

  /** Ownership result arrives when arbitration finishes; lock release is not awaited. @returns {Promise<boolean>} */
  acquire() {
    if (this._disposed) return Promise.resolve(false);
    if (this.owns()) return Promise.resolve(true);
    if (this._acquiring) return this._acquiring;

    const locks = this._navigator?.locks;
    this._mode = locks && typeof locks.request === "function" ? "locks" : "lease";
    const attempt = this._mode === "locks"
      ? this._acquireLock(/** @type {LockManagerLike} */ (locks))
      : this._acquireLease();
    const acquiring = attempt.finally(() => {
      if (this._acquiring === acquiring) this._acquiring = null;
    });
    this._acquiring = acquiring;
    return acquiring;
  }

  /** Revalidates fallback state on every call. @returns {boolean} */
  owns() {
    if (this._disposed || !this._owned) return false;
    return this._mode === "lease" ? this._validateLease() : true;
  }

  /** Release ownership + stop arbitration machinery. */
  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    const release = this._releaseLock;
    this._releaseLock = null;
    release?.();
    this._stopLeaseWatch();
    if (this._mode === "lease" && this._owned) this._removeOwnLease();
    this._owned = false;
  }

  /** @param {LockManagerLike} locks @returns {Promise<boolean>} */
  _acquireLock(locks) {
    return new Promise((resolve) => {
      let decided = false;
      /** @param {boolean} value */
      const decide = (value) => {
        if (decided) return;
        decided = true;
        resolve(value);
      };
      try {
        const request = locks.request(LOCK_NAME, { ifAvailable: true }, async (lock) => {
          if (!lock || this._disposed) {
            decide(false);
            return;
          }
          this._owned = true;
          decide(true);
          await new Promise((release) => { this._releaseLock = () => release(undefined); });
          this._releaseLock = null;
          this._owned = false;
        });
        Promise.resolve(request).catch(() => decide(false));
      } catch {
        decide(false);
      }
    });
  }

  /** @returns {Promise<boolean>} */
  async _acquireLease() {
    const storage = this._storage;
    if (!storage || this._disposed) return false;
    const now = this._now();
    const current = this._readLease();
    if (current === undefined) return false;
    if (current && current.owner !== this._id && current.expiresAt > now) return false;

    if (!this._writeLease({ owner: this._id, expiresAt: now + this._timings.leaseMs })) return false;
    await new Promise((resolve) => this._setTimeout(() => resolve(undefined), this._timings.arbitrationMs));
    if (this._disposed) {
      this._removeOwnLease();
      return false;
    }
    const won = this._leaseIsOurs();
    if (!won) return false;

    this._owned = true;
    this._lostNotified = false;
    this._eventTarget?.addEventListener("storage", this._storageListener);
    this._heartbeat = this._setInterval(() => this._renewLease(), this._timings.heartbeatMs);
    return true;
  }

  /** @returns {boolean} */
  _validateLease() {
    if (!this._owned) return false;
    if (!this._leaseIsOurs()) {
      this._loseLease();
      return false;
    }
    return true;
  }

  _renewLease() {
    if (!this._owned || this._disposed || !this._leaseIsOurs()) {
      if (this._owned) this._loseLease();
      return;
    }
    if (!this._writeLease({ owner: this._id, expiresAt: this._now() + this._timings.leaseMs }) || !this._leaseIsOurs()) {
      this._loseLease();
    }
  }

  /** @returns {boolean} */
  _leaseIsOurs() {
    const lease = this._readLease();
    return lease !== undefined && lease !== null && lease.owner === this._id && lease.expiresAt > this._now();
  }

  /** @returns {Lease|null|undefined} undefined → storage failure/malformed value */
  _readLease() {
    try {
      const raw = this._storage?.getItem(LEASE_KEY);
      if (raw == null) return null;
      const value = JSON.parse(raw);
      if (!value || typeof value.owner !== "string" || typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt)) return undefined;
      return /** @type {Lease} */ (value);
    } catch {
      return undefined;
    }
  }

  /** @param {Lease} lease @returns {boolean} */
  _writeLease(lease) {
    try {
      this._storage?.setItem(LEASE_KEY, JSON.stringify(lease));
      return this._storage != null;
    } catch {
      return false;
    }
  }

  _removeOwnLease() {
    if (!this._leaseIsOurs()) return;
    try { this._storage?.removeItem(LEASE_KEY); } catch { /* fail closed */ }
  }

  _loseLease() {
    this._owned = false;
    this._stopLeaseWatch();
    if (!this._lostNotified) {
      this._lostNotified = true;
      this._onLost();
    }
  }

  _stopLeaseWatch() {
    if (this._heartbeat !== null) {
      this._clearInterval(this._heartbeat);
      this._heartbeat = null;
    }
    this._eventTarget?.removeEventListener("storage", this._storageListener);
  }
}

/** @param {typeof globalThis} root @returns {Storage|null} */
function readDefaultStorage(root) {
  try { return root.localStorage ?? null; } catch { return null; }
}

/** @param {typeof globalThis} root @returns {AutoTtsOwnerOptions["eventTarget"]} */
function defaultEventTarget(root) {
  return typeof root.addEventListener === "function" ? root : null;
}
