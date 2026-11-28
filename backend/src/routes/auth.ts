import { Hono } from "hono";
import { publicRefineInfo } from "../services/refine";
import { siteRetentionDays } from "../services/mediaRetention";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { config } from "../config";
import { db, now } from "../db";
import { requireUser } from "../auth/middleware";
import { loginIpLimiter, loginUserLimiter, mailIpLimiter, mailToLimiter, registerLimiter, tokenLimiter } from "../auth/ratelimit";
import {
  awaitingVerification,
  consumeVerification,
  createVerification,
  findUserByEmail,
  linkBase,
  mailLinksAvailable,
  normalizeEmail,
  validateEmail,
} from "../auth/accounts";
import { alreadyRegisteredMail, mailConfigured, mailLocale, MailError, resetMail, sendMail, verifyMail } from "../services/mail";
import { billingSettings } from "../services/billingSettings";
import { publicAnnouncements } from "../services/announcements";
import { termsLink, termsText, termsUpdatedAt } from "../services/terms";
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
import { consumeInvite, createInvite, findInvite, revokeResetLinks } from "../auth/invites";
import { httpError } from "../lib/util";
import { knownAddress, recordEvent } from "../services/security";
import { publicSummarizerInfo } from "../services/summarySettings";
import { publicMediaPolicy } from "../services/mediaCompaction";
import { hasExternalWorkers } from "../services/workerKeys";
import { publicTranscriberInfo } from "../services/workerProfiles";
import type { AppEnv, SessionRow } from "../types";
import { SMALL_JSON_LIMIT_BYTES, body } from "./validate";

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

/** Public info about a model, with the model's name kept for administrators only. */
function withoutModel<T extends { model: string | null }>(info: T, admin: boolean): T {
  return admin ? info : { ...info, model: null };
}

authRoutes.get("/state", (c) => {
  const token = getCookie(c, SESSION_COOKIE);
  const resolved = token ? resolveSession(token) : null;
  return c.json({
    needsSetup: countUsers() === 0,
    user: resolved ? publicUser(resolved.user) : null,
    helpContact: config.adminContact || null,
    // How long the site keeps recordings after transcription (days; null: kept). People may choose shorter.
    mediaRetentionDays: siteRetentionDays(),
    // Lets the upload page reject an oversized file before sending anything.
    uploadLimitBytes: config.maxUploadBytes,
    // Public by design: Google shows it on its consent screen.
    googleClientId: config.googleClientId || null,
    // The site's address: a page opened at an earlier one (another port) moves there.
    siteOrigin: config.publicUrl ? new URL(config.publicUrl).origin : null,
    // Who writes summaries, so people are told where a transcript goes. Which model is the
    // administrators' business: others are told the company (or this server), not the model.
    summarizer: resolved ? withoutModel(publicSummarizerInfo(), resolved.user.role === "admin") : null,
    // Where recordings are transcribed, for the same reason.
    transcriber: resolved ? withoutModel(publicTranscriberInfo(), resolved.user.role === "admin") : null,
    // Whether transcripts can be corrected with a hosted model (and where they then go).
    refine: resolved ? publicRefineInfo() : null,
    // Whether originals are later kept as audio only, so a video's uploader is told.
    mediaPolicy: resolved ? publicMediaPolicy() : null,
    // Recordings may be processed on other machines an administrator connected.
    externalWorkers: resolved ? hasExternalWorkers() : null,
    // Whether the sign-in page offers "Create an account" and "Forgot password".
    registration: registrationOpen(),
    passwordReset: mailConfigured() && mailLinksAvailable(),
    // The terms of sale, on this site or elsewhere, for the sign-up page to link.
    termsUrl: termsLink(),
  });
});

/** Announcements for everyone, in effect now: shown on the sign-in page too (maintenance, outages). */
authRoutes.get("/announcements", (c) => c.json({ announcements: publicAnnouncements() }));

/** The terms of sale written on the admin page; public, for buyers and payment providers to read. */
authRoutes.get("/terms", (c) => {
  const markdown = termsText();
  if (!markdown.trim()) httpError(404, "This site has no terms of sale.", "not_found");
  return c.json({ markdown, updatedAt: termsUpdatedAt() });
});

