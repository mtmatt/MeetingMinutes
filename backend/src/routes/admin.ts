import { Hono } from "hono";
import { statfsSync } from "node:fs";
import { z } from "zod";
import { config } from "../config";
import { requireAdmin, requireUser } from "../auth/middleware";
import { MAX_INVITE_USES, createInvite, inviteStatus, type InviteRow } from "../auth/invites";
import { deleteUserSessions, findUserById, publicUser } from "../auth/service";
import { db, now } from "../db";
import { httpError, parseJson } from "../lib/util";
import {
  compactionStats,
  defaultMediaSettings,
  enqueueCompactions,
  mediaSettings,
  mediaSettingsMeta,
  mediaSettingsSchema,
  resetMediaSettings,
  saveMediaSettings,
} from "../services/mediaCompaction";
import { deleteMeeting, queueStats, requeueJobs } from "../services/meetings";
import { ENROLL_TTL_MS, createWorkerKey, getWorkerKey, listWorkerKeys, revokeWorkerKey } from "../services/workerKeys";
import {
  DEFAULT_FALLBACK_SEC,
  LOCAL_PROFILE,
  deleteWorkerProfile,
  listWorkerProfiles,
  publicTranscriberInfo,
  saveWorkerProfile,
  workerProfileSchema,
} from "../services/workerProfiles";
import { kick, summarizerStats } from "../services/summarizer";
import { LlmError, localModelStatus, modelInfo, pullState, startPull } from "../services/llm";
import { API_PROVIDERS, PROVIDER_INFO, providerKey, providerKeys } from "../services/summaryApis";
import {
  defaultSummarySettings,
  apiSettingsSchema,
  localSettingsSchema,
  resetSummarySettings,
  saveSummarySettings,
  summarySettings,
  summarySettingsMeta,
  summarySettingsSchema,
} from "../services/summarySettings";
import {
  ASR_KEY_VARIABLES,
  OPENAI_BASE_URL,
  OPENROUTER_BASE_URL,
  defaultTranscriberSettings,
  resetTranscriberSettings,
  saveTranscriberSettings,
  transcriberSettings,
  transcriberSettingsMeta,
  transcriberSettingsSchema,
  workerApiKeys,
} from "../services/transcriberSettings";
import type { AppEnv, MeetingRow, UserRow } from "../types";
import { MILLI, addCredits, ledger, publicLedgerEntry } from "../services/credits";
import { billingSettings, billingSettingsMeta, billingSettingsSchema, saveBillingSettings } from "../services/billingSettings";
import { TERMS_MAX, saveTerms, termsText, termsUpdatedAt } from "../services/terms";
import { getOrder, publicEcpayInfo, publicOrder, queryOrder, type OrderRow } from "../services/ecpay";
import { MailError, mailLocale, publicMailInfo, sendMail, testMail } from "../services/mail";
import {
  EVENT_KINDS,
  blockIp,
  defaultSecuritySettings,
  normalizeIp,
  publicAlertInfo,
  recentEvents,
  recordEvent,
  saveSecuritySettings,
  securityOverview,
  securitySettings,
  securitySettingsMeta,
  securitySettingsSchema,
  unblockIp,
} from "../services/security";
import { isIP } from "node:net";
import { SMALL_JSON_LIMIT_BYTES, body } from "./validate";

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use(requireUser, requireAdmin);

function linkFor(c: any, token: string) {
  const base = config.publicUrl || new URL(c.req.url).origin;
  return `${base}/invite/${token}`;
}

function activeAdminCount(): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0").get()?.n ?? 0;
}

adminRoutes.get("/users", (c) => {
  const rows = db.query<UserRow & { meetings: number }, []>(
    `SELECT u.*, (SELECT COUNT(*) FROM meetings m WHERE m.owner_id = u.id) AS meetings
     FROM users u ORDER BY u.created_at ASC`,
  ).all();
  return c.json({ users: rows.map((u) => ({ ...publicUser(u), meetings: u.meetings })) });
});

