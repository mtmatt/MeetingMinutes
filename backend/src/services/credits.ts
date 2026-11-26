import { db, now } from "../db";
import { httpError } from "../lib/util";
import type { UserRow } from "../types";
import { billingSettings, type Rates } from "./billingSettings";

/**
 * Prepaid points. A prepaid account's balance (users.credits, in thousandths of
 * a point) pays for two things, at the rates an administrator sets:
 *
 * - transcription, by the minute of recording;
 * - summaries, by the tokens the model read (the transcript and instructions)
 *   and wrote.
 *
 * Every change is a row in credit_ledger with the balance after it.
 *
 * Before work is queued its cost is estimated and set aside (jobs.hold,
 * summaries.hold), so several recordings or summaries at once cannot spend the
 * same points; a person without enough is refused (402) before anything is
 * uploaded or sent to a model. The worker is told the most audio the balance
 * pays for and stops before recognising speech if the recording is longer.
 * Only finished work is charged, by what it really used: a recording's length,
 * a summary's tokens. Failed or canceled work costs nothing.
 *
 * Accounts that are 'exempt' (invited ones, and every account from before
 * billing) are never checked or charged. A rate of 0 makes that kind of work free.
 */

/** Thousandths of a point per point. */
export const MILLI = 1000;

export class CreditsError extends Error {
  constructor(
    readonly available: number,
    readonly needed: number,
  ) {
    super("Not enough points.");
  }
}

export function rates(): Rates {
  return billingSettings().rates;
}

/** Thousandths of a point for `seconds` of recording (at least 1 when it is charged at all). */
export function transcriptionCost(seconds: number, r: Rates = rates()): number {
  if (r.perMinute <= 0) return 0;
  return Math.max(1, Math.ceil((seconds / 60) * r.perMinute * MILLI - 1e-6));
}

/** Thousandths of a point for a summary's tokens (rates are per thousand tokens, so this is tokens × rate). */
export function summaryCost(inputTokens: number, outputTokens: number, r: Rates = rates()): number {
  return Math.max(0, Math.ceil(inputTokens * r.perKInput + outputTokens * r.perKOutput - 1e-6));
}

/** Points set aside by this person's queued and running work (except `exceptMeeting`'s transcription). */
export function heldCredits(userId: string, exceptMeeting?: string): number {
  const jobs =
    db
      .query<{ n: number | null }, { u: string; m: string }>(
        `SELECT SUM(j.hold) AS n FROM jobs j JOIN meetings m ON m.id = j.meeting_id
         WHERE m.owner_id = $u AND j.kind = 'transcribe' AND j.status IN ('queued', 'running') AND j.hold IS NOT NULL AND m.id != $m`,
      )
      .get({ u: userId, m: exceptMeeting ?? "" })?.n ?? 0;
  const summaries =
    db
      .query<{ n: number | null }, { u: string }>("SELECT SUM(hold) AS n FROM summaries WHERE created_by = $u AND status IN ('queued', 'running') AND hold IS NOT NULL")
      .get({ u: userId })?.n ?? 0;
  return jobs + summaries;
}

export function balanceOf(userId: string): number {
  return db.query<{ credits: number }, { id: string }>("SELECT credits FROM users WHERE id = $id").get({ id: userId })?.credits ?? 0;
}

/** What a prepaid person can still spend: the balance less what queued work has set aside. */
export function availableCredits(userId: string, exceptMeeting?: string): number {
  return Math.max(0, balanceOf(userId) - heldCredits(userId, exceptMeeting));
}

function insufficient(e: CreditsError, what: "transcription" | "summary"): never {
  const points = (n: number) => (n / MILLI).toFixed(1);
  httpError(
    402,
    what === "transcription"
      ? `Not enough points: this recording needs about ${points(e.needed)}, ${points(e.available)} left.`
      : `Not enough points: this summary needs about ${points(e.needed)}, ${points(e.available)} left.`,
    "insufficient_credits",
    { availableCredits: e.available, neededCredits: e.needed, what },
  );
}

/**
 * What to set aside for transcribing a recording of about `declaredSec` (null:
 * the browser could not tell), or null when nothing is (an exempt account, or
 * free transcription). Throws CreditsError when the balance cannot pay for it.
 */
export function transcriptionHold(user: UserRow, declaredSec: number | null, exceptMeeting?: string): number | null {
  if (user.billing !== "prepaid") return null;
  const r = rates();
  if (r.perMinute <= 0) return null;
  const available = availableCredits(user.id, exceptMeeting);
  const known = declaredSec != null && declaredSec > 0;
  const needed = known ? transcriptionCost(declaredSec, r) : transcriptionCost(1, r);
  if (available < needed) throw new CreditsError(available, needed);
  // Unknown length: everything is set aside (the worker learns the real length; the rest comes back when it is done).
  return known ? needed : available;
}

/** The same, as a 402 answer with the numbers the page shows. */
export function requireTranscriptionCredits(user: UserRow, declaredSec: number | null, exceptMeeting?: string): number | null {
  try {
    return transcriptionHold(user, declaredSec, exceptMeeting);
  } catch (e) {
    if (e instanceof CreditsError) insufficient(e, "transcription");
    throw e;
  }
}

/**
 * What a summary is likely to cost: the transcript and instructions as the
 * model reads them (with room for a long transcript read in parts), and a long
 * answer. The real tokens are charged when it is done.
 */
