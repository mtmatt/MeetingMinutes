import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { config } from "../src/config";
import { db } from "../src/db";
import { checkMacValue, taipeiTime } from "../src/services/ecpay";
import { outbox } from "../src/services/mail";
import { mailIpLimiter, registerLimiter } from "../src/auth/ratelimit";
import { Client, adminClient, memberClient, waitFor, worker } from "./helpers";

const PASSWORD = "a long enough password";

// Links in mail need the site's own address (never the Host a request names).
const mutable = config as { publicUrl: string };
const publicUrlBefore = mutable.publicUrl;
beforeAll(() => {
  mutable.publicUrl = "http://mm.test";
});
afterAll(() => {
  mutable.publicUrl = publicUrlBefore;
});

async function openSignUp(extra: Record<string, unknown> = {}) {
  const admin = await adminClient();
  const res = await admin.req("PUT", "/api/admin/billing", {
    json: {
      registrationOpen: true,
      enabled: true,
      // A point a minute of recording; a tenth of a point per thousand tokens read, half a point per thousand written.
      rates: { perMinute: 1, perKInput: 0.1, perKOutput: 0.5 },
      packages: [
        { id: "m60", points: 60, price: 150 },
        { id: "m300", points: 300, price: 600 },
      ],
      methods: ["Credit", "ATM", "CVS"],
      termsUrl: "",
      ...extra,
    },
  });
  expect(res.status).toBe(200);
  return admin;
}

function lastMailTo(to: string) {
  const m = [...outbox].reverse().find((x) => x.to === to);
  if (!m) throw new Error(`no mail to ${to}`);
  return m;
}

/** A confirmed, signed-in prepaid account. */
async function signedUp(username: string): Promise<Client> {
  await openSignUp();
  // Every test request comes from one address; the per-address limits are tested on their own.
  registerLimiter.reset("unknown");
  mailIpLimiter.reset("unknown");
  const email = `${username}@example.com`;
  const c = new Client();
  const reg = await c.post("/api/auth/register", { username, displayName: username, email, password: PASSWORD, locale: "en" });
  expect(reg.status).toBe(200);
  const token = lastMailTo(email).text.match(/\/verify-email\/([\w-]+)/)![1];
  expect((await c.post("/api/auth/verify-email", { token })).status).toBe(200);
  expect((await c.post("/api/auth/login", { username, password: PASSWORD })).status).toBe(200);
  return c;
}

/** What ECPay posts back, signed with the shop's keys. */
function ecpayForm(fields: Record<string, string>): string {
  const all = { MerchantID: "3002607", ...fields };
  return new URLSearchParams({ ...all, CheckMacValue: checkMacValue(all) }).toString();
}

async function postEcpay(path: string, form: string) {
  const c = new Client();
  // No session and no client header: as ECPay's servers send it.
  return c.req("POST", `/api/billing/ecpay/${path}`, { body: form, headers: { "content-type": "application/x-www-form-urlencoded" }, csrf: false });
}

async function buy(c: Client, packageId = "m60") {
  const res = await c.post("/api/billing/orders", { packageId });
  expect(res.status).toBe(201);
  return (await res.json()) as { order: { id: string; amount: number; points: number }; checkout: { action: string; fields: Record<string, string> } };
}

const paid = (id: string, amount: number, extra: Record<string, string> = {}) =>
  ecpayForm({ MerchantTradeNo: id, RtnCode: "1", RtnMsg: "交易成功", TradeAmt: String(amount), TradeNo: "2611261405091234", PaymentType: "Credit_CreditCard", SimulatePaid: "0", ...extra });

describe("CheckMacValue", () => {
  test("matches ECPay's published example", () => {
    const fields = {
      ChoosePayment: "ALL",
      EncryptType: "1",
      ItemName: "Apple iphone 15",
      MerchantID: "3002607",
      MerchantTradeDate: "2023/03/12 15:30:23",
      MerchantTradeNo: "ecpay20230312153023",
      PaymentType: "aio",
      ReturnURL: "https://www.ecpay.com.tw/receive.php",
      TotalAmount: "30000",
      TradeDesc: "促銷方案",
    };
    expect(checkMacValue(fields, "pwFHCqoQZGmho4w6", "EkRm7iFT261dpevs")).toBe("6C51C9E6888DE861FD62FB1DD17029FC742634498FD813DC43D4243B5685B840");
    expect(taipeiTime(Date.UTC(2026, 10, 25, 18, 5, 9))).toBe("2026/11/26 02:05:09");
  });
});