/**
 * What is sold and for how much, in New Taiwan dollars: public, so visitors and
 * payment providers can read the prices without an account. Packages show once
 * the administrator has added them, even before the sale opens (onSale says
 * whether they can be bought now).
 */
authRoutes.get("/pricing", (c) => {
  const s = billingSettings();
  return c.json({
    onSale: s.enabled && s.packages.length > 0,
    currency: "TWD",
    packages: s.packages.map((p) => ({ id: p.id, points: p.points, price: p.price })),
    rates: s.rates,
    methods: s.methods,
    noExpiry: s.noExpiry,
    termsUrl: termsLink(),
    contact: config.adminContact || null,
  });
});

/** The address for links in mail, or 503 when the site does not know its own (PUBLIC_URL). */
function mailBase(c: { req: { url: string } }): string {
  const base = linkBase(c.req.url);
  if (!base) httpError(503, "Set PUBLIC_URL (or ALLOWED_HOSTS) before this site can email links.", "mail_unavailable");
  return base;
}

/** People may create their own accounts: the admin opened sign-up and email can be sent to confirm addresses. */
function registrationOpen(): boolean {
  return billingSettings().registrationOpen && mailConfigured() && mailLinksAvailable();
}

/** Rate limits for anything that sends mail: per client and per address. Throws 429. */
function checkMailLimits(c: any, email: string) {
  const ip = c.get("clientIp");
  const retry = Math.max(mailIpLimiter.check(ip), mailToLimiter.check(email));
  if (retry) {
    c.header("Retry-After", String(retry));
    httpError(429, `Too many requests. Try again in ${Math.ceil(retry / 60)} min.`, "rate_limited");
  }
  mailIpLimiter.hit(ip);
  mailToLimiter.hit(email);
}

const localeField = z.enum(["en", "zh-TW"]).nullable().default(null);

// ------------------------------------------------------- self sign-up

authRoutes.post("/register", async (c) => {
  if (!registrationOpen()) httpError(403, "Creating an account is not open on this site; ask its administrator for an invitation.", "registration_closed");
  const ip = c.get("clientIp");
  const retry = registerLimiter.check(ip);
  if (retry) {
    c.header("Retry-After", String(retry));
    httpError(429, `Too many sign-ups. Try again in ${Math.ceil(retry / 60)} min.`, "rate_limited");
  }
  const input = await body(c, newAccount.extend({ email: z.string().trim().max(254), locale: localeField }), SMALL_JSON_LIMIT_BYTES);
  const email = normalizeEmail(input.email);
  const bad = validateEmail(email);
  if (bad) httpError(422, bad, "invalid_email");
  // Counted before the name is checked: otherwise "taken" answers would let anyone list accounts without limit.
  registerLimiter.hit(ip);
  assertNewAccount(input);
  checkMailLimits(c, email);
  const base = linkBase(c.req.url)!;
  const locale = mailLocale(input.locale);
  const existing = findUserByEmail(email);
  if (existing) {
    // Said the same way as a new sign-up, so the form does not reveal who has an account; the owner is told instead.
    await sendMail(alreadyRegisteredMail(email, `${base}/login`, locale)).catch(() => {});
    return c.json({ ok: true, email });
  }
  const passwordHash = await hashPassword(input.password);
  const user = db.transaction(() => {
    const u = insertUser({ username: input.username, displayName: input.displayName, passwordHash, role: "member" });
    // Accounts people make themselves pay for transcription; invited ones never do.
    db.query("UPDATE users SET email = $e, billing = 'prepaid', locale = $l WHERE id = $id").run({ id: u.id, e: email, l: input.locale });
    return u;
  })();
  const token = createVerification(user.id, email);
  try {
    await sendMail(verifyMail(email, `${base}/verify-email/${token}`, locale));
  } catch (e) {
    // Nobody could confirm it: take the account back, so the name and address are free to try again.
    db.query("DELETE FROM users WHERE id = $id").run({ id: user.id });
    if (e instanceof MailError) httpError(503, "The confirmation email could not be sent. Try again later.", "mail_failed");
    throw e;
  }
  return c.json({ ok: true, email });
});

