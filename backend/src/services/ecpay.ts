import { timingSafeEqual } from "node:crypto";
import { config } from "../config";
import { db, now } from "../db";
import { parseJson } from "../lib/util";
import { findUserById } from "../auth/service";
import { MILLI, addCredits } from "./credits";
import { billingSettings, PAYMENT_METHODS, type CreditPackage } from "./billingSettings";
import { mailLocale, receiptMail, sendMailLater } from "./mail";

/**
 * ECPay (綠界) all-in-one checkout (全方位金流 AioCheckOut V5).
 *
 * 1. The server records an order and gives the browser a form to post to
 *    ECPay, signed with the shop's HashKey and HashIV (CheckMacValue).
 * 2. The person pays on ECPay's page: card, ATM transfer or a convenience-store code.
 * 3. ECPay tells the server, machine to machine (ReturnURL), when money has
 *    been received. Only a notification whose signature, shop and amount check
 *    out adds points, and an order adds them once however often it is reported.
 *    For ATM and store payments ECPay first sends the account or code to pay to
 *    (PaymentInfoURL); the money comes days later, in another notification.
 * 4. The browser comes back (OrderResultURL) with the same signed result, which
 *    is applied the same way, in case it arrives before the notification.
 * If a notification never arrives (the site was down), the order page asks
 * ECPay (QueryTradeInfo).
 */

const HOSTS = { stage: "https://payment-stage.ecpay.com.tw", production: "https://payment.ecpay.com.tw" } as const;
/** All ways ECPay knows to pay with: what is not chosen is hidden from its page. */
const ALL_METHODS = ["Credit", "WebATM", "ATM", "CVS", "BARCODE", "ApplePay", "TWQR", "BNPL"];

export interface OrderRow {
  id: string;
  user_id: string | null;
  package_id: string;
  points: number;
  amount: number;
  item_name: string;
  status: "pending" | "paid" | "failed";
  mode: "stage" | "production";
  merchant_id: string;
  trade_no: string | null;
  payment_type: string | null;
  payment_info: string | null;
  error: string | null;
  created_at: number;
  updated_at: number;
  paid_at: number | null;
  /** When the buyer agreed to the terms (and to delivery at once), and which version (the terms' save time). */
  terms_accepted_at: number | null;
  terms_version: number | null;
}