describe("signing up", () => {
  test("is closed until the admin opens it", async () => {
    const admin = await adminClient();
    await admin.req("PUT", "/api/admin/billing", { json: { registrationOpen: false, enabled: false, packages: [], methods: ["Credit"], termsUrl: "" } });
    const state = (await (await new Client().get("/api/auth/state")).json()) as any;
    expect(state.registration).toBe(false);
    expect(state.passwordReset).toBe(true);
    const res = await new Client().post("/api/auth/register", { username: "nobody", displayName: "N", email: "n@example.com", password: PASSWORD });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).code).toBe("registration_closed");
  });

  test("needs the email address confirmed before signing in, and the account pays with minutes", async () => {
    await openSignUp();
    expect(((await (await new Client().get("/api/auth/state")).json()) as any).registration).toBe(true);
    const c = new Client();
    const bad = await c.post("/api/auth/register", { username: "rita", displayName: "Rita", email: "not-an-address", password: PASSWORD });
    expect(bad.status).toBe(422);
    expect((await c.post("/api/auth/register", { username: "rita", displayName: "Rita", email: "Rita@Example.com", password: PASSWORD, locale: "zh-TW" })).status).toBe(200);
    const mail = lastMailTo("rita@example.com");
    expect(mail.subject).toContain("請確認你的 Email");
    // Not before the address is confirmed.
    const early = await c.post("/api/auth/login", { username: "rita", password: PASSWORD });
    expect(early.status).toBe(403);
    expect(((await early.json()) as any).code).toBe("email_unverified");
    const token = mail.text.match(/\/verify-email\/([\w-]+)/)![1]!;
    const verified = await c.post("/api/auth/verify-email", { token });
    expect(verified.status).toBe(200);
    // The link works once, and does not sign anyone in by itself.
    expect(c.cookie).toBe("");
    expect((await c.post("/api/auth/verify-email", { token })).status).toBe(404);
    expect((await c.post("/api/auth/login", { username: "rita", password: PASSWORD })).status).toBe(200);
    const me = (await (await c.get("/api/me")).json()) as any;
    expect(me.user).toMatchObject({ email: "rita@example.com", emailVerified: true, billing: "prepaid", credits: 0, role: "member" });
  });

  test("with an address that has an account looks the same, and tells its owner", async () => {
    await signedUp("owner1");
    const before = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users").get()!.n;
    const res = await new Client().post("/api/auth/register", { username: "someone-else", displayName: "X", email: "OWNER1@example.com", password: PASSWORD, locale: "en" });
    expect(res.status).toBe(200);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM users").get()!.n).toBe(before);
    expect(lastMailTo("owner1@example.com").subject).toContain("you already have an account");
  });

  test("a forgotten password is reset through a link sent to the confirmed address", async () => {
    await signedUp("forgetful");
    expect((await new Client().post("/api/auth/forgot-password", { email: "nobody-here@example.com" })).status).toBe(200);
    expect((await new Client().post("/api/auth/forgot-password", { email: "forgetful@example.com", locale: "en" })).status).toBe(200);
    const token = lastMailTo("forgetful@example.com").text.match(/\/invite\/([\w-]+)/)![1]!;
    const c = new Client();
    expect((await c.post(`/api/auth/invites/${token}/accept`, { password: "a brand new password" })).status).toBe(200);
    expect((await new Client().post("/api/auth/login", { username: "forgetful", password: "a brand new password" })).status).toBe(200);
  });

  test("trying names that are taken counts against the sign-up limit, so accounts cannot be listed freely", async () => {
    await openSignUp();
    registerLimiter.reset("unknown");
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      const res = await new Client().post("/api/auth/register", { username: "admin", displayName: "x", email: `probe${i}@example.com`, password: PASSWORD });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 409)).toBe(true);
    expect(statuses[10]).toBe(429);
    registerLimiter.reset("unknown");
  });

  test("a confirmation mail does not carry the name typed at sign-up, and only its own link is clickable", async () => {
    await openSignUp();
    registerLimiter.reset("unknown");
    mailIpLimiter.reset("unknown");
    const email = "named@example.com";
    const res = await new Client().post("/api/auth/register", {
      username: "named-one",
      displayName: "Your account is locked. Sign in at https://evil.example/login",
      email,
      password: PASSWORD,
      locale: "en",
    });
    expect(res.status).toBe(200);
    const mail = lastMailTo(email);
    expect(mail.text).not.toContain("evil.example");
    expect(mail.links).toHaveLength(1);
    expect(mail.links![0]).toStartWith("http://mm.test/verify-email/");
  });

  test("mail to one address is rate limited", async () => {
    let last = 0;
    for (let i = 0; i < 4; i++) last = (await new Client().post("/api/auth/verify-email/resend", { email: "flood@example.com" })).status;
    expect(last).toBe(429);
  });
});