adminRoutes.patch("/users/:id", async (c) => {
  const me = c.get("user");
  const target = findUserById(c.req.param("id"));
  if (!target) httpError(404, "User not found.", "not_found");
  const input = await body(
    c,
    z.object({
      role: z.enum(["admin", "member"]).optional(),
      disabled: z.boolean().optional(),
      displayName: z.string().trim().min(1).max(80).optional(),
      /** "prepaid": pays for transcription and summaries with points; "exempt": free. */
      billing: z.enum(["exempt", "prepaid"]).optional(),
    }),
  );
  const demoting = target.role === "admin" && ((input.role && input.role !== "admin") || input.disabled === true);
  if (demoting && !target.disabled && activeAdminCount() <= 1) {
    httpError(409, "At least one active administrator is required.", "last_admin");
  }
  if (target.id === me.id && input.disabled) httpError(409, "You cannot disable your own account.", "self");
  db.query(
    `UPDATE users SET role = COALESCE($role, role), disabled = COALESCE($disabled, disabled),
       display_name = COALESCE($dn, display_name), billing = COALESCE($billing, billing), updated_at = $t WHERE id = $id`,
  ).run({
    id: target.id,
    billing: input.billing ?? null,
    role: input.role ?? null,
    disabled: input.disabled === undefined ? null : input.disabled ? 1 : 0,
    dn: input.displayName ?? null,
    t: now(),
  });
  if (input.disabled) deleteUserSessions(target.id);
  const by = `by ${me.username}`;
  if (input.role === "admin" && target.role !== "admin") {
    recordEvent("account", { ip: c.get("clientIp"), username: target.username, userId: target.id, detail: `admin granted to ${target.username} ${by}` });
  }
  if (input.disabled && !target.disabled) {
    recordEvent("account", { ip: c.get("clientIp"), username: target.username, userId: target.id, detail: `account disabled ${by}` });
  }
  return c.json({ user: publicUser(findUserById(target.id)!) });
});

adminRoutes.delete("/users/:id", async (c) => {
  const me = c.get("user");
  const target = findUserById(c.req.param("id"));
  if (!target) httpError(404, "User not found.", "not_found");
  if (target.id === me.id) httpError(409, "You cannot delete your own account.", "self");
  if (target.role === "admin" && !target.disabled && activeAdminCount() <= 1) {
    httpError(409, "At least one active administrator is required.", "last_admin");
  }
  const meetings = db.query<MeetingRow, { u: string }>("SELECT * FROM meetings WHERE owner_id = $u").all({ u: target.id });
  for (const m of meetings) await deleteMeeting(m);
  db.query("DELETE FROM users WHERE id = $id").run({ id: target.id });
  return c.json({ ok: true });
});

adminRoutes.post("/users/:id/reset-link", (c) => {
  const target = findUserById(c.req.param("id"));
  if (!target) httpError(404, "User not found.", "not_found");
  const { token, invite } = createInvite({
    kind: "reset",
    role: target.role,
    targetUserId: target.id,
    createdBy: c.get("user").id,
    ttlHours: 24,
  });
  return c.json({ url: linkFor(c, token), expiresAt: invite.expires_at });
});

function publicInvite(i: InviteRow, usedBy: string[], t = now()) {
  return {
    id: i.id,
    role: i.role,
    note: i.note,
    createdAt: i.created_at,
    expiresAt: i.expires_at,
    maxUses: i.max_uses,
    useCount: i.use_count,
    status: inviteStatus(i, t),
    /** Usernames of everyone who joined through it, oldest first (deleted accounts left out). */
    usedBy,
    usedAt: i.used_at,
    revokedAt: i.revoked_at,
  };
}

// Open invitations, and closed ones that someone used (a record of who joined how).
adminRoutes.get("/invites", (c) => {
  const t = now();
  const rows = db
    .query<InviteRow, { t: number }>(
      `SELECT * FROM invites WHERE kind = 'invite' AND (use_count > 0 OR (revoked_at IS NULL AND expires_at > $t))
       ORDER BY created_at DESC LIMIT 100`,
    )
    .all({ t });
  const uses = db
    .query<{ invite_id: string; username: string }, { ids: string }>(
      `SELECT iu.invite_id, u.username FROM invite_uses iu JOIN users u ON u.id = iu.user_id
       WHERE iu.invite_id IN (SELECT value FROM json_each($ids)) ORDER BY iu.used_at`,
    )
    .all({ ids: JSON.stringify(rows.map((i) => i.id)) });
  const byInvite = new Map<string, string[]>();
  for (const u of uses) {
    const names = byInvite.get(u.invite_id);
    if (names) names.push(u.username);
    else byInvite.set(u.invite_id, [u.username]);
  }
  return c.json({ invites: rows.map((i) => publicInvite(i, byInvite.get(i.id) ?? [], t)) });
});

