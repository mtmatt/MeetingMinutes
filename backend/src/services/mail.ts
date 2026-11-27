import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { config } from "../config";

/**
 * Email: address verification for people who sign up, password resets, payment
 * receipts and security alerts. Messages are plain text (with a light HTML copy),
 * in the person's language.
 */

export type MailLocale = "en" | "zh-TW";

export interface Mail {
  to: string;
  subject: string;
  text: string;
  /**
   * The site's own links in `text`, made clickable in the HTML copy. Nothing
   * else is: text from other people (a name typed at sign-up, an account name
   * someone tried) must not become a link in a message from this site.
   */
  links?: string[];
}

/** Messages "sent" with MAIL_TRANSPORT=log (newest last), for tests and trying things out. */
export const outbox: Mail[] = [];

export function mailConfigured(): boolean {
  return config.mail.transport === "log" || !!config.mail.server;
}

/** What the admin page shows: how mail goes out, never the password. */
export function publicMailInfo() {
  const s = config.mail.server;
  const server = s ? `${s.host}:${s.port}${s.user ? ` (${s.user})` : ""}` : null;
  return { configured: mailConfigured(), transport: config.mail.transport, server, from: config.mail.from };
}

let transporter: Transporter | null = null;
function smtp(): Transporter {
  if (!transporter) {
    const s = config.mail.server!;
    transporter = nodemailer.createTransport({
      host: s.host,
      port: s.port,
      secure: s.secure,
      // Port 587 and 25: STARTTLS is required, so the password never goes out in the clear.
      requireTLS: !s.secure,
      auth: s.user ? { user: s.user, pass: s.pass } : undefined,
      // A mail server that does not answer must not hold a sign-up for minutes.
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
    });
  }
  return transporter;
}

export class MailError extends Error {}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** Plain text, with the site's own links (and only those) made clickable. */
export function html(text: string, links: string[] = []): string {
  let body = escapeHtml(text);
  for (const link of [...new Set(links)].filter((l) => /^https?:\/\//.test(l)).sort((a, b) => b.length - a.length)) {
    const safe = escapeHtml(link);
    // Whole occurrences only: not inside a longer address that merely starts the same way.
    body = body.replace(new RegExp(`${safe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![^\\s<])`, "g"), `<a href="${safe}">${safe}</a>`);
  }
  body = body.replace(/\n/g, "<br>");
  return `<div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#222">${body}</div>`;
}

export async function sendMail(mail: Mail): Promise<void> {
  if (!mailConfigured()) throw new MailError("Email is not set up (SMTP_URL).");
  if (config.mail.transport === "log") {
    outbox.push(mail);
    if (outbox.length > 200) outbox.shift();
    if (!config.isTest) console.log(`[mail] to ${mail.to}: ${mail.subject}\n${mail.text}\n`);
    return;
  }
  try {
    await smtp().sendMail({ from: config.mail.from, to: mail.to, subject: mail.subject, text: mail.text, html: html(mail.text, mail.links) });
  } catch (e) {
    console.error(`[mail] could not send "${mail.subject}" to ${mail.to}:`, e);
    throw new MailError(e instanceof Error ? e.message : String(e));
  }
}

/** Sent without waiting; a failure is logged (a receipt or an alert must not fail what caused it). */
export function sendMailLater(mail: Mail): void {
  if (!mailConfigured()) return;
  sendMail(mail).catch(() => {});
}

export function mailLocale(locale: string | null | undefined): MailLocale {
  return locale === "en" ? "en" : "zh-TW";
}

const SITE = "Meeting Minutes";

/** The message with a link to confirm an email address. */
export function verifyMail(to: string, link: string, locale: MailLocale): Mail {
  // No name: whoever signs up chooses it, and this goes to whatever address they typed.
  if (locale === "en") {
    return {
      to,
      links: [link],
      subject: `${SITE}: confirm your email address`,
      text: `Hello,\n\nTo finish creating your account, confirm this email address by opening the link below (valid for 24 hours):\n\n${link}\n\nIf you did not sign up, you can ignore this message; the account is removed if the address is not confirmed.`,
    };
  }
  return {
    to,
    links: [link],
    subject: `${SITE}：請確認你的 Email`,
    text: `你好：\n\n請開啟下面的連結確認這個 Email，完成帳號建立（24 小時內有效）：\n\n${link}\n\n如果你沒有註冊，請忽略這封信；沒有確認的帳號會自動刪除。`,
  };
}

/** Someone tried to sign up with an address that already has an account. */
export function alreadyRegisteredMail(to: string, signInLink: string, locale: MailLocale): Mail {
  if (locale === "en") {
    return {
      to,
      links: [signInLink],
      subject: `${SITE}: you already have an account`,
      text: `Someone (probably you) tried to create an account with this email address, which already has one.\n\nSign in here; if you forgot the password, use "Forgot password" on that page:\n\n${signInLink}\n\nIf it was not you, no action is needed.`,
    };
  }
  return {
    to,
    links: [signInLink],
    subject: `${SITE}：這個 Email 已經有帳號了`,
    text: `有人（可能是你）想用這個 Email 註冊，但它已經有帳號了。\n\n請從這裡登入；忘記密碼的話，可以在登入頁按「忘記密碼」：\n\n${signInLink}\n\n如果不是你，不需要做任何事。`,
  };
}

export function resetMail(to: string, link: string, locale: MailLocale, username: string): Mail {
  if (locale === "en") {
    return {
      to,
      links: [link],
      subject: `${SITE}: reset your password`,
      text: `Someone asked to reset the password of the account "${username}". Choose a new password here (valid for 1 hour, once):\n\n${link}\n\nIf it was not you, ignore this message; the password stays as it is.`,
    };
  }
  return {
    to,
    links: [link],
    subject: `${SITE}：重設密碼`,
    text: `有人申請重設帳號「${username}」的密碼。請從這裡設定新密碼（1 小時內有效，只能用一次）：\n\n${link}\n\n如果不是你，請忽略這封信，密碼不會改變。`,
  };
}

export function receiptMail(
  to: string,
  locale: MailLocale,
  order: { id: string; points: number; amount: number; method: string | null },
  balancePoints: number,
  link: string,
): Mail {
  if (locale === "en") {
    return {
      to,
      links: [link],
      subject: `${SITE}: payment received (${order.points} points)`,
      text: `Thank you. Your payment was received.\n\nOrder: ${order.id}\nAmount: NT$${order.amount}\nAdded: ${order.points} points\nBalance now: ${balancePoints} points\n\nYour purchases and usage: ${link}`,
    };
  }
  return {
    to,
    links: [link],
    subject: `${SITE}：付款完成（${order.points} 點）`,
    text: `感謝購買，款項已收到。\n\n訂單編號：${order.id}\n金額：新台幣 ${order.amount} 元\n加值：${order.points} 點\n目前餘額：${balancePoints} 點\n\n購買與使用紀錄：${link}`,
  };
}

export function testMail(to: string, locale: MailLocale): Mail {
  return locale === "en"
    ? { to, subject: `${SITE}: test message`, text: "This is a test message from the admin page. Email works." }
    : { to, subject: `${SITE}：測試信`, text: "這是從管理頁寄出的測試信，Email 設定正常。" };
}
