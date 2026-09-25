import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { config } from "../config";
import { db, now } from "../db";
import { requireUser } from "../auth/middleware";
import { loginIpLimiter, loginUserLimiter, tokenLimiter } from "../auth/ratelimit";
import {
  SESSION_COOKIE,
  countUsers,
  createSession,
  createUser,
  deleteSession,
  deleteUserSessions,
  findUserById,
  findUserByUsername,
  hashPassword,
  insertUser,
  publicUser,
  resolveSession,
  setPassword,
  validatePassword,
  validateUsername,
  verifyPassword,
} from "../auth/service";
import { checkSetupToken, clearSetupToken } from "../auth/setup";
import { findInvite } from "../auth/invites";
import { httpError } from "../lib/util";
import type { AppEnv, SessionRow } from "../types";
import { body } from "./validate";

export const authRoutes = new Hono<AppEnv>();

function setSessionCookie(c: any, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "Lax",
    path: "/",
    maxAge: config.sessionTtlDays * 24 * 3600,
  });
}

const credentials = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(1024),
});

const newAccount = z.object({
  username: z.string().trim(),
  displayName: z.string().trim().min(1).max(80),
  password: z.string(),
});

function assertNewAccount(input: { username: string; password: string }) {
  const u = validateUsername(input.username);
  if (u) httpError(422, u, "invalid_username");
  const p = validatePassword(input.password);
  if (p) httpError(422, p, "weak_password");
  if (findUserByUsername(input.username)) httpError(409, "That username is taken.", "username_taken");
}

authRoutes.get("/state", (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  const resolved = token ? resolveSession(token) : null;
  return c.json({
    needsSetup: countUsers() === 0,
    user: resolved ? publicUser(resolved.user) : null,
    helpContact: config.adminContact || null,
  });
});

authRoutes.post("/setup", async (c) => {
  const ip = c.get("clientIp");
  const retry = tokenLimiter.check(ip);
  if (retry) httpError(429, `Too many attempts. Try again in ${retry}s.`, "rate_limited");
  const input = await body(c, newAccount.extend({ setupToken: z.string().trim().min(1) }));
  if (countUsers() > 0) httpError(409, "Setup has already been completed.", "already_setup");
  if (!checkSetupToken(input.setupToken)) {
    tokenLimiter.hit(ip);
    httpError(403, "Invalid setup token. Copy it from the server log or data/setup.token.", "bad_setup_token");
  }
  assertNewAccount(input);
  const user = await createUser({ username: input.username, displayName: input.displayName, password: input.password, role: "admin" });
  clearSetupToken();
  const { token } = createSession(user.id, ip, c.req.header("user-agent") ?? null);
  setSessionCookie(c, token);
  return c.json({ user: publicUser(user) });
});

authRoutes.post("/login", async (c) => {
  const ip = c.get("clientIp");
  const input = await body(c, credentials);
  const userKey = input.username.toLowerCase();
  const retry = Math.max(loginIpLimiter.check(ip), loginUserLimiter.check(userKey));
  if (retry) {
    c.header("Retry-After", String(retry));
    httpError(429, `Too many failed sign-in attempts. Try again in ${Math.ceil(retry / 60)} min.`, "rate_limited");
  }
  const user = findUserByUsername(input.username);
  const ok = await verifyPassword(input.password, user?.password_hash ?? null);
  if (!ok || !user || user.disabled) {
    loginIpLimiter.hit(ip);
    loginUserLimiter.hit(userKey);
    httpError(401, "Incorrect username or password.", "bad_credentials");
  }
  loginUserLimiter.reset(userKey);
  const { token } = createSession(user.id, ip, c.req.header("user-agent") ?? null);
  setSessionCookie(c, token);
  return c.json({ user: publicUser(user) });
});

authRoutes.post("/logout", (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  const resolved = token ? resolveSession(token) : null;
  if (resolved) deleteSession(resolved.session.id);
  deleteCookie(c, SESSION_COOKIE, { path: "/", secure: config.cookieSecure });
  return c.json({ ok: true });
});

// ------------------------------------------------------------- invites

authRoutes.get("/invites/:token", (c) => {
  const invite = findInvite(c.req.param("token"));
  if (!invite) httpError(404, "This link is invalid or has expired.", "invalid_invite");
  const target = invite.target_user_id ? findUserById(invite.target_user_id) : null;
  return c.json({ kind: invite.kind, role: invite.role, username: target?.username ?? null, expiresAt: invite.expires_at });
});

