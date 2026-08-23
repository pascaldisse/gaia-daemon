/** Resume epochs (RC6) — the identity of ONE `gaia resume` contract.
 *
 * RC5 keyed a resume's durable record on `new Date().toISOString()`. Two
 * resumes stamped inside the same millisecond collide, and a colliding token
 * lets a finishing watcher close a DIFFERENT, still-running resume — the exact
 * strand (parent never notified, boot sweep skips a "delivered" record) RC5
 * existed to remove. An epoch therefore carries a per-room monotonic sequence
 * on top of the clock:
 *
 *     <ISO-8601>#<seq>        e.g. 2026-03-03T03:03:03.000Z#7
 *
 * The clock half keeps records human-readable and orders across daemon
 * restarts; the seq half makes tokens unique and ordered WITHIN a millisecond.
 * A pre-RC6 record holds a bare ISO string — still a valid token (seq 0), so
 * old on-disk state stays closable by exact match.
 *
 * The registry is in-process, per-room, and authoritative only for MINTING.
 * Truth about which epoch is live lives on disk (SummonDelivery.resumeStartedAt)
 * — hence `observe`: every token read off disk lifts the counter so a rebooted
 * daemon can never mint a token that already exists in a room's state. */

export const RESUME_EPOCH_SEQ_SEP = "#";

export type ResumeEpoch = string;

/** Split a token into its clock and sequence halves. A legacy bare-ISO token
 * (or any unparsable suffix) reads as sequence 0. */
export function parseResumeEpoch(token: ResumeEpoch): { iso: string; seq: number } {
  const at = token.lastIndexOf(RESUME_EPOCH_SEQ_SEP);
  if (at < 0) return { iso: token, seq: 0 };
  const seq = Number.parseInt(token.slice(at + 1), 10);
  if (!Number.isSafeInteger(seq) || seq < 0) return { iso: token, seq: 0 };
  return { iso: token.slice(0, at), seq };
}

/** Total order over epochs of ONE room: clock first, sequence as tiebreak.
 * Negative when `a` is older than `b`, 0 only for identical epochs. */
export function compareResumeEpoch(a: ResumeEpoch, b: ResumeEpoch): number {
  const left = parseResumeEpoch(a);
  const right = parseResumeEpoch(b);
  if (left.iso !== right.iso) return left.iso < right.iso ? -1 : 1;
  return left.seq - right.seq;
}

export class ResumeEpochRegistry {
  /** roomId -> highest sequence this process has minted or seen on disk. */
  private readonly seq = new Map<string, number>();

  /** A fresh epoch for `roomId`, strictly greater than every epoch this
   * registry has minted or observed for that room. */
  mint(roomId: string): ResumeEpoch {
    const next = (this.seq.get(roomId) ?? 0) + 1;
    this.seq.set(roomId, next);
    return `${new Date().toISOString()}${RESUME_EPOCH_SEQ_SEP}${next}`;
  }

  /** Record a token that came from disk (boot recovery, a concurrent daemon's
   * stamp) so the next mint for that room cannot reuse its sequence. */
  observe(roomId: string, token: ResumeEpoch | undefined): void {
    if (!token) return;
    const { seq } = parseResumeEpoch(token);
    if (seq > (this.seq.get(roomId) ?? 0)) this.seq.set(roomId, seq);
  }

  /** Drop a room's counter — only safe once the room itself is gone (its disk
   * state, and therefore every token that could still arrive, is deleted). */
  forget(roomId: string): void {
    this.seq.delete(roomId);
  }
}
