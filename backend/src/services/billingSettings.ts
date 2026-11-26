import { z } from "zod";
import { readSetting, settingMeta, writeSetting } from "./settingsStore";
import { parseJson } from "../lib/util";

/**
 * Selling transcription minutes, as an administrator sets it up on the admin
 * page: whether people may create their own accounts, whether minutes are on
 * sale, the packages, and how they may be paid. ECPay's shop keys stay in the
 * server's environment (ECPAY_*), never here.
 */

const KEY = "billing";

/** Ways to pay offered on ECPay's page. */
export const PAYMENT_METHODS = ["Credit", "ATM", "CVS"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const packageSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,23}$/, "Package ids are 1-24 lower-case letters, digits or dashes."),
  minutes: z.number().int().min(1).max(100_000),
  /** New Taiwan dollars, tax included. */
  price: z.number().int().min(1).max(200_000),
});
export type CreditPackage = z.infer<typeof packageSchema>;

export const billingSettingsSchema = z
  .object({
    /** Anyone may create an account with an email address (it pays with minutes). Invitations keep working either way. */
    registrationOpen: z.boolean(),
    /** Minutes are on sale. */
    enabled: z.boolean(),
    packages: z.array(packageSchema).max(8),
    methods: z.array(z.enum(PAYMENT_METHODS)).min(1),
    /** Terms of sale and refund policy, linked on the purchase page. */
    termsUrl: z.union([z.literal(""), z.url({ protocol: /^https?$/ }).max(500)]),
  })
  .refine((s) => new Set(s.packages.map((p) => p.id)).size === s.packages.length, { message: "Package ids must differ.", path: ["packages"] })
  .refine((s) => !s.enabled || s.packages.length > 0, { message: "Add at least one package before putting minutes on sale.", path: ["packages"] });
export type BillingSettings = z.infer<typeof billingSettingsSchema>;

export function defaultBillingSettings(): BillingSettings {
  return { registrationOpen: false, enabled: false, packages: [], methods: [...PAYMENT_METHODS], termsUrl: "" };
}

export function billingSettings(): BillingSettings {
  const saved = parseJson<Partial<BillingSettings> | null>(readSetting(KEY), null);
  const merged = { ...defaultBillingSettings(), ...(saved ?? {}) };
  const ok = billingSettingsSchema.safeParse(merged);
  return ok.success ? ok.data : defaultBillingSettings();
}

export function saveBillingSettings(s: BillingSettings, userId: string) {
  writeSetting(KEY, s, userId);
}

export function billingSettingsMeta() {
  return settingMeta(KEY);
}
