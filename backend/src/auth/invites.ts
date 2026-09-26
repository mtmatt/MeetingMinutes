import { db, now } from "../db";
import { newId, sha256 } from "../lib/util";
import type { Role } from "../types";

export interface InviteRow {
  id: string;
  token_hash: string;
  kind: "invite" | "reset";
  role: Role;
  note: string | null;
  target_user_id: string | null;
  created_by: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  used_by: string | null;
}

export function createInvite(input: {
  kind: "invite" | "reset";
  role: Role;
  note?: string | null;
  targetUserId?: string | null;
  createdBy: string;
  ttlHours: number;
}): { token: string; invite: InviteRow } {
  const token = newId(24);
  const id = newId(9);
  const t = now();
  if (input.kind === "reset" && input.targetUserId) {
    // Only the newest reset link for a user stays valid.
    db.query("DELETE FROM invites WHERE kind = 'reset' AND target_user_id = $u AND used_at IS NULL").run({ u: input.targetUserId });
  }
  db.query(
    `INSERT INTO invites (id, token_hash, kind, role, note, target_user_id, created_by, created_at, expires_at)
     VALUES ($id, $h, $kind, $role, $note, $target, $by, $t, $exp)`,
  ).run({
    id,
    h: sha256(token),
    kind: input.kind,
    role: input.role,
    note: input.note ?? null,
    target: input.targetUserId ?? null,
    by: input.createdBy,
    t,
    exp: t + input.ttlHours * 3600 * 1000,
  });
  return { token, invite: db.query<InviteRow, { id: string }>("SELECT * FROM invites WHERE id = $id").get({ id })! };
}

/** A usable (unexpired, unused) invite for the raw token, or null. */
export function findInvite(token: string): InviteRow | null {
  if (!token || token.length > 200) return null;
  return db
    .query<InviteRow, { h: string; t: number }>(
      "SELECT * FROM invites WHERE token_hash = $h AND used_at IS NULL AND expires_at > $t",
    )
    .get({ h: sha256(token), t: now() });
}