describe("the public price list", () => {
  test("anyone can read the packages and rates in NT$, without signing in, and nothing private comes with them", async () => {
    await openSignUp({ noExpiry: true });
    const res = await new Client().get("/api/auth/pricing");
    expect(res.status).toBe(200);
    const p = (await res.json()) as Record<string, unknown>;
    expect(p.onSale).toBe(true);
    expect(p.currency).toBe("TWD");
    expect(p.packages).toEqual([
      { id: "m60", points: 60, price: 150 },
      { id: "m300", points: 300, price: 600 },
    ]);
    expect(p.rates).toEqual({ perMinute: 1, perKInput: 0.1, perKOutput: 0.5 });
    expect(p.noExpiry).toBe(true);
    expect(Object.keys(p).sort()).toEqual(["contact", "currency", "methods", "noExpiry", "onSale", "packages", "rates", "termsUrl"]);
  });

  test("packages show before the sale opens, marked as not on sale", async () => {
    await openSignUp({ enabled: false });
    const p = (await (await new Client().get("/api/auth/pricing")).json()) as { onSale: boolean; packages: unknown[] };
    expect(p.onSale).toBe(false);
    expect(p.packages.length).toBe(2);
    await openSignUp();
  });
});

describe("buying minutes", () => {
  test("an order is a signed form for ECPay's test shop, and a paid notification adds its minutes once", async () => {
    const c = await signedUp("buyer");
    const info = (await (await c.get("/api/billing")).json()) as any;
    expect(info).toMatchObject({ billing: "prepaid", balance: 0, onSale: true, rates: { perMinute: 1, perKInput: 0.1, perKOutput: 0.5 } });
    expect(info.packages.map((p: any) => p.id)).toEqual(["m60", "m300"]);

    const { order, checkout } = await buy(c);
    expect(checkout.action).toBe("https://payment-stage.ecpay.com.tw/Cashier/AioCheckOut/V5");
    expect(checkout.fields).toMatchObject({ MerchantID: "3002607", MerchantTradeNo: order.id, TotalAmount: "150", ChoosePayment: "ALL", EncryptType: "1", PaymentType: "aio" });
    expect(checkout.fields.IgnorePayment!.split("#")).not.toContain("Credit");
    expect(checkout.fields.ReturnURL).toBe("http://mm.test/api/billing/ecpay/notify");
    expect(order.id).toMatch(/^MM\w{18}$/);
    const { CheckMacValue, ...signed } = checkout.fields;
    expect(CheckMacValue).toBe(checkMacValue(signed));

    // A forged notification is refused.
    const forged = new URLSearchParams({ MerchantID: "3002607", MerchantTradeNo: order.id, RtnCode: "1", TradeAmt: "150", CheckMacValue: "0".repeat(64) }).toString();
    const refused = await postEcpay("notify", forged);
    expect(refused.status).toBe(400);
    expect(await refused.text()).toBe("0|CheckMacValue Error");
    // The amount must be the order's.
    expect(await (await postEcpay("notify", paid(order.id, 1))).text()).toBe("1|OK");
    expect(((await (await c.get("/api/me")).json()) as any).user.credits).toBe(0);

    const res = await postEcpay("notify", paid(order.id, 150));
    expect(await res.text()).toBe("1|OK");
    // ECPay retries, and the browser comes back with the same result: still once.
    await postEcpay("notify", paid(order.id, 150));
    const back = await postEcpay("result", paid(order.id, 150));
    expect(back.status).toBe(303);
    expect(back.headers.get("location")).toBe(`/billing?order=${order.id}`);
    const after = (await (await c.get("/api/billing")).json()) as any;
    expect(after.balance).toBe(60_000);
    expect(after.orders[0]).toMatchObject({ id: order.id, status: "paid", paymentType: "Credit_CreditCard" });
    expect(after.ledger.filter((e: any) => e.kind === "purchase")).toHaveLength(1);
    expect(lastMailTo("buyer@example.com").subject).toContain("payment received (60 points)");
  });

  test("ATM transfers show the account to pay to until the money arrives", async () => {
    const c = await signedUp("atm-buyer");
    const { order } = await buy(c, "m300");
    const info = ecpayForm({ MerchantTradeNo: order.id, RtnCode: "2", RtnMsg: "Get VirtualAccount Succeeded", PaymentType: "ATM_TAISHIN", TradeAmt: "600", BankCode: "812", vAccount: "9103522175887271", ExpireDate: "2026/11/29" });
    expect(await (await postEcpay("info", info)).text()).toBe("1|OK");
    const pending = (await (await c.get(`/api/billing/orders/${order.id}`)).json()) as any;
    expect(pending.order).toMatchObject({ status: "pending", paymentInfo: { bankCode: "812", account: "9103522175887271", expireDate: "2026/11/29" } });
    await postEcpay("notify", paid(order.id, 600, { PaymentType: "ATM_TAISHIN" }));
    expect(((await (await c.get("/api/billing")).json()) as any).balance).toBe(300_000);
  });

  test("an account that is not charged cannot buy, and orders are each person's own", async () => {
    await openSignUp();
    const member = await memberClient("free-member");
    expect((await member.post("/api/billing/orders", { packageId: "m60" })).status).toBe(409);
    const a = await signedUp("orders-a");
    const { order } = await buy(a);
    const b = await signedUp("orders-b");
    expect((await b.get(`/api/billing/orders/${order.id}`)).status).toBe(404);
  });
});

