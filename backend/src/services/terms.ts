import { readSetting, settingMeta, writeSetting, deleteSetting } from "./settingsStore";
import { parseJson } from "../lib/util";
import { billingSettings } from "./billingSettings";

/**
 * Terms of sale and refund policy, written on the admin page (Markdown) and
 * shown on this site at /terms, to anyone, signed in or not: people read them
 * before they create an account or pay, and payment providers review them.
 */

const KEY = "terms";
export const TERMS_MAX = 50_000;

export function termsText(): string {
  return parseJson<{ markdown?: string } | null>(readSetting(KEY), null)?.markdown ?? "";
}

export function saveTerms(markdown: string, userId: string) {
  if (markdown.trim()) writeSetting(KEY, { markdown }, userId);
  else deleteSetting(KEY);
}

/** When the terms were last changed (what an order's acceptance refers to). */
export function termsUpdatedAt(): number | null {
  return settingMeta(KEY).updatedAt;
}

/** Where buyers read the terms: this site's page, an outside address an admin gave, or nowhere. */
export function termsLink(): string | null {
  if (termsText().trim()) return "/terms";
  return billingSettings().termsUrl || null;
}