authRoutes.post("/verify-email", async (c) => {
  const ip = c.get("clientIp");
  const retry = tokenLimiter.check(ip);
  if (retry) httpError(429, `Too many attempts. Try again in ${retry}s.`, "rate_limited");
  const input = await body(c, z.object({ token: z.string().trim().min(1).max(200) }), SMALL_JSON_LIMIT_BYTES);
  const outcome = consumeVerification(input.token);
  if (!outcome.ok) {
    tokenLimiter.hit(ip);
    if (outcome.reason === "taken") httpError(409, "Another account already uses this email address.", "email_taken");
    httpError(404, "This link is invalid, has expired, or was already used.", "invalid_link");
  }
  // Not signed in here: a mail scanner opening the link must not get a session. The person signs in next.
  return c.json({ ok: true, username: outcome.user.username, email: outcome.user.email });
});

/** A new confirmation link for an account that signed up and has not confirmed yet. Always "ok". */
authRoutes.post("/verify-email/resend", async (c) => {
  const base = mailBase(c);
  const input = await body(c, z.object({ email: z.string().trim().max(254), locale: localeField }), SMALL_JSON_LIMIT_BYTES);
  const email = normalizeEmail(input.email);
  if (validateEmail(email)) httpError(422, "Enter a valid email address.", "invalid_email");
  checkMailLimits(c, email);
  const user = findUserByEmail(email);
  if (user && awaitingVerification(user) && !user.disabled) {
    const token = createVerification(user.id, email);
    await sendMail(verifyMail(email, `${base}/verify-email/${token}`, mailLocale(input.locale ?? user.locale))).catch(() => {});
  }
  return c.json({ ok: true });
});

/** Email a link to choose a new password, to an account with this confirmed address. Always "ok". */
authRoutes.post("/forgot-password", async (c) => {
  if (!mailConfigured()) httpError(503, "Email is not set up on this site; ask its administrator for a reset link.", "mail_unavailable");
  const base = mailBase(c);
  const input = await body(c, z.object({ email: z.string().trim().max(254), locale: localeField }), SMALL_JSON_LIMIT_BYTES);
  const email = normalizeEmail(input.email);
  if (validateEmail(email)) httpError(422, "Enter a valid email address.", "invalid_email");
  checkMailLimits(c, email);
  const user = findUserByEmail(email);
  if (user && user.email_verified_at && !user.disabled) {
    const { token } = createInvite({ kind: "reset", role: user.role, targetUserId: user.id, createdBy: user.id, ttlHours: 1, note: "Forgot password" });
    await sendMail(resetMail(email, `${base}/invite/${token}`, mailLocale(input.locale ?? user.locale), user.username)).catch(() => {});
  }
  return c.json({ ok: true });
});