/** Upload a tiny file (the length is what the browser says) and return the meeting id. */
async function upload(c: Client, durationSec: number | null) {
  const res = await c.post("/api/meetings", { title: "Paid sync", file: { name: "sync.m4a", size: 1024, type: "audio/mp4" }, durationSec });
  if (res.status !== 201) return { status: res.status, body: (await res.json()) as any };
  const { meeting } = (await res.json()) as any;
  await c.req("PUT", `/api/meetings/${meeting.id}/upload?offset=0`, { body: new Uint8Array(1024), headers: { "content-type": "application/octet-stream" } });
  const done = await c.post(`/api/meetings/${meeting.id}/upload/complete`);
  return { status: done.status, id: meeting.id as string, body: (await done.json()) as any };
}

async function claimFor(meetingId: string) {
  for (let i = 0; i < 30; i++) {
    const res = await worker.call("/jobs/claim", { workerId: "gpu-billing", info: {} });
    if (res.status === 204) return null;
    const { job } = (await res.json()) as any;
    if (job.meetingId === meetingId) return job;
    await worker.call(`/jobs/${job.jobId}/fail`, { workerId: "gpu-billing", error: "not this test", retryable: false });
  }
  return null;
}

const RESULT = (durationSec: number) => ({
  durationSec,
  language: "Chinese",
  hasVideo: false,
  hasPlayback: false,
  hasPeaks: false,
  speakers: [],
  segments: [{ start: 0, end: 2, speaker: null, text: "好" }],
});

