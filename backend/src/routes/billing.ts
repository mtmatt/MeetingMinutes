import { Hono } from "hono";
import { z } from "zod";
import { config } from "../config";
import { requireUser } from "../auth/middleware";
import { RateLimiter } from "../auth/ratelimit";
import { db } from "../db";
import { httpError } from "../lib/util";
import { availableSec, heldSec, ledger, publicLedgerEntry } from "../services/credits";
import { billingSettings } from "../services/billingSettings";
import {
  applyPaymentInfo,
  applyResult,
  checkoutForm,
  createOrder,
  getOrder,
  publicOrder,
  queryOrder,
  siteBase,
  verifyFields,
  type OrderRow,
} from "../services/ecpay";
import { mailLocale } from "../services/mail";
import type { AppEnv } from "../types";
import { SMALL_JSON_LIMIT_BYTES, body } from "./validate";

/** Orders started per person: a page cannot be used to fill the table. */
const orderLimiter = new RateLimiter(20, 60 * 60 * 1000);
/** Asking ECPay about an order, per person. */
const queryLimiter = new RateLimiter(30, 60 * 60 * 1000);

/** Minutes are on sale. (ECPay must be able to reach the site: the admin page says so when PUBLIC_URL is not set.) */
export function billingOpen(): boolean {
  return billingSettings().enabled;
}

export const billingRoutes = new Hono<AppEnv>();
billingRoutes.use(requireUser);

/** The person's balance, what is for sale, and their purchases and usage. */
billingRoutes.get("/", (c) => {
  const user = c.get("user");
  const s = billingSettings();
  const orders = db
    .query<OrderRow, { u: string }>("SELECT * FROM payment_orders WHERE user_id = $u ORDER BY created_at DESC LIMIT 30")
    .all({ u: user.id });
  return c.json({
    billing: user.billing,
    balanceSec: user.credit_sec,
    heldSec: heldSec(user.id),
    availableSec: user.billing === "prepaid" ? availableSec(user.id) : null,
    onSale: billingOpen(),
    // ECPay's test system: nothing is really charged.
    testMode: config.ecpay.mode === "stage",
    packages: s.packages,
    methods: s.methods,
    termsUrl: s.termsUrl || null,
    orders: orders.map(publicOrder),
    ledger: ledger(user.id, 100).map(publicLedgerEntry),
  });
});

/** Start buying a package: the order, and the signed form the browser posts to ECPay. */
billingRoutes.post("/orders", async (c) => {
  const user = c.get("user");
  if (!billingOpen()) httpError(409, "Minutes are not on sale on this site.", "billing_closed");
  if (user.billing !== "prepaid") httpError(409, "This account is not charged for transcription.", "not_prepaid");
  const input = await body(c, z.object({ packageId: z.string().max(40), locale: z.enum(["en", "zh-TW"]).nullable().default(null) }), SMALL_JSON_LIMIT_BYTES);
  const pkg = billingSettings().packages.find((p) => p.id === input.packageId);
  if (!pkg) httpError(404, "That package is no longer offered.", "not_found");
  const retry = orderLimiter.check(user.id);
  if (retry) httpError(429, `Too many orders. Try again in ${Math.ceil(retry / 60)} min.`, "rate_limited");
  orderLimiter.hit(user.id);
  const order = createOrder(user.id, pkg, mailLocale(input.locale ?? user.locale));
  return c.json({ order: publicOrder(order), checkout: checkoutForm(order, siteBase(c.req.url)) }, 201);
});

function ownOrder(c: any): OrderRow {
  const order = getOrder(c.req.param("id"));
  if (!order || order.user_id !== c.get("user").id) httpError(404, "Order not found.", "not_found");
  return order;
}

billingRoutes.get("/orders/:id", (c) => c.json({ order: publicOrder(ownOrder(c)) }));

/** Ask ECPay how an unpaid order stands (if its notification never reached the site). */
billingRoutes.post("/orders/:id/refresh", async (c) => {
  const order = ownOrder(c);
  if (order.status !== "paid") {
    const retry = queryLimiter.check(c.get("user").id);
    if (retry) httpError(429, `Too many checks. Try again in ${Math.ceil(retry / 60)} min.`, "rate_limited");
    queryLimiter.hit(c.get("user").id);
    try {
      await queryOrder(order, siteBase(c.req.url));
    } catch (e) {
      console.warn(`[ecpay] could not query order ${order.id}:`, e);
      httpError(503, "ECPay could not be reached. Try again later.", "payment_unreachable");
    }
  }
  return c.json({ order: publicOrder(getOrder(order.id)!) });
});

// ------------------------------------------------------------- from ECPay

/**
 * What ECPay sends: form posts from its servers (notifications) and from
 * people's browsers coming back after paying. No session or client header can
 * come with them; their signature (CheckMacValue) is what is trusted. Mounted
 * outside /api's CSRF check.
 */
export const ecpayRoutes = new Hono<AppEnv>();

const MAX_FORM_BYTES = 16 * 1024;

async function signedForm(c: any): Promise<Record<string, string> | null> {
  const length = Number(c.req.header("content-length") ?? 0);
  if (length > MAX_FORM_BYTES) return null;
  const text = await c.req.text();
  if (text.length > MAX_FORM_BYTES) return null;
  const fields = Object.fromEntries(new URLSearchParams(text));
  return verifyFields(fields) ? fields : null;
}

/** ECPay wants exactly "1|OK" back, or it retries. */
const ok = (c: any) => c.text("1|OK", 200, { "Cache-Control": "no-store" });
const refused = (c: any, why: string) => c.text(`0|${why}`, 400, { "Cache-Control": "no-store" });

/** ReturnURL: the payment result, machine to machine. */
ecpayRoutes.post("/notify", async (c) => {
  const fields = await signedForm(c);
  if (!fields) {
    console.warn(`[ecpay] notification with a bad signature from ${c.get("clientIp")}`);
    return refused(c, "CheckMacValue Error");
  }
  applyResult(fields, "notify", siteBase(c.req.url));
  return ok(c);
});

/** PaymentInfoURL: the ATM account or store code a person is to pay to. */
ecpayRoutes.post("/info", async (c) => {
  const fields = await signedForm(c);
  if (!fields) {
    console.warn(`[ecpay] payment info with a bad signature from ${c.get("clientIp")}`);
    return refused(c, "CheckMacValue Error");
  }
  applyPaymentInfo(fields);
  return ok(c);
});

/** OrderResultURL: the person's browser, back from ECPay's page. Sent on to the order. */
ecpayRoutes.post("/result", async (c) => {
  const fields = await signedForm(c);
  const id = fields?.MerchantTradeNo;
  if (fields) applyResult(fields, "result", siteBase(c.req.url));
  return c.redirect(id && /^\w{4,20}$/.test(id) ? `/billing?order=${encodeURIComponent(id)}` : "/billing", 303);
});
