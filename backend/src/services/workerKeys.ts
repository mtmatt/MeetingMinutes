import { db, now } from "../db";
import { newId, sha256 } from "../lib/util";

/**
 * Credentials for workers on other machines (an NVIDIA box, a Mac).
 *
 * Such a machine only ever connects out to this server, over HTTPS, so it needs
 * no open port. An administrator creates an entry and gets a one-time
 * enrollment code; the worker trades it for its own token (`mmw_…`), which is
 * stored here only as a SHA-256 hash and can be revoked on its own. A remote
 * worker may only use worker IDs that start with its key's ID, and may only
 * download the recording of a job it is running. The shared WORKER_TOKEN
 * remains for workers on this machine, which read media from disk.
 */

export const ENROLL_TTL_MS = 60 * 60 * 1000;
const TOUCH_EVERY_MS = 60 * 1000;

export interface WorkerKeyRow {
  id: string;
  name: string;
  token_hash: string | null;
  enroll_hash: string | null;
  enroll_expires_at: number | null;
  created_by: string | null;
  created_at: number;
  enrolled_at: number | null;
  last_used_at: number | null;
  last_ip: string | null;
  revoked_at: number | null;
}

/** IDs are short and safe in worker IDs and URLs: "wk" + 10 lowercase letters or digits. */
function newKeyId(): string {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return "wk" + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** A new entry and its one-time enrollment code (shown once; only its hash is kept). */
export function createWorkerKey(name: string, userId: string): { key: WorkerKeyRow; code: string } {
  const id = newKeyId();
  const code = `mme_${newId(24)}`;
  const t = now();
  db.query(
    `INSERT INTO worker_keys (id, name, enroll_hash, enroll_expires_at, created_by, created_at)
     VALUES ($id, $name, $hash, $exp, $by, $t)`,
  ).run({ id, name, hash: sha256(code), exp: t + ENROLL_TTL_MS, by: userId, t });
  return { key: getWorkerKey(id)!, code };
}

export function getWorkerKey(id: string): WorkerKeyRow | null {
  return db.query<WorkerKeyRow, { id: string }>("SELECT * FROM worker_keys WHERE id = $id").get({ id });
}

/**
 * Trade an enrollment code for a token. Returns null for an unknown, used,
 * expired or revoked code. The code works once.
 */
export function enrollWorker(code: string, ip: string): { id: string; name: string; token: string } | null {
  if (!code.startsWith("mme_")) return null;
  const hash = sha256(code);
  return db.transaction(() => {
    const row = db
      .query<WorkerKeyRow, { h: string }>("SELECT * FROM worker_keys WHERE enroll_hash = $h AND revoked_at IS NULL")
      .get({ h: hash });
    if (!row || (row.enroll_expires_at ?? 0) < now()) return null;
    const token = `mmw_${row.id}.${newId(32)}`;
    const t = now();
    db.query(
      `UPDATE worker_keys SET token_hash = $th, enroll_hash = NULL, enroll_expires_at = NULL, enrolled_at = $t,
         last_used_at = $t, last_ip = $ip WHERE id = $id`,
    ).run({ id: row.id, th: sha256(token), t, ip });
    return { id: row.id, name: row.name, token };
  })();
}

/** The key a remote worker's token belongs to, if it is valid and not revoked. */
export function workerKeyForToken(token: string, ip: string): WorkerKeyRow | null {
  if (!token.startsWith("mmw_")) return null;
  const row = db
    .query<WorkerKeyRow, { h: string }>("SELECT * FROM worker_keys WHERE token_hash = $h AND revoked_at IS NULL")
    .get({ h: sha256(token) });
  if (!row) return null;
  const t = now();
  if (!row.last_used_at || t - row.last_used_at > TOUCH_EVERY_MS || row.last_ip !== ip) {
    db.query("UPDATE worker_keys SET last_used_at = $t, last_ip = $ip WHERE id = $id").run({ id: row.id, t, ip });
  }
  return row;
}

/** Whether a worker ID belongs to a key: the key's ID itself, or it followed by "-…" (one per GPU). */
export function workerIdBelongs(keyId: string, workerId: string): boolean {
  return workerId === keyId || workerId.startsWith(`${keyId}-`);
}

/**
 * Revoke a key: its token stops working at once, and jobs its workers were
 * running go back to the queue. A key never enrolled is simply deleted.
 * Returns the IDs of the jobs requeued.
 */
export function revokeWorkerKey(id: string): string[] | null {
  const row = getWorkerKey(id);
  if (!row) return null;
  if (!row.enrolled_at) {
    db.query("DELETE FROM worker_keys WHERE id = $id").run({ id });
    return [];
  }
  db.query("UPDATE worker_keys SET revoked_at = COALESCE(revoked_at, $t), token_hash = NULL WHERE id = $id").run({ id, t: now() });
  return db
    .query<{ id: string }, { a: string; b: string }>(
      "SELECT id FROM jobs WHERE status = 'running' AND (worker_id = $a OR worker_id LIKE $b)",
    )
    .all({ a: id, b: `${id}-%` })
    .map((r) => r.id);
}

/** Whether any machine other than this one can be handed recordings. */
export function hasExternalWorkers(): boolean {
  return !!db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM worker_keys WHERE revoked_at IS NULL AND enrolled_at IS NOT NULL").get()?.n;
}

export interface WorkerKeyPublic {
  id: string;
  name: string;
  createdAt: number;
  createdBy: string | null;
  /** Waiting for the machine to use its enrollment code (until it expires). */
  pending: boolean;
  enrollExpiresAt: number | null;
  enrolledAt: number | null;
  lastUsedAt: number | null;
  lastIp: string | null;
  revokedAt: number | null;
  /** Workers of this key seen in the last minute. */
  online: boolean;
}

export function listWorkerKeys(): WorkerKeyPublic[] {
  const t = now();
  // Codes that expired unused are of no further interest.
  db.query("DELETE FROM worker_keys WHERE enrolled_at IS NULL AND enroll_expires_at < $t").run({ t });
  const rows = db
    .query<WorkerKeyRow & { by_name: string | null }, []>(
      `SELECT k.*, u.display_name AS by_name FROM worker_keys k LEFT JOIN users u ON u.id = k.created_by
       ORDER BY k.revoked_at IS NOT NULL, k.created_at DESC`,
    )
    .all();
  const seen = db.query<{ n: number }, { a: string; b: string; since: number }>(
    "SELECT COUNT(*) AS n FROM workers WHERE (id = $a OR id LIKE $b) AND last_seen_at > $since",
  );
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    createdAt: r.created_at,
    createdBy: r.by_name,
    pending: !r.enrolled_at && !r.revoked_at,
    enrollExpiresAt: r.enrolled_at ? null : r.enroll_expires_at,
    enrolledAt: r.enrolled_at,
    lastUsedAt: r.last_used_at,
    lastIp: r.last_ip,
    revokedAt: r.revoked_at,
    online: !r.revoked_at && (seen.get({ a: r.id, b: `${r.id}-%`, since: t - 60_000 })?.n ?? 0) > 0,
  }));
}