describe("paying for transcription", () => {
  test("without minutes nothing is uploaded; with them, a finished transcription is charged by its length", async () => {
    const c = await signedUp("payer");
    const none = await upload(c, 30);
    expect(none.status).toBe(402);
    expect(none.body).toMatchObject({ code: "insufficient_credits", availableCredits: 0, neededCredits: 500, what: "transcription" });

    const admin = await adminClient();
    const me = ((await (await c.get("/api/me")).json()) as any).user;
    const gift = await admin.post(`/api/admin/users/${me.id}/credits`, { points: 2, note: "Welcome" });
    expect(gift.status).toBe(200);

    // Longer than the balance: refused before uploading.
    expect((await upload(c, 200)).status).toBe(402);
    const first = await upload(c, 90);
    expect(first.status).toBe(200);
    // The 90 s are set aside: a second recording cannot spend them too.
    const second = await upload(c, 60);
    expect(second.status).toBe(402);
    expect(second.body).toMatchObject({ availableCredits: 500, neededCredits: 1000 });
    expect(((await (await c.get("/api/billing")).json()) as any).held).toBe(1500);

    const job = await claimFor(first.id!);
    // The worker is told how much audio the points pay for.
    expect(job.credits).toEqual({ maxSec: 120 });
    expect((await worker.call(`/jobs/${job.jobId}/complete`, { workerId: "gpu-billing", result: RESULT(91.2) })).status).toBe(200);
    const after = (await (await c.get("/api/billing")).json()) as any;
    // 91.2 s at a point a minute: 1.52 points.
    expect(after.balance).toBe(2000 - 1520);
    expect(after.held).toBe(0);
    expect(after.ledger[0]).toMatchObject({ kind: "transcription", delta: -1520, balance: 480, meetingId: first.id, title: "Paid sync", quantity: { sec: 91 } });

    // Transcribing again is paid again, by the length now known.
    const again = await c.post(`/api/meetings/${first.id}/retranscribe`, {});
    expect(again.status).toBe(402);
  });

  test("one owner's transcriptions run one at a time, and nothing beyond the limit told is charged", async () => {
    const c = await signedUp("racer");
    const admin = await adminClient();
    const me = ((await (await c.get("/api/me")).json()) as any).user;
    await admin.post(`/api/admin/users/${me.id}/credits`, { points: 2, note: "Test" });
    // Two recordings the browser said were a moment long: each sets aside almost nothing.
    const one = await upload(c, 0.001);
    const two = await upload(c, 0.001);
    expect([one.status, two.status]).toEqual([200, 200]);
    const first = await claimFor(one.id!);
    expect(first.credits.maxSec).toBeGreaterThan(100);
    // While it runs, the other is not handed to a second worker (both would be told the same 2 points).
    expect(await claimFor(two.id!)).toBeNull();
    // A worker reporting a huge length is charged for what it was told it may transcribe, no more.
    expect((await worker.call(`/jobs/${first.jobId}/complete`, { workerId: "gpu-billing", result: RESULT(1e9) })).status).toBe(200);
    const after = (await (await c.get("/api/billing")).json()) as any;
    expect(after.balance).toBeGreaterThanOrEqual(0);
    expect(after.ledger[0]).toMatchObject({ kind: "transcription", quantity: { sec: first.credits.maxSec } });
    // Then the next one runs, told what is left.
    const second = await claimFor(two.id!);
    expect(second.credits.maxSec).toBeLessThan(5);
  });

  test("a failed transcription costs nothing", async () => {
    const c = await signedUp("unlucky");
    const admin = await adminClient();
    const me = ((await (await c.get("/api/me")).json()) as any).user;
    await admin.post(`/api/admin/users/${me.id}/credits`, { points: 5, note: "Test" });
    const { id } = await upload(c, 60);
    const job = await claimFor(id!);
    await worker.call(`/jobs/${job.jobId}/fail`, { workerId: "gpu-billing", error: "Not enough points: the recording is 6.0 minutes long, the balance pays for 5.", retryable: false });
    const after = (await (await c.get("/api/billing")).json()) as any;
    expect(after).toMatchObject({ balance: 5000, held: 0 });
  });

  test("invited accounts are never limited or charged", async () => {
    const member = await memberClient("free-uploader");
    const { status, id } = await upload(member, 5000);
    expect(status).toBe(200);
    const job = await claimFor(id!);
    expect(job.credits).toBeUndefined();
    await worker.call(`/jobs/${job.jobId}/complete`, { workerId: "gpu-billing", result: RESULT(5000) });
    const me = ((await (await member.get("/api/me")).json()) as any).user;
    expect(me).toMatchObject({ billing: "exempt", credits: 0 });
  });

  test("an admin can switch an account to free and back", async () => {
    const c = await signedUp("switched");
    const admin = await adminClient();
    const me = ((await (await c.get("/api/me")).json()) as any).user;
    expect((await admin.patch(`/api/admin/users/${me.id}`, { billing: "exempt" })).status).toBe(200);
    expect((await upload(c, 600)).status).toBe(200);
    await admin.patch(`/api/admin/users/${me.id}`, { billing: "prepaid" });
    expect((await upload(c, 600)).status).toBe(402);
    const ledger = (await (await admin.get(`/api/admin/users/${me.id}/credits`)).json()) as any;
    expect(ledger.balance).toBe(0);
  });
});

