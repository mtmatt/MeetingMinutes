import { z } from "zod";
import { readSetting, settingMeta, writeSetting } from "./settingsStore";
import { parseJson } from "../lib/util";

/**
 * Selling points, as an administrator sets it up on the admin page: whether
 * people may create their own accounts, what transcription and summaries cost
 * in points, the packages of points on sale, and how they may be paid. ECPay's
 * shop keys stay in the server's environment (ECPAY_*), never here.
 */

const KEY = "billing";

/** Ways to pay offered on ECPay's page. */
export const PAYMENT_METHODS = ["Credit", "ATM", "CVS"] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const packageSchema = z.object({
  id: z.string().trim().regex(/^[a-z0-9][a-z0-9-]{0,23}$/, "Package ids are 1-24 lower-case letters, digits or dashes."),
  points: z.number().int().min(1).max(1_000_000),
  /** New Taiwan dollars, tax included. */
  price: z.number().int().min(1).max(200_000),
});
export type CreditPackage = z.infer<typeof packageSchema>;

/** Points per minute of recording, and per thousand tokens a summary model reads and writes (0: free). */
export const ratesSchema = z.object({
  perMinute: z.number().min(0).max(1000),
  perKInput: z.number().min(0).max(1000),
  perKOutput: z.number().min(0).max(1000),
});
export type Rates = z.infer<typeof ratesSchema>;

export const billingSettingsSchema = z
  .object({
    /** Anyone may create an account with an email address (it pays with points). Invitations keep working either way. */
    registrationOpen: z.boolean(),
    /** Points are on sale. */
    enabled: z.boolean(),
    rates: ratesSchema,
    packages: z.array(packageSchema).max(8),
    methods: z.array(z.enum(PAYMENT_METHODS)).min(1),
    /** Terms of sale and refund policy, linked on the purchase page. */
    termsUrl: z.union([z.literal(""), z.url({ protocol: /^https?$/ }).max(500)]),
  })
  .refine((s) => new Set(s.packages.map((p) => p.id)).size === s.packages.length, { message: "Package ids must differ.", path: ["packages"] })
  .refine((s) => !s.enabled || s.packages.length > 0, { message: "Add at least one package before putting points on sale.", path: ["packages"] });
export type BillingSettings = z.infer<typeof billingSettingsSchema>;

export function defaultBillingSettings(): BillingSettings {
  // Defaults to adjust: about NT$1 a point sells an hour of recording for 60 points, and an
  // hour's summary (some 20,000 tokens read, 2,000 written) for about 3.
  return {
    registrationOpen: false,
    enabled: false,
    rates: { perMinute: 1, perKInput: 0.1, perKOutput: 0.5 },
    packages: [],
    methods: [...PAYMENT_METHODS],
    termsUrl: "",
  };
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
