/**
 * What the UI check opens: every page, and the dialogs and menus that are
 * easy to break. A screen is a path, who is signed in, and optionally what to
 * click once the page is there. Labels come from the app's own translations,
 * so a renamed button breaks the check loudly instead of silently skipping it.
 */
import type { Page } from "playwright";
import { en } from "../frontend/src/i18n/en";
import { zhTW } from "../frontend/src/i18n/zh-TW";
import type { Variant } from "./run";

export interface Account {
  member: string;
  admin: string;
  resetToken: string;
  meetings: { ready: string; processing: string; failed: string; deleted: string; silent: string };
}
export interface ServerInfo {
  port: number;
  password: string;
  inviteToken: string;
  accounts: Record<string, Account>;
}
export interface Screen {
  id: string;
  as: "anon" | "member" | "admin";
  path: (info: ServerInfo, a: Account) => string;
  /** Wait for this before checking. */
  ready?: string;
  /** Then do this (open a dialog, switch a tab). */
  act?: (page: Page, v: Variant) => Promise<void>;
  /** API answers in the 4xx range that are part of what the screen shows. */
  expectStatus?: number[];
  /** Only these variants. */
  variants?: string[];
}

/** The text of a translation key in the variant's language. */
function t(v: Variant, key: string): string {
  const dict = (v.locale === "en" ? en : zhTW) as unknown as Record<string, unknown>;
  const value = key.split(".").reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], dict);
  if (typeof value !== "string") throw new Error(`no translation ${key}`);
  return value;
}

const tab = (n: number) => async (page: Page) => {
  await page.locator("[role=tablist] [role=tab]").nth(n).click();
};
const menuItem = (key: string) => async (page: Page, v: Variant) => {
  await page.locator("[role=menu] .menu-item", { hasText: t(v, key) }).first().click();
};