authRoutes.post("/invites/:token/accept", async (c) => {
  const ip = c.get("clientIp");
  const retry = tokenLimiter.check(ip);
  if (retry) httpError(429, `Too many attempts. Try again in ${retry}s.`, "rate_limited");
  const invite = findInvite(c.req.param("token"));
  if (!invite) {
    tokenLimiter.hit(ip);
    httpError(404, "This link is invalid or has expired.", "invalid_invite");
  }
  let userId: string;
  const markUsed = (uid: string) => {
    const used = db
      .query("UPDATE invites SET used_at = $t, used_by = $u WHERE id = $id AND used_at IS NULL")
      .run({ id: invite.id, u: uid, t: now() });
    if (used.changes === 0) httpError(410, "This link has already been used.", "invalid_invite");
  };
  if (invite.kind === "reset") {
    const input = await body(c, z.object({ password: z.string() }));
    const p = validatePassword(input.password);
    if (p) httpError(422, p, "weak_password");
    const target = invite.target_user_id ? findUserById(invite.target_user_id) : null;
    if (!target) httpError(404, "The account no longer exists.", "invalid_invite");
    const passwordHash = await hashPassword(input.password);
    db.transaction(() => {
      markUsed(target.id);
      db.query("UPDATE users SET password_hash = $h, updated_at = $t WHERE id = $id").run({ id: target.id, h: passwordHash, t: now() });
      deleteUserSessions(target.id);
    })();
    userId = target.id;
  } else {
    const input = await body(c, newAccount);
    assertNewAccount(input);
    const passwordHash = await hashPassword(input.password);
    userId = db.transaction(() => {
      const user = insertUser({ username: input.username, displayName: input.displayName, passwordHash, role: invite.role });
      markUsed(user.id);
      return user.id;
    })();
  }
  const { token } = createSession(userId, ip, c.req.header("user-agent") ?? null);
  setSessionCookie(c, token);
  return c.json({ user: publicUser(findUserById(userId)!) });
});

// ------------------------------------------------------ signed-in user

export const meRoutes = new Hono<AppEnv>();
meRoutes.use(requireUser);

meRoutes.get("/", (c) => c.json({ user: publicUser(c.get("user")) }));

meRoutes.patch("/", async (c) => {
  const input = await body(
    c,
    z.object({
      displayName: z.string().trim().min(1).max(80).optional(),
      locale: z.enum(["en", "zh-TW"]).nullable().optional(),
    }),
  );
  const user = c.get("user");
  db.query(
    "UPDATE users SET display_name = COALESCE($dn, display_name), locale = CASE WHEN $setLocale THEN $locale ELSE locale END, updated_at = $t WHERE id = $id",
  ).run({
    id: user.id,
    dn: input.displayName ?? null,
    setLocale: input.locale !== undefined ? 1 : 0,
    locale: input.locale ?? null,
    t: now(),
  });
  return c.json({ user: publicUser(findUserById(user.id)!) });
});

meRoutes.post("/password", async (c) => {
  const input = await body(c, z.object({ current: z.string(), next: z.string() }));
  const user = c.get("user");
  if (!(await verifyPassword(input.current, user.password_hash))) httpError(403, "Current password is incorrect.", "bad_credentials");
  const p = validatePassword(input.next);
  if (p) httpError(422, p, "weak_password");
  await setPassword(user.id, input.next);
  deleteUserSessions(user.id, c.get("session").id);
  return c.json({ ok: true });
});

meRoutes.get("/sessions", (c) => {
  const user = c.get("user");
  const current = c.get("session");
  const rows = db
    .query<SessionRow, { u: string; t: number }>(
      "SELECT * FROM sessions WHERE user_id = $u AND expires_at > $t ORDER BY last_seen_at DESC",
    )
    .all({ u: user.id, t: now() });
  return c.json({
    sessions: rows.map((s) => ({
      id: s.id,
      current: s.id === current.id,
      ip: s.ip,
      userAgent: s.user_agent,
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
    })),
  });
});

meRoutes.delete("/sessions/:id", (c) => {
  const user = c.get("user");
  db.query("DELETE FROM sessions WHERE id = $id AND user_id = $u").run({ id: c.req.param("id"), u: user.id });
  return c.json({ ok: true });
});

meRoutes.post("/sessions/revoke-others", (c) => {
  deleteUserSessions(c.get("user").id, c.get("session").id);
  return c.json({ ok: true });
});
