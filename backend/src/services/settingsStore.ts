import { db, now } from "../db";

/**
 * Settings an administrator saves on the admin page, one JSON value per key
 * in the `settings` table. Each kind of setting (summary model, transcription)
 * keeps its own schema and defaults; this only stores and reads them.
 */

interface StoredRow {
  value: string;
  updated_at: number;
  updated_by: string | null;
}

function storedRow(key: string): StoredRow | null {
  return db.query<StoredRow, { k: string }>("SELECT value, updated_at, updated_by FROM settings WHERE key = $k").get({ k: key });
}

/** The saved JSON text, or null when nothing has been saved. */
export function readSetting(key: string): string | null {
  return storedRow(key)?.value ?? null;
}

/** `userId` null: changed by the server itself (e.g. a revoked worker's settings removed). */
export function writeSetting(key: string, value: unknown, userId: string | null): void {
  db.query(
    `INSERT INTO settings (key, value, updated_at, updated_by) VALUES ($k, $v, $t, $u)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  ).run({ k: key, v: JSON.stringify(value), t: now(), u: userId });
}

export function deleteSetting(key: string): void {
  db.query("DELETE FROM settings WHERE key = $k").run({ k: key });
}

/** Whether settings were saved, when, and by whom (their display name). */
export function settingMeta(key: string): { saved: boolean; updatedAt: number | null; updatedBy: string | null } {
  const row = storedRow(key);
  if (!row) return { saved: false, updatedAt: null, updatedBy: null };
  const by = row.updated_by
    ? db.query<{ display_name: string }, { id: string }>("SELECT display_name FROM users WHERE id = $id").get({ id: row.updated_by })
    : null;
  return { saved: true, updatedAt: row.updated_at, updatedBy: by?.display_name ?? null };
}