adminRoutes.post("/invites", async (c) => {
  const input = await body(
    c,
    z.object({
      role: z.enum(["admin", "member"]).default("member"),
      note: z.string().trim().max(200).nullable().default(null),
      ttlHours: z.number().int().min(1).max(24 * 30).default(72),
      maxUses: z.number().int().min(1).max(MAX_INVITE_USES).default(1),
    }),
  );
  // One leaked link must never produce several administrators.
  if (input.role === "admin" && input.maxUses !== 1) httpError(422, "An invitation for an administrator can be used only once.", "invalid_input");
  const { token, invite } = createInvite({
    kind: "invite",
    role: input.role,
    note: input.note,
    createdBy: c.get("user").id,
    ttlHours: input.ttlHours,
    maxUses: input.maxUses,
  });
  return c.json({ url: linkFor(c, token), invite: publicInvite(invite, []) }, 201);
});

// Revoke: an unused link disappears; a partly used one stops working but stays
// listed, so the record of who joined through it is kept.
adminRoutes.delete("/invites/:id", (c) => {
  const id = c.req.param("id");
  const t = now();
  db.transaction(() => {
    db.query("DELETE FROM invites WHERE id = $id AND kind = 'invite' AND use_count = 0").run({ id });
    db.query("UPDATE invites SET revoked_at = $t WHERE id = $id AND kind = 'invite' AND revoked_at IS NULL AND use_count < max_uses").run({ id, t });
  })();
  return c.json({ ok: true });
});