export const SCREENS: Screen[] = [
  // ------------------------------------------------------------- signed out
  { id: "landing", as: "anon", path: () => "/" },
  { id: "login", as: "anon", path: () => "/login", ready: "form" },
  { id: "register", as: "anon", path: () => "/register", ready: "form" },
  { id: "forgot", as: "anon", path: () => "/forgot", ready: "form" },
  { id: "invite", as: "anon", path: (i) => `/invite/${i.inviteToken}`, ready: "form" },
  { id: "reset-password", as: "anon", path: (_, a) => `/invite/${a.resetToken}`, ready: "form" },
  { id: "invite-invalid", as: "anon", path: () => "/invite/not-a-real-link-0000000000000000", expectStatus: [404] },
  { id: "verify-email-invalid", as: "anon", path: () => "/verify-email/not-a-real-link-0000000000000000", expectStatus: [404] },
  { id: "pricing", as: "anon", path: () => "/pricing" },
  { id: "terms", as: "anon", path: () => "/terms" },
  { id: "not-found", as: "anon", path: () => "/no-such-page" },

  // ------------------------------------------------------------- member
  { id: "library", as: "member", path: () => "/", ready: "main" },
  {
    id: "library-search",
    as: "member",
    path: () => "/",
    ready: "main input",
    act: async (page) => {
      await page.locator("main input").first().fill("週會");
    },
  },
  { id: "upload", as: "member", path: () => "/new", ready: "main" },
  { id: "upload-record", as: "member", path: () => "/new", ready: ".mode-tabs", act: tab(1) },
  { id: "meeting", as: "member", path: (_, a) => `/m/${a.meetings.ready}`, ready: ".transcript" },
  {
    id: "meeting-summary",
    as: "member",
    path: (_, a) => `/m/${a.meetings.ready}`,
    ready: "main",
    act: async (page) => {
      // Narrow screens show transcript and summary as tabs; wide ones show both.
      const tabs = page.locator(".meeting-tabs [role=tab]");
      if (await tabs.first().isVisible()) await tabs.nth(1).click();
      await page.locator(".summary-panel").waitFor();
    },
  },
  {
    id: "meeting-export-menu",
    as: "member",
    path: (_, a) => `/m/${a.meetings.ready}`,
    ready: ".meeting-actions",
    act: async (page, v) => {
      await page.locator(".meeting-actions button", { hasText: t(v, "meeting.export") }).click();
      await page.locator("[role=menu]").waitFor();
    },
  },
  {
    id: "meeting-summary-composer",
    as: "member",
    path: (_, a) => `/m/${a.meetings.ready}`,
    ready: "main",
    act: async (page) => {
      const tabs = page.locator(".meeting-tabs [role=tab]");
      if (await tabs.first().isVisible()) await tabs.nth(1).click();
      await page.locator(".summary-actions > button").last().click();
      await page.locator("[role=dialog]").waitFor();
    },
  },
  { id: "meeting-processing", as: "member", path: (_, a) => `/m/${a.meetings.processing}`, ready: ".pipeline" },
  { id: "meeting-failed", as: "member", path: (_, a) => `/m/${a.meetings.failed}`, ready: "main" },
  { id: "meeting-media-deleted", as: "member", path: (_, a) => `/m/${a.meetings.deleted}`, ready: "main" },
  { id: "meeting-no-speech", as: "member", path: (_, a) => `/m/${a.meetings.silent}`, ready: "main" },
  { id: "templates", as: "member", path: () => "/templates", ready: "main" },
  { id: "glossaries", as: "member", path: () => "/glossaries", ready: "main" },
  { id: "voices", as: "member", path: () => "/voices", ready: "main" },
  { id: "settings", as: "member", path: () => "/settings", ready: "main" },
  { id: "billing", as: "member", path: () => "/billing", ready: "main" },
  { id: "usage", as: "member", path: () => "/usage", ready: "main" },
  { id: "announcements", as: "member", path: () => "/announcements", ready: "main" },
  {
    id: "account-menu",
    as: "member",
    path: () => "/",
    ready: "header",
    act: async (page) => {
      await page.locator("header .menu-anchor button").last().click();
      await page.locator("[role=menu]").waitFor();
    },
  },

  // ------------------------------------------------------------- admin
  { id: "admin-users", as: "admin", path: () => "/admin?tab=users", ready: "table" },
  {
    id: "admin-reset-link",
    as: "admin",
    path: () => "/admin?tab=users",
    ready: "table",
    act: async (page, v) => {
      const row = page.locator("tbody tr", { hasText: `member-${v.id.replace(/[^a-z0-9]/g, "")}` });
      await row.locator(".menu-anchor button").click();
      await menuItem("admin.resetLink")(page, v);
      await page.locator("[role=dialog] .copy-field").waitFor();
    },
  },
  { id: "admin-invites", as: "admin", path: () => "/admin?tab=invites", ready: "main" },
  {
    id: "admin-invite-created",
    as: "admin",
    path: () => "/admin?tab=invites",
    ready: ".invite-uses",
    act: async (page, v) => {
      await page.locator("button", { hasText: t(v, "common.create") }).first().click();
      await page.locator(".invite-created .copy-field").waitFor();
    },
  },
  { id: "admin-announcements", as: "admin", path: () => "/admin?tab=announcements", ready: "main" },
  { id: "admin-transcription", as: "admin", path: () => "/admin?tab=asr", ready: "main" },
  { id: "admin-summary-model", as: "admin", path: () => "/admin?tab=model", ready: "main" },
  { id: "admin-sales", as: "admin", path: () => "/admin?tab=sales", ready: "main" },
  { id: "admin-perf", as: "admin", path: () => "/admin?tab=perf", ready: ".perf-tiles" },
  { id: "admin-security", as: "admin", path: () => "/admin?tab=security", ready: "main" },
  { id: "admin-system", as: "admin", path: () => "/admin?tab=system", ready: "main" },
];