authRoutes.post("/setup", async (c) => {
  const ip = c.get("clientIp");
  const retry = tokenLimiter.check(ip);
  if (retry) httpError(429, `Too many attempts. Try again in ${retry}s.`, "rate_limited");
  const input = await body(c, newAccount.extend({ setupToken: z.string().trim().min(1) }), SMALL_JSON_LIMIT_BYTES);
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
  const input = await body(c, credentials, SMALL_JSON_LIMIT_BYTES);
  const userKey = input.username.toLowerCase();
  c.set("attemptedUser", userKey);
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
  if (awaitingVerification(user)) {
    httpError(403, "Confirm your email address first: open the link in the message we sent.", "email_unverified", { email: user.email });
  }
  // An administrator from an address never seen for the account: worth an alert (not on the very first sign-in).
  if (user.role === "admin" && user.last_login_at && !knownAddress(user.id, ip)) {
    recordEvent("admin_new_ip", { ip, username: user.username, userId: user.id, detail: c.req.header("user-agent")?.slice(0, 200) ?? null });
  } else if (user.role === "admin") {
    recordEvent("account", { ip, username: user.username, userId: user.id, detail: "administrator signed in" });
  }
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
    if (!consumeInvite(invite.id, uid)) httpError(410, "This link has already been used.", "invalid_invite");
  };
  if (invite.kind === "reset") {
    const input = await body(c, z.object({ password: z.string() }), SMALL_JSON_LIMIT_BYTES);
    const p = validatePassword(input.password);
    if (p) httpError(422, p, "weak_password");
    const target = invite.target_user_id ? findUserById(invite.target_user_id) : null;
    if (!target) httpError(404, "The account no longer exists.", "invalid_invite");
    // A disabled account's password stays as it is until an administrator turns it back on.
    if (target.disabled) httpError(404, "This link is invalid or has expired.", "invalid_invite");
    const passwordHash = await hashPassword(input.password);
    db.transaction(() => {
      markUsed(target.id);
      db.query("UPDATE users SET password_hash = $h, updated_at = $t WHERE id = $id").run({ id: target.id, h: passwordHash, t: now() });
      revokeResetLinks(target.id);
      deleteUserSessions(target.id);
    })();
    recordEvent("account", { ip, username: target.username, userId: target.id, detail: "password reset with a link" });
    userId = target.id;
  } else {
    const input = await body(c, newAccount, SMALL_JSON_LIMIT_BYTES);
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
      // Kept with the account, so it follows the person to another browser or address.
      theme: z.enum(["system", "light", "dark"]).nullable().optional(),
      // The new interface, as a preview the person opts into.
      newUi: z.boolean().optional(),
      // How long to keep their recordings after transcription: 7 or 30 days; null: as long as the site does.
      mediaRetentionDays: z.union([z.literal(7), z.literal(30)]).nullable().optional(),
    }),
  );
  const user = c.get("user");
  db.query(
    `UPDATE users SET display_name = COALESCE($dn, display_name), locale = CASE WHEN $setLocale THEN $locale ELSE locale END,
       theme = CASE WHEN $setTheme THEN $theme ELSE theme END,
       new_ui = CASE WHEN $newUi IS NULL THEN new_ui ELSE $newUi END,
       media_retention_days = CASE WHEN $setRetention THEN $retention ELSE media_retention_days END, updated_at = $t WHERE id = $id`,
  ).run({
    id: user.id,
    dn: input.displayName ?? null,
    setLocale: input.locale !== undefined ? 1 : 0,
    locale: input.locale ?? null,
    setTheme: input.theme !== undefined ? 1 : 0,
    theme: input.theme ?? null,
    newUi: input.newUi === undefined ? null : input.newUi ? 1 : 0,
    setRetention: input.mediaRetentionDays !== undefined ? 1 : 0,
    retention: input.mediaRetentionDays ?? null,
    t: now(),
  });
  return c.json({ user: publicUser(findUserById(user.id)!) });
});

/** Change (or add) the account's email address: a link goes to the new one, which takes effect when it is opened. */
meRoutes.post("/email", async (c) => {
  if (!mailConfigured()) httpError(503, "Email is not set up on this site.", "mail_unavailable");
  const base = mailBase(c);
  const input = await body(c, z.object({ email: z.string().trim().max(254), password: z.string().max(1024) }), SMALL_JSON_LIMIT_BYTES);
  const user = c.get("user");
  if (!(await verifyPassword(input.password, user.password_hash))) httpError(403, "Current password is incorrect.", "bad_credentials");
  const email = normalizeEmail(input.email);
  const bad = validateEmail(email);
  if (bad) httpError(422, bad, "invalid_email");
  const other = findUserByEmail(email);
  if (other && other.id !== user.id) httpError(409, "Another account already uses this email address.", "email_taken");
  if (other?.id === user.id && user.email_verified_at) return c.json({ ok: true, sent: false });
  checkMailLimits(c, email);
  const token = createVerification(user.id, email);
  try {
    await sendMail(verifyMail(email, `${base}/verify-email/${token}`, mailLocale(user.locale)));
  } catch (e) {
    if (e instanceof MailError) httpError(503, "The confirmation email could not be sent. Try again later.", "mail_failed");
    throw e;
  }
  return c.json({ ok: true, sent: true });
});

meRoutes.post("/password", async (c) => {
  const input = await body(c, z.object({ current: z.string(), next: z.string() }), SMALL_JSON_LIMIT_BYTES);
  const user = c.get("user");
  if (!(await verifyPassword(input.current, user.password_hash))) httpError(403, "Current password is incorrect.", "bad_credentials");
  const p = validatePassword(input.next);
  if (p) httpError(422, p, "weak_password");
  await setPassword(user.id, input.next);
  deleteUserSessions(user.id, c.get("session").id);
  recordEvent("account", { ip: c.get("clientIp"), username: user.username, userId: user.id, detail: "password changed" });
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