describe("paying for summaries", () => {
  test("a summary is set aside by its estimate and charged by the tokens the model reported", async () => {
    const c = await signedUp("summariser");
    const admin = await adminClient();
    const me = ((await (await c.get("/api/me")).json()) as any).user;
    await admin.post(`/api/admin/users/${me.id}/credits`, { points: 3, note: "Test" });
    const { id } = await upload(c, 60);
    const job = await claimFor(id!);
    await worker.call(`/jobs/${job.jobId}/complete`, { workerId: "gpu-billing", result: RESULT(60) });
    expect(((await (await c.get("/api/billing")).json()) as any).balance).toBe(2000);

    // The estimate: the transcript and instructions as read (with room), and a long answer.
    const est = (await (await c.post(`/api/meetings/${id}/summaries/estimate`, { prompt: "Summarise." })).json()) as any;
    expect(est.credits).toBeGreaterThan(2000);
    // More than the 2 points left: refused before any model is asked.
    const refused = await c.post(`/api/meetings/${id}/summaries`, { prompt: "Summarise.", outputLanguage: "en", templateId: null });
    expect(refused.status).toBe(402);
    expect(((await refused.json()) as any).what).toBe("summary");

    await admin.post(`/api/admin/users/${me.id}/credits`, { points: 10, note: "More" });
    const ok = await c.post(`/api/meetings/${id}/summaries`, { prompt: "Summarise.", outputLanguage: "en", templateId: null });
    expect(ok.status).toBe(201);
    const sid = ((await ok.json()) as any).summary.id;
    const held = ((await (await c.get("/api/billing")).json()) as any).held;
    expect(held).toBe(est.credits);
    await waitFor(async () => (((await (await c.get(`/api/meetings/${id}`)).json()) as any).meeting.summaries.find((s: any) => s.id === sid)?.status === "done"));
    const after = (await (await c.get("/api/billing")).json()) as any;
    // The stand-in model reports 100 tokens read and 20 written: 100 × 0.1 + 20 × 0.5 = 20 thousandths.
    expect(after.held).toBe(0);
    expect(after.ledger[0]).toMatchObject({ kind: "summary", delta: -20, quantity: { input: 100, output: 20 } });
    expect(after.balance).toBe(12_000 - 20);
  });

  test("an automatic summary the points cannot pay for is recorded as refused, with the reason", async () => {
    const c = await signedUp("auto-summary");
    const admin = await adminClient();
    const me = ((await (await c.get("/api/me")).json()) as any).user;
    // Exactly the recording: nothing left for the summary.
    await admin.post(`/api/admin/users/${me.id}/credits`, { points: 1, note: "Test" });
    const res = await c.post("/api/meetings", {
      title: "Auto",
      file: { name: "a.m4a", size: 1024, type: "audio/mp4" },
      durationSec: 60,
      summary: { prompt: "Summarise.", outputLanguage: "en", templateId: null },
    });
    expect(res.status).toBe(201);
    const { meeting } = (await res.json()) as any;
    await c.req("PUT", `/api/meetings/${meeting.id}/upload?offset=0`, { body: new Uint8Array(1024), headers: { "content-type": "application/octet-stream" } });
    await c.post(`/api/meetings/${meeting.id}/upload/complete`);
    const job = await claimFor(meeting.id);
    await worker.call(`/jobs/${job.jobId}/complete`, { workerId: "gpu-billing", result: RESULT(60) });
    const d = ((await (await c.get(`/api/meetings/${meeting.id}`)).json()) as any).meeting;
    expect(d.summaries[0]).toMatchObject({ status: "failed" });
    expect(d.summaries[0].error).toContain("Not enough points for the summary");
  });

  test("free summaries when their rates are 0, and nothing for exempt accounts", async () => {
    const admin = await openSignUp({ rates: { perMinute: 1, perKInput: 0, perKOutput: 0 } });
    const c = await signedUp("free-summaries");
    await openSignUp({ rates: { perMinute: 1, perKInput: 0, perKOutput: 0 } });
    const me = ((await (await c.get("/api/me")).json()) as any).user;
    await admin.post(`/api/admin/users/${me.id}/credits`, { points: 1, note: "Test" });
    const { id } = await upload(c, 60);
    const job = await claimFor(id!);
    await worker.call(`/jobs/${job.jobId}/complete`, { workerId: "gpu-billing", result: RESULT(60) });
    expect((await c.post(`/api/meetings/${id}/summaries`, { prompt: "Summarise.", outputLanguage: "en", templateId: null })).status).toBe(201);
    await openSignUp();
  });
});

