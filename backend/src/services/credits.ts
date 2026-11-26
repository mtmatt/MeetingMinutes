import { db, now } from "../db";
import { httpError } from "../lib/util";
import type { UserRow } from "../types";

/**
 * Prepaid minutes. A prepaid account's balance (users.credit_sec) pays for
 * transcription by the second of recording; every change is a row in
 * credit_ledger with the balance after it.
 *
 * - Adding a recording checks the balance against the length the browser read
 *   from the file, before anything is uploaded.
 * - Queueing a transcription sets that length aside (jobs.hold_sec), so several
 *   recordings at once cannot spend the same minutes.
 * - The worker is told the most audio the balance pays for, and stops before
 *   recognising speech if the recording is longer (the file's own length can
 *   differ from what the browser read).
 * - Only a finished transcription is charged, by its real length. A failed or
 *   canceled one costs nothing. Transcribing again is charged again: it runs again.
 *
 * Accounts that are 'exempt' (invited ones, and every account from before
 * billing) are never checked or charged.
 */

export class CreditsError extends Error {}

/** Seconds set aside by this person's queued and running transcriptions (except `exceptMeeting`'s). */
export function heldSec(userId: string, exceptMeeting?: string): number {
  return (
    db
      .query<{ n: number | null }, { u: string; m: string }>(
        `SELECT SUM(j.hold_sec) AS n FROM jobs j JOIN meetings m ON m.id = j.meeting_id
         WHERE m.owner_id = $u AND j.kind = 'transcribe' AND j.status IN ('queued', 'running') AND j.hold_sec IS NOT NULL AND m.id != $m`,
      )
      .get({ u: userId, m: exceptMeeting ?? "" })?.n ?? 0
  );
}

export function balanceOf(userId: string): number {
  return db.query<{ credit_sec: number }, { id: string }>("SELECT credit_sec FROM users WHERE id = $id").get({ id: userId })?.credit_sec ?? 0;
}

/** What a prepaid person can still spend: the balance less what queued work has set aside. */
export function availableSec(userId: string, exceptMeeting?: string): number {
  return Math.max(0, balanceOf(userId) - heldSec(userId, exceptMeeting));
}

/** Whole seconds, rounded up: what a recording of `seconds` costs. */
export function costOf(seconds: number): number {
  return Math.max(1, Math.ceil(seconds - 1e-6));
}

/**
 * Refuse (402) when a prepaid person cannot pay for a recording of about
 * `declaredSec` (unknown: when nothing is left at all). Returns the seconds to
 * set aside for it, or null for an exempt account.
 */
export function assertCanAfford(user: UserRow, declaredSec: number | null, exceptMeeting?: string): number | null {
  if (user.billing !== "prepaid") return null;
  const available = availableSec(user.id, exceptMeeting);
  const needed = declaredSec != null && declaredSec > 0 ? costOf(declaredSec) : 1;
  if (available < needed) {
    const err = new CreditsError("Not enough minutes.");
    throw Object.assign(err, { available, needed });
  }
  // Unknown length: set everything aside (the worker learns the real length, and the rest comes back when it is done).
  return declaredSec != null && declaredSec > 0 ? needed : available;
}

/** The same check as an HTTP error, with the numbers the page shows. */
export function requireCredits(user: UserRow, declaredSec: number | null, exceptMeeting?: string): number | null {
  try {
    return assertCanAfford(user, declaredSec, exceptMeeting);
  } catch (e) {
    if (e instanceof CreditsError) {
      const { available, needed } = e as CreditsError & { available: number; needed: number };
      httpError(402, `Not enough minutes: this recording needs about ${Math.ceil(needed / 60)} min, ${Math.floor(available / 60)} min left.`, "insufficient_credits", {
        availableSec: available,
        neededSec: needed,
      });
    }
    throw e;
  }
}

export interface LedgerEntry {
  id: number;
  user_id: string;
  delta_sec: number;
  balance_sec: number;
  kind: "purchase" | "usage" | "adjust";
  meeting_id: string | null;
  title: string | null;
  order_id: string | null;
  note: string | null;
  created_by: string | null;
  created_at: number;
}

/**
 * Change a balance and record why. Must run inside the caller's transaction
 * when it goes with other changes (a paid order, a finished job). A balance can
 * go below zero only when an old worker ignored the limit it was given.
 */
export function addCredits(
  userId: string,
  deltaSec: number,
  entry: { kind: LedgerEntry["kind"]; meetingId?: string | null; title?: string | null; orderId?: string | null; note?: string | null; createdBy?: string | null },
): number {
  const row = db
    .query<{ credit_sec: number }, { id: string; d: number; t: number }>("UPDATE users SET credit_sec = credit_sec + $d, updated_at = $t WHERE id = $id RETURNING credit_sec")
    .get({ id: userId, d: Math.round(deltaSec), t: now() });
  if (!row) throw new CreditsError("No such user.");
  db.query(
    `INSERT INTO credit_ledger (user_id, delta_sec, balance_sec, kind, meeting_id, title, order_id, note, created_by, created_at)
     VALUES ($u, $d, $b, $k, $m, $title, $o, $note, $by, $t)`,
  ).run({
    u: userId,
    d: Math.round(deltaSec),
    b: row.credit_sec,
    k: entry.kind,
    m: entry.meetingId ?? null,
    title: entry.title ?? null,
    o: entry.orderId ?? null,
    note: entry.note ?? null,
    by: entry.createdBy ?? null,
    t: now(),
  });
  return row.credit_sec;
}

export function ledger(userId: string, limit = 50): LedgerEntry[] {
  return db.query<LedgerEntry, { u: string; n: number }>("SELECT * FROM credit_ledger WHERE user_id = $u ORDER BY id DESC LIMIT $n").all({ u: userId, n: limit });
}

export function publicLedgerEntry(e: LedgerEntry) {
  return {
    id: e.id,
    deltaSec: e.delta_sec,
    balanceSec: e.balance_sec,
    kind: e.kind,
    meetingId: e.meeting_id,
    title: e.title,
    orderId: e.order_id,
    note: e.note,
    createdAt: e.created_at,
  };
}

/**
 * The most audio the worker may transcribe for this job: what the owner can
 * spend, counting this job's own hold. Null: no limit (an exempt account).
 */
export function jobCreditLimit(ownerId: string, meetingId: string, holdSec: number | null): number | null {
  if (holdSec == null) return null;
  const owner = db.query<{ billing: string }, { id: string }>("SELECT billing FROM users WHERE id = $id").get({ id: ownerId });
  if (owner?.billing !== "prepaid") return null;
  return availableSec(ownerId, meetingId);
}
