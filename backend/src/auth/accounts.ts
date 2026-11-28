import { config } from "../config";
import { db, now } from "../db";
import { newId, sha256 } from "../lib/util";
import { revokeResetLinks } from "./invites";
import type { UserRow } from "../types";
import { findUserById } from "./service";

/**
 * Accounts people create themselves with an email address (when the admin
 * opens sign-up), and the links that confirm an address. A new account cannot
 * sign in until its address is confirmed, and is removed if it never is.
 */

export const VERIFY_TTL_MS = 24 * 3600 * 1000;
/** Unconfirmed sign-ups are removed after this, freeing the name and the address. */
export const UNVERIFIED_TTL_MS = 7 * 24 * 3600 * 1000;

/**
 * A plain mailbox address: letters, digits and the usual symbols before the @,
 * and a domain name after it. Not the full RFC 5322 syntax: forms such as
 * "Name <a@b>" or quoted parts would let one mailbox pass as many different
 * addresses (and around the one-account-per-address rule).
 */
const EMAIL_RE = /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/i;

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function validateEmail(email: string): string | null {
  return EMAIL_RE.test(email) && email.length <= 254 ? null : "Enter a valid email address.";
}

export function findUserByEmail(email: string): UserRow | null {
  return db.query<UserRow, { e: string }>("SELECT * FROM users WHERE email = $e COLLATE NOCASE").get({ e: normalizeEmail(email) });
}

/** A new link to confirm `email` for the user (earlier unused ones stop working). Returns the raw token. */
export function createVerification(userId: string, email: string): string {
  const token = newId(24);
  const t = now();
  db.transaction(() => {
    db.query("DELETE FROM email_verifications WHERE user_id = $u AND used_at IS NULL").run({ u: userId });
    db.query("INSERT INTO email_verifications (id, token_hash, user_id, email, created_at, expires_at) VALUES ($id, $h, $u, $e, $t, $x)").run({
      id: newId(9),
      h: sha256(token),
      u: userId,
      e: normalizeEmail(email),
      t,
      x: t + VERIFY_TTL_MS,
    });
  })();
  return token;
}

export type VerifyOutcome = { ok: true; user: UserRow; changed: boolean } | { ok: false; reason: "invalid" | "taken" };

/**
 * Confirm the address a link was sent to: the account's sign-up address, or a
 * new one it asked to change to (which then replaces the old).
 */
export function consumeVerification(token: string): VerifyOutcome {
  if (!token || token.length > 200) return { ok: false, reason: "invalid" };
  const t = now();
  return db.transaction((): VerifyOutcome => {
    const row = db
      .query<{ id: string; user_id: string; email: string }, { h: string; t: number }>(
        "SELECT id, user_id, email FROM email_verifications WHERE token_hash = $h AND used_at IS NULL AND expires_at > $t",
      )
      .get({ h: sha256(token), t });
    if (!row) return { ok: false, reason: "invalid" };
    const user = findUserById(row.user_id);
    if (!user) return { ok: false, reason: "invalid" };
    const other = db
      .query<{ id: string }, { e: string; u: string }>("SELECT id FROM users WHERE email = $e COLLATE NOCASE AND id != $u")
      .get({ e: row.email, u: user.id });
    if (other) return { ok: false, reason: "taken" };
    db.query("UPDATE email_verifications SET used_at = $t WHERE id = $id").run({ id: row.id, t });
    const changed = user.email?.toLowerCase() !== row.email || !user.email_verified_at;
    db.query("UPDATE users SET email = $e, email_verified_at = $t, updated_at = $t WHERE id = $u").run({ u: user.id, e: row.email, t });
    // Reset links already mailed went to the old address: they stop working with it.
    if (user.email && user.email.toLowerCase() !== row.email) revokeResetLinks(user.id);
    return { ok: true, user: findUserById(user.id)!, changed };
  })();
}

/** Whether this account may not sign in yet: it signed up itself and has not confirmed its address. */
export function awaitingVerification(user: UserRow): boolean {
  return user.billing === "prepaid" && !user.email_verified_at;
}

/** Remove sign-ups never confirmed (nothing of theirs exists: they could not sign in). */
export function purgeUnverifiedAccounts(): number {
  const res = db
    .query("DELETE FROM users WHERE billing = 'prepaid' AND email_verified_at IS NULL AND last_login_at IS NULL AND created_at < $c")
    .run({ c: now() - UNVERIFIED_TTL_MS });
  return res.changes;
}

/**
 * The site's address for links in email: PUBLIC_URL, else the address the
 * request came to, but only where the site answers to its own names alone
 * (ALLOWED_HOSTS). Otherwise the Host header is the sender's choice, and a
 * password-reset link mailed to someone else could point at the sender's site.
 */
export function linkBase(requestUrl: string): string | null {
  if (config.publicUrl) return config.publicUrl;
  return config.allowedHosts.length ? new URL(requestUrl).origin : null;
}

/** Whether links can be mailed at all (see linkBase). */
export function mailLinksAvailable(): boolean {
  return !!config.publicUrl || config.allowedHosts.length > 0;
}
