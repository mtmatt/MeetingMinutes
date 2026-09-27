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
  /** When the link was used up (its last allowed use). */
  used_at: number | null;
  /** Who used it most recently. */
  used_by: string | null;
  max_uses: number;
  use_count: number;
  revoked_at: number | null;
}

/** Most people one invitation link can bring in. */
export const MAX_INVITE_USES = 100;

export function createInvite(input: {
  kind: "invite" | "reset";
  role: Role;
  note?: string | null;
  targetUserId?: string | null;
  createdBy: string;
  ttlHours: number;
  maxUses?: number;
}): { token: string; invite: InviteRow } {
  const token = newId(24);
  const id = newId(9);
  const t = now();
  if (input.kind === "reset" && input.targetUserId) {
    // Only the newest reset link for a user stays valid.
    db.query("DELETE FROM invites WHERE kind = 'reset' AND target_user_id = $u AND used_at IS NULL").run({ u: input.targetUserId });
  }
  db.query(
    `INSERT INTO invites (id, token_hash, kind, role, note, target_user_id, created_by, created_at, expires_at, max_uses)
     VALUES ($id, $h, $kind, $role, $note, $target, $by, $t, $exp, $max)`,
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
    // Reset links, and invitations for admins, are always single-use.
    max: input.kind === "invite" && input.role === "member" ? (input.maxUses ?? 1) : 1,
  });
  return { token, invite: db.query<InviteRow, { id: string }>("SELECT * FROM invites WHERE id = $id").get({ id })! };
}

const USABLE = "use_count < max_uses AND revoked_at IS NULL AND expires_at > $t";

/** A usable invite (unexpired, not revoked, uses left) for the raw token, or null. */
export function findInvite(token: string): InviteRow | null {
  if (!token || token.length > 200) return null;
  return db.query<InviteRow, { h: string; t: number }>(`SELECT * FROM invites WHERE token_hash = $h AND ${USABLE}`).get({ h: sha256(token), t: now() });
}

/**
 * Record one use of an invite by userId. Returns false when no use is left
 * (another sign-up took the last one, or it was revoked or expired meanwhile),
 * so the caller's transaction can roll back. The check and the count are one
 * statement, so concurrent sign-ups can never exceed max_uses.
 */
export function consumeInvite(inviteId: string, userId: string): boolean {
  const t = now();
  const res = db
    .query(
      `UPDATE invites SET use_count = use_count + 1, used_by = $u,
         used_at = CASE WHEN use_count + 1 >= max_uses THEN $t ELSE NULL END
       WHERE id = $id AND ${USABLE}`,
    )
    .run({ id: inviteId, u: userId, t });
  if (res.changes === 0) return false;
  db.query("INSERT INTO invite_uses (invite_id, user_id, used_at) VALUES ($id, $u, $t)").run({ id: inviteId, u: userId, t });
  return true;
}

export type InviteStatus = "active" | "used_up" | "revoked" | "expired";

export function inviteStatus(i: InviteRow, t = now()): InviteStatus {
  if (i.use_count >= i.max_uses) return "used_up";
  if (i.revoked_at != null) return "revoked";
  if (i.expires_at <= t) return "expired";
  return "active";
}
