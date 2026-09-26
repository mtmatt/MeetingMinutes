import { config } from "../config";
import { db, now } from "../db";
import { newId, sha256 } from "../lib/util";
import type { Role, SessionRow, UserRow } from "../types";

export const PASSWORD_MIN = 10;
export const PASSWORD_MAX = 256;
export const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,31}$/;

export const SESSION_COOKIE = config.cookieSecure ? "__Host-mm_session" : "mm_session";

export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });
}

// Used to equalise timing when a username does not exist.
let dummyHash: string | null = null;
async function getDummyHash() {
  dummyHash ??= await hashPassword("not-a-real-password-" + newId());
  return dummyHash;
}

export async function verifyPassword(password: string, hash: string | null): Promise<boolean> {
  if (!hash) {
    await Bun.password.verify(password, await getDummyHash());
    return false;
  }
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    return false;
  }
}

export function validatePassword(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters.`;
  return null;
}

export function validateUsername(username: string): string | null {
  if (!USERNAME_RE.test(username)) {
    return "Username must be 2-32 characters: letters, digits, dot, underscore or dash, starting with a letter or digit.";
  }
  return null;
}

export function countUsers(): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users").get()?.n ?? 0;
}

export function findUserByUsername(username: string): UserRow | null {
  return db.query<UserRow, { username: string }>("SELECT * FROM users WHERE username = $username").get({ username });
}

export function findUserById(id: string): UserRow | null {
  return db.query<UserRow, { id: string }>("SELECT * FROM users WHERE id = $id").get({ id });
}

export async function createUser(input: {
  username: string;
  displayName: string;
  password: string;
  role: Role;
}): Promise<UserRow> {
  return insertUser({ ...input, passwordHash: await hashPassword(input.password) });
}

/** Synchronous insert with a pre-computed hash, usable inside a transaction. */
export function insertUser(input: { username: string; displayName: string; passwordHash: string; role: Role }): UserRow {
  const id = newId();
  const t = now();
  const password_hash = input.passwordHash;
  db.query(
    `INSERT INTO users (id, username, display_name, password_hash, role, created_at, updated_at)
     VALUES ($id, $username, $display_name, $password_hash, $role, $t, $t)`,
  ).run({ id, username: input.username, display_name: input.displayName, password_hash, role: input.role, t });
  return findUserById(id)!;
}

export async function setPassword(userId: string, password: string) {
  const password_hash = await hashPassword(password);
  db.query("UPDATE users SET password_hash = $password_hash, updated_at = $t WHERE id = $id").run({
    id: userId,
    password_hash,
    t: now(),
  });
}

export function publicUser(u: UserRow) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name,
    role: u.role,
    disabled: !!u.disabled,
    locale: u.locale,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
  };
}

// ---------------------------------------------------------------- sessions

const SESSION_TTL_MS = () => config.sessionTtlDays * 24 * 3600 * 1000;
/** Only write last_seen_at when it is older than this, to avoid a write per request. */
const TOUCH_INTERVAL_MS = 5 * 60 * 1000;

export function createSession(userId: string, ip: string, userAgent: string | null): { token: string; session: SessionRow } {
  const token = newId(32);
  const id = newId(12);
  const t = now();
  db.query(
    `INSERT INTO sessions (id, token_hash, user_id, created_at, expires_at, last_seen_at, ip, user_agent)
     VALUES ($id, $token_hash, $user_id, $t, $expires_at, $t, $ip, $ua)`,
  ).run({
    id,
    token_hash: sha256(token),
    user_id: userId,
    t,
    expires_at: t + SESSION_TTL_MS(),
    ip,
    ua: userAgent?.slice(0, 300) ?? null,
  });
  db.query("UPDATE users SET last_login_at = $t WHERE id = $id").run({ id: userId, t });
  return { token, session: db.query<SessionRow, { id: string }>("SELECT * FROM sessions WHERE id = $id").get({ id })! };
}

export function resolveSession(token: string): { session: SessionRow; user: UserRow } | null {
  const session = db
    .query<SessionRow, { h: string }>("SELECT * FROM sessions WHERE token_hash = $h")
    .get({ h: sha256(token) });
  if (!session) return null;
  const t = now();
  if (session.expires_at <= t) {
    db.query("DELETE FROM sessions WHERE id = $id").run({ id: session.id });
    return null;
  }
  const user = findUserById(session.user_id);
  if (!user || user.disabled) return null;
  if (t - session.last_seen_at > TOUCH_INTERVAL_MS) {
    // Sliding expiration: active sessions stay alive.
    db.query("UPDATE sessions SET last_seen_at = $t, expires_at = $e WHERE id = $id").run({
      id: session.id,
      t,
      e: t + SESSION_TTL_MS(),
    });
  }
  return { session, user };
}

export function deleteSession(id: string) {
  db.query("DELETE FROM sessions WHERE id = $id").run({ id });
}

export function deleteUserSessions(userId: string, exceptSessionId?: string) {
  db.query("DELETE FROM sessions WHERE user_id = $u AND id != $keep").run({ u: userId, keep: exceptSessionId ?? "" });
}

export function purgeExpiredSessions() {
  db.query("DELETE FROM sessions WHERE expires_at <= $t").run({ t: now() });
}