describe("terms of sale", () => {
  test("written on the admin page, shown to anyone, and agreed to with each order", async () => {
    const admin = await adminClient();
    expect((await new Client().get("/api/auth/terms")).status).toBe(404);
    const saved = await admin.req("PUT", "/api/admin/terms", { json: { markdown: "# 購買條款\n\n點數付款後立即提供。" } });
    expect(saved.status).toBe(200);
    // Public: no session needed.
    const pub = (await (await new Client().get("/api/auth/terms")).json()) as any;
    expect(pub.markdown).toContain("點數付款後立即提供");
    expect(((await (await new Client().get("/api/auth/state")).json()) as any).termsUrl).toBe("/terms");

    const c = await signedUp("terms-buyer");
    expect(((await (await c.get("/api/billing")).json()) as any).termsUrl).toBe("/terms");
    const refused = await c.post("/api/billing/orders", { packageId: "m60" });
    expect(refused.status).toBe(422);
    expect(((await refused.json()) as any).code).toBe("terms_required");
    const ok = await c.post("/api/billing/orders", { packageId: "m60", acceptTerms: true });
    expect(ok.status).toBe(201);
    const { order } = (await ok.json()) as any;
    const row = db.query<{ terms_accepted_at: number; terms_version: number }, { id: string }>("SELECT terms_accepted_at, terms_version FROM payment_orders WHERE id = $id").get({ id: order.id })!;
    expect(row.terms_accepted_at).toBeGreaterThan(0);
    expect(row.terms_version).toBe(pub.updatedAt);

    // Emptied: no terms page, and orders need no agreement again.
    await admin.req("PUT", "/api/admin/terms", { json: { markdown: "" } });
    expect((await new Client().get("/api/auth/terms")).status).toBe(404);
    expect((await c.post("/api/billing/orders", { packageId: "m60" })).status).toBe(201);
  });
});

describe("admin", () => {
  test("sees email and ECPay status, and refuses settings that cannot work", async () => {
    const admin = await openSignUp();
    const info = (await (await admin.get("/api/admin/billing")).json()) as any;
    expect(info.mail).toMatchObject({ configured: true, transport: "log" });
    expect(info.ecpay).toMatchObject({ mode: "stage", merchantId: "3002607", testShop: true });
    const bad = await admin.req("PUT", "/api/admin/billing", { json: { ...info.settings, packages: [] } });
    expect(bad.status).toBe(422);
    // "Points never expire" is off unless set, and reaches the purchase page once it is.
    expect(info.settings.noExpiry).toBe(false);
    const buyer = await signedUp("noexpiry");
    expect((await admin.req("PUT", "/api/admin/billing", { json: { ...info.settings, noExpiry: true } })).status).toBe(200);
    expect(((await (await buyer.get("/api/billing")).json()) as any).noExpiry).toBe(true);
    expect((await admin.req("PUT", "/api/admin/billing", { json: { ...info.settings, noExpiry: false } })).status).toBe(200);
    expect((await admin.post("/api/admin/mail/test", { to: "admin@example.com" })).status).toBe(200);
    expect(lastMailTo("admin@example.com").subject).toContain("測試信");
    const orders = (await (await admin.get("/api/admin/orders?status=paid")).json()) as any;
    expect(orders.orders.every((o: any) => o.status === "paid")).toBe(true);
  });
});