adminRoutes.get("/system", async (c) => {
  const workers = db
    .query<{ id: string; name: string; info: string; last_seen_at: number }, []>("SELECT * FROM workers ORDER BY last_seen_at DESC")
    .all();
  let disk: { freeBytes: number; totalBytes: number } | null = null;
  try {
    const s = statfsSync(config.dataDir);
    disk = { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    disk = null;
  }
  const t = now();
  return c.json({
    workers: workers.map((w) => ({
      id: w.id,
      name: w.name,
      info: parseJson<Record<string, unknown>>(w.info, {}),
      lastSeenAt: w.last_seen_at,
      online: t - w.last_seen_at < 60_000,
    })),
    jobs: queueStats(),
    summaries: summarizerStats(),
    transcriber: publicTranscriberInfo(),
    disk,
    stats: {
      users: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users").get()?.n ?? 0,
      meetings: db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM meetings").get()?.n ?? 0,
      audioHours: (db.query<{ s: number | null }, []>("SELECT SUM(duration_sec) AS s FROM meetings").get()?.s ?? 0) / 3600,
    },
  });
});

// ------------------------------------------------------- summary model

function summarizerState() {
  return {
    settings: summarySettings(),
    defaults: defaultSummarySettings(),
    ...summarySettingsMeta(),
    // Whether LLM_API_KEY is set (never the key itself), for OpenAI-compatible servers that need one.
    apiKeyConfigured: config.llm.apiKey !== "",
    // Hosted providers: which have a key in the environment (never the keys), and what the page shows for each.
    apiKeys: providerKeys(),
    apiProviders: Object.fromEntries(
      API_PROVIDERS.map((p) => {
        const { label, keyVariables, host, defaultModel } = PROVIDER_INFO[p];
        return [p, { label, keyVariables, host, defaultModel }];
      }),
    ),
  };
}

adminRoutes.get("/summarizer", (c) => c.json(summarizerState()));

adminRoutes.put("/summarizer", async (c) => {
  const input = await body(c, summarySettingsSchema);
  saveSummarySettings(input, c.get("user").id);
  // A higher concurrency, or a model that is now available, can start waiting summaries.
  kick();
  return c.json(summarizerState());
});

// Back to the .env defaults.
adminRoutes.delete("/summarizer", (c) => {
  resetSummarySettings();
  kick();
  return c.json(summarizerState());
});

/** The server to look at: the form's values, so a setting can be checked before it is saved. */
const probeSchema = localSettingsSchema.pick({ api: true, baseUrl: true, model: true });

function probeTarget(input: { api: "ollama" | "openai"; baseUrl: string; model: string }) {
  return { ...summarySettings().local, ...input };
}

adminRoutes.post("/summarizer/probe", async (c) => {
  const input = await body(c, probeSchema);
  const target = probeTarget(input);
  const pull = pullState();
  return c.json({
    status: await localModelStatus(target),
    pull: pull && pull.baseUrl === target.baseUrl ? pull : null,
  });
});

/**
 * Check a hosted model before it is saved: is there a key, does the provider
 * accept it, does the model exist, and how long a transcript it takes. Asks
 * only for the model's details (free), never for a completion.
 */
adminRoutes.post("/summarizer/probe-api", async (c) => {
  const input = await body(c, apiSettingsSchema.pick({ provider: true, model: true }), SMALL_JSON_LIMIT_BYTES);
  const info = PROVIDER_INFO[input.provider];
  const apiKey = providerKey(input.provider);
  if (!apiKey) return c.json({ ok: false, keyConfigured: false, error: `Set ${info.keyVariables.join(" or ")} in the server's .env and restart it.` });
  try {
    const m = await modelInfo({
      api: input.provider === "anthropic" ? "anthropic" : "openai",
      provider: input.provider,
      apiKey,
      baseUrl: info.baseUrl,
      model: input.model,
      contextTokens: summarySettings().api.contextTokens,
      think: true,
      keepAliveSec: 0,
    });
    return c.json({ ok: true, keyConfigured: true, contextLength: m.contextLength, maxOutputTokens: m.maxOutputTokens ?? null });
  } catch (e) {
    if (e instanceof LlmError) return c.json({ ok: false, keyConfigured: true, error: e.message });
    throw e;
  }
});

adminRoutes.post("/summarizer/pull", async (c) => {
  const input = await body(c, probeSchema);
  try {
    return c.json({ pull: startPull(probeTarget(input)) }, 202);
  } catch (e) {
    if (e instanceof LlmError) httpError(409, e.message, "cannot_pull");
    throw e;
  }
});

// ------------------------------------------------------- transcription

function transcriberState() {
  return {
    settings: transcriberSettings(),
    defaults: defaultTranscriberSettings(),
    ...transcriberSettingsMeta(),
    // Each online worker says which providers it has a key for (never the key).
    workers: workerApiKeys(),
    keyVariables: ASR_KEY_VARIABLES,
    addresses: { openrouter: OPENROUTER_BASE_URL, openai: OPENAI_BASE_URL },
  };
}

adminRoutes.get("/transcriber", (c) => c.json(transcriberState()));

// Applies to every transcription a worker claims from now on, including those already queued.
adminRoutes.put("/transcriber", async (c) => {
  // A page loaded before speaker separation was a setting does not send it: keep what is set.
  const input = await body(c, transcriberSettingsSchema.partial({ diarization: true }));
  saveTranscriberSettings({ ...input, diarization: input.diarization ?? transcriberSettings().diarization }, c.get("user").id);
  return c.json(transcriberState());
});

adminRoutes.delete("/transcriber", (c) => {
  resetTranscriberSettings();
  return c.json(transcriberState());
});

// ------------------------------------------------------- storage

function mediaState() {
  return { settings: mediaSettings(), defaults: defaultMediaSettings(), ...mediaSettingsMeta(), stats: compactionStats() };
}

adminRoutes.get("/media", (c) => c.json(mediaState()));

adminRoutes.put("/media", async (c) => {
  const input = await body(c, mediaSettingsSchema);
  saveMediaSettings(input, c.get("user").id);
  // Start on what is already due rather than at the next sweep.
  enqueueCompactions();
  return c.json(mediaState());
});

adminRoutes.delete("/media", (c) => {
  resetMediaSettings();
  return c.json(mediaState());
});

// ------------------------------------------------------- workers on other machines

adminRoutes.get("/worker-keys", (c) => c.json({ keys: listWorkerKeys(), enrollTtlMs: ENROLL_TTL_MS }));

/** A new remote worker: its one-time enrollment code is in this answer only. */
adminRoutes.post("/worker-keys", async (c) => {
  const input = await body(c, z.object({ name: z.string().trim().min(1).max(60) }));
  const { key, code } = createWorkerKey(input.name, c.get("user").id);
  return c.json({ id: key.id, name: key.name, code, expiresAt: key.enroll_expires_at }, 201);
});

/** Revoke: the token stops working now, and that machine's running jobs go back to the queue. */
adminRoutes.delete("/worker-keys/:id", (c) => {
  const jobs = revokeWorkerKey(c.req.param("id"));
  if (jobs === null) httpError(404, "No such worker.", "not_found");
  deleteWorkerProfile(c.req.param("id"));
  requeueJobs(jobs!, "The worker's access was revoked.");
  return c.json({ ok: true, requeued: jobs!.length });
});

// ------------------------------------------------------- settings per worker machine

adminRoutes.get("/worker-profiles", (c) =>
  c.json({ profiles: listWorkerProfiles(), local: LOCAL_PROFILE, defaultFallbackSec: DEFAULT_FALLBACK_SEC }),
);

/** A machine's own choices ("local" or a remote worker's ID); null fields follow the site-wide settings. */
adminRoutes.put("/worker-profiles/:id", async (c) => {
  const id = c.req.param("id");
  if (id !== LOCAL_PROFILE && !getWorkerKey(id)) httpError(404, "No such worker.", "not_found");
  const input = await body(c, workerProfileSchema);
  return c.json({ profile: saveWorkerProfile(id, input, c.get("user").id) });
});

// ---------------------------------------------------------------- billing

/** Sign-up, rates, points on sale, packages; and whether email and ECPay are ready for them. */
adminRoutes.get("/billing", (c) => {
  const paid = db
    .query<{ mode: string; n: number; amount: number | null; points: number | null }, []>(
      "SELECT mode, COUNT(*) AS n, SUM(amount) AS amount, SUM(points) AS points FROM payment_orders WHERE status = 'paid' GROUP BY mode",
    )
    .all();
  const prepaid = db.query<{ n: number; credits: number | null }, []>("SELECT COUNT(*) AS n, SUM(credits) AS credits FROM users WHERE billing = 'prepaid'").get()!;
  return c.json({
    settings: billingSettings(),
    meta: billingSettingsMeta(),
    mail: publicMailInfo(),
    ecpay: publicEcpayInfo(),
    stats: {
      paid: paid.map((p) => ({ mode: p.mode, orders: p.n, amount: p.amount ?? 0, points: p.points ?? 0 })),
      prepaidAccounts: prepaid.n,
      // Thousandths of a point.
      outstanding: prepaid.credits ?? 0,
    },
  });
});

adminRoutes.put("/billing", async (c) => {
  const input = await body(c, billingSettingsSchema);
  saveBillingSettings(input, c.get("user").id);
  return c.json({ settings: billingSettings(), meta: billingSettingsMeta() });
});

adminRoutes.get("/terms", (c) => c.json({ markdown: termsText(), updatedAt: termsUpdatedAt() }));

adminRoutes.put("/terms", async (c) => {
  const input = await body(c, z.object({ markdown: z.string().max(TERMS_MAX) }));
  saveTerms(input.markdown, c.get("user").id);
  return c.json({ markdown: termsText(), updatedAt: termsUpdatedAt() });
});

adminRoutes.post("/mail/test", async (c) => {
  const input = await body(c, z.object({ to: z.email().max(254) }), SMALL_JSON_LIMIT_BYTES);
  try {
    await sendMail(testMail(input.to, mailLocale(c.get("user").locale)));
  } catch (e) {
    if (e instanceof MailError) httpError(503, `Could not send: ${e.message}`, "mail_failed");
    throw e;
  }
  return c.json({ ok: true });
});

adminRoutes.get("/orders", (c) => {
  const status = c.req.query("status");
  const rows = db
    .query<OrderRow & { username: string | null; display_name: string | null }, { s: string }>(
      `SELECT o.*, u.username, u.display_name FROM payment_orders o LEFT JOIN users u ON u.id = o.user_id
       WHERE $s = '' OR o.status = $s ORDER BY o.created_at DESC LIMIT 200`,
    )
    .all({ s: status && ["pending", "paid", "failed"].includes(status) ? status : "" });
  return c.json({ orders: rows.map((o) => ({ ...publicOrder(o), user: o.user_id ? { id: o.user_id, username: o.username, displayName: o.display_name } : null })) });
});

adminRoutes.post("/orders/:id/refresh", async (c) => {
  const order = getOrder(c.req.param("id"));
  if (!order) httpError(404, "Order not found.", "not_found");
  try {
    await queryOrder(order);
  } catch (e) {
    httpError(503, `ECPay could not be asked: ${e instanceof Error ? e.message : e}`, "payment_unreachable");
  }
  return c.json({ order: publicOrder(getOrder(order.id)!) });
});

adminRoutes.get("/users/:id/credits", (c) => {
  const target = findUserById(c.req.param("id"));
  if (!target) httpError(404, "User not found.", "not_found");
  return c.json({ balance: target.credits, ledger: ledger(target.id, 200).map(publicLedgerEntry) });
});

/** Add or take away points by hand (a refund made in ECPay's back office, a gift, a correction). */
adminRoutes.post("/users/:id/credits", async (c) => {
  const target = findUserById(c.req.param("id"));
  if (!target) httpError(404, "User not found.", "not_found");
  const input = await body(
    c,
    // Points, to a thousandth.
    z.object({ points: z.number().min(-1_000_000).max(1_000_000).refine((n) => Math.round(n * MILLI) !== 0), note: z.string().trim().min(1).max(200) }),
    SMALL_JSON_LIMIT_BYTES,
  );
  const balance = db.transaction(() => addCredits(target.id, Math.round(input.points * MILLI), { kind: "adjust", note: input.note, createdBy: c.get("user").id }))();
  return c.json({ balance, user: publicUser(findUserById(target.id)!) });
});

// --------------------------------------------------------------- security

adminRoutes.get("/security", (c) => {
  return c.json({
    ...securityOverview(),
    settings: securitySettings(),
    defaults: defaultSecuritySettings(),
    meta: securitySettingsMeta(),
    alerts: publicAlertInfo(),
    // The address this administrator is using, so they do not block themselves.
    yourIp: normalizeIp(c.get("clientIp")),
    trustProxy: config.trustProxy,
  });
});

adminRoutes.get("/security/events", (c) => {
  const kind = c.req.query("kind") ?? "";
  if (kind && !(kind in EVENT_KINDS)) httpError(422, "Unknown event kind.", "invalid_input");
  return c.json({ events: recentEvents({ kind, ip: c.req.query("ip") ?? "", limit: Number(c.req.query("limit") ?? 100) || 100 }) });
});

adminRoutes.put("/security", async (c) => {
  const input = await body(c, securitySettingsSchema, SMALL_JSON_LIMIT_BYTES);
  try {
    saveSecuritySettings(input, c.get("user").id);
  } catch (e) {
    httpError(422, e instanceof Error ? e.message : String(e), "invalid_input");
  }
  return c.json({ settings: securitySettings(), meta: securitySettingsMeta() });
});

adminRoutes.post("/security/blocks", async (c) => {
  const input = await body(
    c,
    z.object({ ip: z.string().trim().max(64), minutes: z.number().int().min(5).max(525_600).nullable(), reason: z.string().trim().max(200).default("") }),
    SMALL_JSON_LIMIT_BYTES,
  );
  const ip = normalizeIp(input.ip);
  if (!isIP(ip)) httpError(422, "Enter an IP address.", "invalid_input");
  if (ip === normalizeIp(c.get("clientIp"))) httpError(409, "That is the address you are using now.", "self");
  blockIp(ip, { reason: input.reason || `Blocked by ${c.get("user").username}`, minutes: input.minutes, auto: false, by: c.get("user").id });
  return c.json({ ok: true });
});

adminRoutes.delete("/security/blocks/:ip", (c) => {
  if (!unblockIp(decodeURIComponent(c.req.param("ip")))) httpError(404, "That address is not blocked.", "not_found");
  return c.json({ ok: true });
});
