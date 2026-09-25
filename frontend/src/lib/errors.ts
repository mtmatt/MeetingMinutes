import { ApiError } from "../api/client";
import type { TFn, TKey } from "../i18n";

/**
 * Translate a processing error from the worker into something a person can act
 * on. The raw text is still shown as technical detail.
 */
export function describeFailure(error: string | null | undefined): { key: TKey; canRetry: boolean; reupload: boolean } {
  const e = (error ?? "").toLowerCase();
  if (/decode|moov atom|invalid data|no audio|not a readable|shorter than half|no such file/.test(e)) {
    return { key: "failure.unreadable", canRetry: false, reupload: true };
  }
  if (/out of memory|cuda|could not load models/.test(e)) return { key: "failure.gpu", canRetry: true, reupload: false };
  if (/stopped responding|exited unexpectedly|shut down/.test(e)) return { key: "failure.interrupted", canRetry: true, reupload: false };
  return { key: "failure.generic", canRetry: true, reupload: true };
}

const API_ERRORS: Record<string, TKey> = {
  bad_credentials: "apiError.badCredentials",
  rate_limited: "apiError.rateLimited",
  network: "apiError.network",
  weak_password: "apiError.weakPassword",
  invalid_username: "apiError.invalidUsername",
  username_taken: "apiError.usernameTaken",
  bad_setup_token: "apiError.badSetupToken",
  invalid_invite: "apiError.invalidInvite",
  already_setup: "apiError.alreadySetup",
  too_large: "apiError.tooLarge",
  unsupported_type: "apiError.unsupportedType",
};

/** A localised message for an API error, falling back to the server's text. */
export function apiErrorMessage(err: unknown, t: TFn): string {
  if (err instanceof ApiError) {
    const key = API_ERRORS[err.code];
    return key ? t(key) : err.message;
  }
  return err instanceof Error ? err.message : t("common.error");
}
