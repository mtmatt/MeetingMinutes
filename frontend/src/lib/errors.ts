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

/**
 * Why an upload failed, sorted by what the person can do about it. Only
 * "retry" failures are worth retrying as-is; the others need a different file,
 * a server change, or signing in again.
 */
export type UploadFailure =
  /** Dropped connection, server error or transfer mismatch: retrying resumes where it stopped. */
  | { kind: "retry"; reason: "network" | "server" | "transfer" }
  /** The file is over the server's MAX_UPLOAD_MB. */
  | { kind: "too-large"; size: number; limit: number | null }
  /** A reverse proxy in front of the app refused the request body (HTTP 413 without our error). */
  | { kind: "server-limit" }
  /** The server will not take this file (format, validation). */
  | { kind: "rejected"; message: string }
  /** Signed out while uploading. */
  | { kind: "session" };

export function classifyUploadError(err: unknown, fileSize: number, limit: number | null, t: TFn): UploadFailure {
  if (!(err instanceof ApiError)) return { kind: "retry", reason: "network" };
  const body = err.body as { limitBytes?: unknown };
  if (err.code === "too_large") {
    const max = typeof body.limitBytes === "number" ? body.limitBytes : limit;
    // "Too large" for a file within the known limit cannot be about the file's size.
    if (max != null && fileSize <= max) return { kind: "server-limit" };
    return { kind: "too-large", size: fileSize, limit: max };
  }
  if (err.status === 413) return { kind: "server-limit" };
  if (err.status === 401) return { kind: "session" };
  if (err.status === 0 || err.code === "network") return { kind: "retry", reason: "network" };
  if (err.status >= 500 || err.status === 408 || err.status === 429) return { kind: "retry", reason: "server" };
  if (["bad_chunk", "offset_mismatch", "incomplete", "not_uploading"].includes(err.code) || err.status === 404) {
    return { kind: "retry", reason: "transfer" };
  }
  return { kind: "rejected", message: apiErrorMessage(err, t) };
}

/** Why the speaker diarization model could not be used, in words an admin can act on. */
export function diarizationReason(error: string | null | undefined): TKey {
  const e = (error ?? "").toLowerCase();
  if (e.includes("not installed")) return "admin.diarizationMissingPackage";
  if (/token|401|403|gated|accept|unauthori[sz]ed|forbidden/.test(e)) return "admin.diarizationNeedsToken";
  return "admin.diarizationFailed";
}