export function summaryEstimate(estimatedInputTokens: number, r: Rates = rates()): number {
  const input = Math.ceil(estimatedInputTokens * 1.25) + 1500;
  return summaryCost(input, 4000, r);
}

/** What to set aside for a summary, or null when nothing is; throws CreditsError when it cannot be paid for. */
export function summaryHold(user: UserRow, estimatedInputTokens: number): number | null {
  if (user.billing !== "prepaid") return null;
  const r = rates();
  if (r.perKInput <= 0 && r.perKOutput <= 0) return null;
  const needed = summaryEstimate(estimatedInputTokens, r);
  const available = availableCredits(user.id);
  if (available < needed) throw new CreditsError(available, needed);
  return needed;
}

export function requireSummaryCredits(user: UserRow, estimatedInputTokens: number): number | null {
  try {
    return summaryHold(user, estimatedInputTokens);
  } catch (e) {
    if (e instanceof CreditsError) insufficient(e, "summary");
    throw e;
  }
}

export interface LedgerEntry {
  id: number;
  user_id: string;
  delta: number;
  balance: number;
  kind: "purchase" | "transcription" | "summary" | "adjust";
  meeting_id: string | null;
  title: string | null;
  quantity: string | null;
  order_id: string | null;
  note: string | null;
  created_by: string | null;
  created_at: number;
}

/**
 * Change a balance (thousandths of a point) and record why. Must run inside the
 * caller's transaction when it goes with other changes (a paid order, finished
 * work). A balance can go below zero only when work used more than was set
 * aside (an old worker ignoring its limit, a summary longer than estimated).
 */
export function addCredits(
  userId: string,
  delta: number,
  entry: {
    kind: LedgerEntry["kind"];
    meetingId?: string | null;
    title?: string | null;
    quantity?: Record<string, number> | null;
    orderId?: string | null;
    note?: string | null;
    createdBy?: string | null;
  },
): number {
  const d = Math.round(delta);
  const row = db
    .query<{ credits: number }, { id: string; d: number; t: number }>("UPDATE users SET credits = credits + $d, updated_at = $t WHERE id = $id RETURNING credits")
    .get({ id: userId, d, t: now() });
  if (!row) throw new Error("No such user.");
  db.query(
    `INSERT INTO credit_ledger (user_id, delta, balance, kind, meeting_id, title, quantity, order_id, note, created_by, created_at)
     VALUES ($u, $d, $b, $k, $m, $title, $q, $o, $note, $by, $t)`,
  ).run({
    u: userId,
    d,
    b: row.credits,
    k: entry.kind,
    m: entry.meetingId ?? null,
    title: entry.title ?? null,
    q: entry.quantity ? JSON.stringify(entry.quantity) : null,
    o: entry.orderId ?? null,
    note: entry.note ?? null,
    by: entry.createdBy ?? null,
    t: now(),
  });
  return row.credits;
}

export function ledger(userId: string, limit = 50): LedgerEntry[] {
  return db.query<LedgerEntry, { u: string; n: number }>("SELECT * FROM credit_ledger WHERE user_id = $u ORDER BY id DESC LIMIT $n").all({ u: userId, n: limit });
}

export function publicLedgerEntry(e: LedgerEntry) {
  return {
    id: e.id,
    delta: e.delta,
    balance: e.balance,
    kind: e.kind,
    meetingId: e.meeting_id,
    title: e.title,
    quantity: e.quantity ? (JSON.parse(e.quantity) as Record<string, number>) : null,
    orderId: e.order_id,
    note: e.note,
    createdAt: e.created_at,
  };
}

/** Whether the owner of a meeting pays (a prepaid account). */
function prepaid(userId: string): boolean {
  return db.query<{ billing: string }, { id: string }>("SELECT billing FROM users WHERE id = $id").get({ id: userId })?.billing === "prepaid";
}

/**
 * The most audio (seconds) the worker may transcribe for this job: what the
 * owner can spend, counting this job's own hold. Null: no limit.
 */
export function jobCreditLimit(ownerId: string, meetingId: string, hold: number | null): number | null {
  if (hold == null || !prepaid(ownerId)) return null;
  const r = rates();
  if (r.perMinute <= 0) return null;
  return Math.floor((availableCredits(ownerId, meetingId) / (r.perMinute * MILLI)) * 60);
}

/** A finished transcription, charged by its real length (in the completing transaction). */
export function chargeTranscription(ownerId: string, meeting: { id: string; title: string }, durationSec: number): number | null {
  if (!prepaid(ownerId)) return null;
  const cost = transcriptionCost(durationSec);
  if (cost <= 0) return null;
  addCredits(ownerId, -cost, { kind: "transcription", meetingId: meeting.id, title: meeting.title, quantity: { sec: Math.round(durationSec) } });
  return cost;
}

/** A finished summary, charged by the tokens the model reported (in the completing transaction). */
export function chargeSummary(userId: string, meeting: { id: string; title: string }, inputTokens: number, outputTokens: number): number | null {
  if (!prepaid(userId)) return null;
  const cost = summaryCost(inputTokens, outputTokens);
  if (cost <= 0) return null;
  addCredits(userId, -cost, { kind: "summary", meetingId: meeting.id, title: meeting.title, quantity: { input: inputTokens, output: outputTokens } });
  return cost;
}