/** ECPay's URL encoding: .NET's HttpUtility.UrlEncode, lower-cased. */
function dotNetEncode(s: string): string {
  return encodeURIComponent(s).replace(/'/g, "%27").replace(/~/g, "%7e").replace(/%20/g, "+").toLowerCase();
}

/**
 * CheckMacValue: the fields sorted by name (ignoring case), between HashKey and
 * HashIV, URL-encoded the .NET way, lower-cased, SHA-256, upper-cased.
 */
export function checkMacValue(fields: Record<string, string>, hashKey = config.ecpay.hashKey, hashIv = config.ecpay.hashIv): string {
  const keys = Object.keys(fields)
    .filter((k) => k !== "CheckMacValue")
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const raw = `HashKey=${hashKey}&${keys.map((k) => `${k}=${fields[k]}`).join("&")}&HashIV=${hashIv}`;
  return new Bun.CryptoHasher("sha256").update(dotNetEncode(raw)).digest("hex").toUpperCase();
}

/** Whether fields ECPay sent carry a valid signature from this shop. */
export function verifyFields(fields: Record<string, string>): boolean {
  const given = fields.CheckMacValue ?? "";
  if (!/^[0-9A-Fa-f]{64}$/.test(given) || fields.MerchantID !== config.ecpay.merchantId) return false;
  const expected = checkMacValue(fields);
  return timingSafeEqual(Buffer.from(given.toUpperCase()), Buffer.from(expected));
}

/** "2026/11/26 14:05:09" in Taiwan time, as ECPay wants MerchantTradeDate. */
export function taipeiTime(ms: number): string {
  const d = new Date(ms + 8 * 3600_000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** 20 characters, letters and digits: "MM" and 18 random ones (ECPay allows ^\w{4,20}$). */
function orderId(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return "MM" + Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

export function getOrder(id: string): OrderRow | null {
  return db.query<OrderRow, { id: string }>("SELECT * FROM payment_orders WHERE id = $id").get({ id });
}

/** Where ECPay sends people and notifications: PUBLIC_URL, else the address the request came to. */
export function siteBase(requestUrl: string): string {
  return config.publicUrl || new URL(requestUrl).origin;
}

export function createOrder(userId: string, pkg: CreditPackage, locale: "en" | "zh-TW", terms: { version: number | null } | null = null): OrderRow {
  const id = orderId();
  const t = now();
  // Shown on ECPay's page and on card statements (at most 200 characters, no # which ECPay uses to separate items).
  const itemName = locale === "en" ? `Meeting Minutes ${pkg.points} points` : `會議紀錄點數 ${pkg.points} 點`;
  db.query(
    `INSERT INTO payment_orders (id, user_id, package_id, points, amount, item_name, status, mode, merchant_id, created_at, updated_at, terms_accepted_at, terms_version)
     VALUES ($id, $u, $p, $m, $a, $name, 'pending', $mode, $mid, $t, $t, $ta, $tv)`,
  ).run({
    id,
    u: userId,
    p: pkg.id,
    m: pkg.points,
    a: pkg.price,
    name: itemName,
    mode: config.ecpay.mode,
    mid: config.ecpay.merchantId,
    t,
    ta: terms ? t : null,
    tv: terms?.version ?? null,
  });
  return getOrder(id)!;
}

/** The form the browser posts to ECPay to pay for `order`. */
export function checkoutForm(order: OrderRow, base: string): { action: string; fields: Record<string, string> } {
  const methods = billingSettings().methods;
  const fields: Record<string, string> = {
    MerchantID: config.ecpay.merchantId,
    MerchantTradeNo: order.id,
    MerchantTradeDate: taipeiTime(order.created_at),
    PaymentType: "aio",
    TotalAmount: String(order.amount),
    TradeDesc: "Meeting Minutes",
    ItemName: order.item_name,
    ReturnURL: `${base}/api/billing/ecpay/notify`,
    OrderResultURL: `${base}/api/billing/ecpay/result`,
    ClientBackURL: `${base}/billing?order=${order.id}`,
    PaymentInfoURL: `${base}/api/billing/ecpay/info`,
    ChoosePayment: methods.length === 1 ? methods[0]! : "ALL",
    EncryptType: "1",
    NeedExtraPaidInfo: "N",
  };
  if (methods.length > 1) {
    const ignore = ALL_METHODS.filter((m) => !methods.includes(m as (typeof PAYMENT_METHODS)[number]));
    if (ignore.length) fields.IgnorePayment = ignore.join("#");
  }
  fields.CheckMacValue = checkMacValue(fields);
  return { action: `${HOSTS[config.ecpay.mode]}/Cashier/AioCheckOut/V5`, fields };
}

export type ApplyOutcome = "paid" | "already_paid" | "pending" | "failed" | "ignored";

/**
 * Apply a signed result from ECPay (notification, browser return, or query).
 * Adds the order's points the first time it is reported paid.
 */
export function applyResult(fields: Record<string, string>, source: "notify" | "result" | "query", base: string | null = config.publicUrl || null): { outcome: ApplyOutcome; order: OrderRow | null; reason?: string } {
  const order = getOrder(fields.MerchantTradeNo ?? "");
  if (!order) return { outcome: "ignored", order: null, reason: "unknown order" };
  if (order.merchant_id !== config.ecpay.merchantId) return { outcome: "ignored", order, reason: "another shop's order" };
  // A query reports TradeStatus 1 for paid; notifications RtnCode 1.
  const paid = source === "query" ? fields.TradeStatus === "1" : fields.RtnCode === "1";
  const amount = Number(source === "query" ? fields.TradeAmt : (fields.TradeAmt ?? fields.TotalAmount));
  if (paid && amount !== order.amount) {
    console.error(`[ecpay] order ${order.id}: paid NT$${amount}, expected NT$${order.amount}; not adding points`);
    return { outcome: "ignored", order, reason: "amount mismatch" };
  }
  // ECPay's test back office can "simulate" a payment; on a real shop that is not money.
  if (paid && fields.SimulatePaid === "1" && order.mode === "production") {
    console.warn(`[ecpay] order ${order.id}: a simulated payment on the production shop; not adding points`);
    return { outcome: "ignored", order, reason: "simulated payment" };
  }
  const t = now();
  if (!paid) {
    // Card declined and the like. (ATM and store codes come to PaymentInfoURL, not here.)
    if (source === "notify" && order.status === "pending") {
      db.query("UPDATE payment_orders SET status = 'failed', error = $e, trade_no = COALESCE($tn, trade_no), updated_at = $t WHERE id = $id AND status = 'pending'").run({
        id: order.id,
        e: `${fields.RtnCode ?? ""} ${fields.RtnMsg ?? ""}`.trim().slice(0, 300) || "failed",
        tn: fields.TradeNo ?? null,
        t,
      });
      return { outcome: "failed", order: getOrder(order.id) };
    }
    return { outcome: order.status === "paid" ? "already_paid" : "pending", order };
  }
  let balance: number | null = null;
  const credited = db.transaction(() => {
    // Paid wins over an earlier failure (a second card attempt on ECPay's page).
    const res = db
      .query(
        `UPDATE payment_orders SET status = 'paid', paid_at = $t, updated_at = $t, error = NULL,
           trade_no = COALESCE($tn, trade_no), payment_type = COALESCE($pt, payment_type) WHERE id = $id AND status != 'paid'`,
      )
      .run({ id: order.id, t, tn: fields.TradeNo ?? null, pt: fields.PaymentType ?? null });
    if (res.changes === 0) return false;
    if (order.user_id) {
      balance = addCredits(order.user_id, order.points * MILLI, { kind: "purchase", orderId: order.id, note: `NT$${order.amount}` });
    }
    return true;
  })();
  const updated = getOrder(order.id)!;
  if (!credited) return { outcome: "already_paid", order: updated };
  console.log(`[ecpay] order ${order.id} paid (${source}): +${order.points} points for user ${order.user_id ?? "(deleted)"}`);
  const user = order.user_id ? findUserById(order.user_id) : null;
  if (user?.email && balance != null && base) {
    sendMailLater(receiptMail(user.email, mailLocale(user.locale), { id: order.id, points: order.points, amount: order.amount, method: updated.payment_type }, Math.floor(balance / MILLI), `${base}/billing`));
  }
  return { outcome: "paid", order: updated };
}

/** ATM account / store code to pay to, from PaymentInfoURL. */
export function applyPaymentInfo(fields: Record<string, string>): boolean {
  const order = getOrder(fields.MerchantTradeNo ?? "");
  if (!order || order.status === "paid") return !!order;
  // 2: ATM account issued; 10100073: convenience-store code issued.
  const ok = fields.RtnCode === "2" || fields.RtnCode === "10100073";
  const info = ok
    ? {
        paymentType: fields.PaymentType ?? null,
        bankCode: fields.BankCode || null,
        account: fields.vAccount || null,
        paymentNo: fields.PaymentNo || null,
        expireDate: fields.ExpireDate || null,
      }
    : null;
  db.query(
    `UPDATE payment_orders SET payment_info = COALESCE($info, payment_info), payment_type = COALESCE($pt, payment_type),
       trade_no = COALESCE($tn, trade_no), error = $e, updated_at = $t WHERE id = $id`,
  ).run({
    id: order.id,
    info: info ? JSON.stringify(info) : null,
    pt: fields.PaymentType ?? null,
    tn: fields.TradeNo ?? null,
    e: ok ? null : `${fields.RtnCode ?? ""} ${fields.RtnMsg ?? ""}`.trim().slice(0, 300),
    t: now(),
  });
  return true;
}

/** Ask ECPay how an order stands (when its notification may have been missed), and apply the answer. */
export async function queryOrder(order: OrderRow, base: string | null = config.publicUrl || null): Promise<ApplyOutcome> {
  const fields: Record<string, string> = {
    MerchantID: config.ecpay.merchantId,
    MerchantTradeNo: order.id,
    TimeStamp: String(Math.floor(Date.now() / 1000)),
  };
  fields.CheckMacValue = checkMacValue(fields);
  const res = await fetch(`${HOSTS[order.mode]}/Cashier/QueryTradeInfo/V5`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`ECPay answered ${res.status}.`);
  const answer = Object.fromEntries(new URLSearchParams(await res.text()));
  if (!verifyFields(answer)) throw new Error("ECPay's answer did not carry a valid signature.");
  return applyResult(answer, "query", base).outcome;
}

export function publicOrder(o: OrderRow) {
  return {
    id: o.id,
    packageId: o.package_id,
    points: o.points,
    amount: o.amount,
    itemName: o.item_name,
    status: o.status,
    mode: o.mode,
    paymentType: o.payment_type,
    paymentInfo: parseJson<Record<string, string | null> | null>(o.payment_info, null),
    error: o.error,
    createdAt: o.created_at,
    paidAt: o.paid_at,
    termsAcceptedAt: o.terms_accepted_at,
  };
}

/** For the admin page: which shop, test or real, never the keys. */
export function publicEcpayInfo() {
  return { mode: config.ecpay.mode, merchantId: config.ecpay.merchantId, testShop: config.ecpay.testShop, publicUrl: config.publicUrl || null };
}
