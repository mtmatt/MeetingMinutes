import type {
  Slide,
  RefineInfo,
  RefineSettings,
  RefineState,
  SecurityEvent,
  SecuritySettings,
  SecurityState,
  AdminOrder,
  BillingAdminState,
  BillingInfo,
  BillingSettings,
  LedgerEntry,
  Order,
  AdminUser,
  Invite,
  ApiModelProbe,
  ApiModelSettings,
  LocalModelSettings,
  Preset,
  PresetInput,
  LocalModelStatus,
  MeetingDetail,
  MeetingSummary,
  ModelPull,
  Peaks,
  SessionInfo,
  Summary,
  SummarizerInfo,
  MediaPolicy,
  WorkerKey,
  WorkerProfile,
  MediaState,
  TranscriberInfo,
  TranscriberSettings,
  TranscriberState,
  SummarizerState,
  SummaryRequest,
  SummarySettings,
  SystemInfo,
  Template,
  TranscribeOptions,
  User,
  VoiceOutcome,
  VoicesState, UsageRange, UsageReport, WorkerWake, Announcement, AnnouncementList, AdminAnnouncement, AnnouncementInput, PublicPricing } from "./types";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code: string,
    readonly body: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

type Json = object;

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function request<T>(method: string, path: string, body?: Json, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { "X-MM-Client": "1", Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      credentials: "same-origin",
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      ...init,
    });
  } catch {
    throw new ApiError(0, "Cannot reach the server. Check your connection.", "network");
  }
  const text = await res.text();
  let data: Record<string, unknown> = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { error: text };
    }
  }
  if (!res.ok) {
    const code = typeof data.code === "string" ? data.code : "error";
    if (res.status === 401 && code === "unauthenticated") onUnauthorized?.();
    throw new ApiError(res.status, typeof data.error === "string" ? data.error : res.statusText, code, data);
  }
  return data as T;
}

const get = <T>(p: string) => request<T>("GET", p);

/**
 * A GET for data fetched at start-up, before the sign-in check has answered:
 * a refusal is only thrown, not treated as being signed out (the sign-in check
 * decides that), so it cannot send someone to the wrong page.
 */
export async function quietGet<T>(path: string): Promise<T> {
  const res = await fetch(`/api${path}`, { credentials: "same-origin", headers: { "X-MM-Client": "1", Accept: "application/json" } });
  if (!res.ok) throw new ApiError(res.status, res.statusText, "prefetch_failed");
  return (await res.json()) as T;
}
const post = <T>(p: string, b: Json = {}) => request<T>("POST", p, b);
const patch = <T>(p: string, b: Json) => request<T>("PATCH", p, b);
const del = <T>(p: string) => request<T>("DELETE", p);
const put = <T>(p: string, b: Json) => request<T>("PUT", p, b);

export const api = {
  // auth
  authState: () =>
    get<{
      needsSetup: boolean;
      user: User | null;
      helpContact: string | null;
      /** Transcript correction with a hosted model (null when signed out). */
      refine?: RefineInfo | null;
      /** How long the site keeps recordings after transcription (days); null: kept. */
      mediaRetentionDays?: number | null;
      uploadLimitBytes: number | null;
      googleClientId: string | null;
      summarizer: SummarizerInfo | null;
      transcriber?: TranscriberInfo | null;
      mediaPolicy?: MediaPolicy | null;
      externalWorkers?: boolean | null;
      /** The site's address (PUBLIC_URL's origin); null when not configured. */
      siteOrigin?: string | null;
      /** People may create their own accounts. */
      registration?: boolean;
      /** "Forgot password" can email a link. */
      passwordReset?: boolean;
      /** The terms of sale: "/terms" on this site, an outside address, or null. */
      termsUrl?: string | null;
    }>("/auth/state"),
  terms: () => get<{ markdown: string; updatedAt: number | null }>("/auth/terms"),
  pricing: () => get<PublicPricing>("/auth/pricing"),
  adminTerms: () => get<{ markdown: string; updatedAt: number | null }>("/admin/terms"),
  adminSaveTerms: (markdown: string) => put<{ markdown: string; updatedAt: number | null }>("/admin/terms", { markdown }),
  register: (b: { username: string; displayName: string; email: string; password: string; locale: string }) =>
    post<{ ok: true; email: string }>("/auth/register", b),
  verifyEmail: (token: string) => post<{ ok: true; username: string; email: string }>("/auth/verify-email", { token }),
  resendVerification: (email: string, locale: string) => post<{ ok: true }>("/auth/verify-email/resend", { email, locale }),
  forgotPassword: (email: string, locale: string) => post<{ ok: true }>("/auth/forgot-password", { email, locale }),
  changeEmail: (email: string, password: string) => post<{ ok: true; sent: boolean }>("/me/email", { email, password }),

  // billing
  billing: () => get<BillingInfo>("/billing"),
  announcements: () => get<AnnouncementList>("/announcements"),
  markAnnouncementsSeen: (ids: string[]) => post<AnnouncementList>("/announcements/seen", { ids }),
  publicAnnouncements: () => get<{ announcements: Announcement[] }>("/auth/announcements"),
  adminAnnouncements: () => get<{ announcements: AdminAnnouncement[] }>("/admin/announcements"),
  adminCreateAnnouncement: (a: AnnouncementInput) => post<{ id: string }>("/admin/announcements", a),
  adminUpdateAnnouncement: (id: string, a: AnnouncementInput) => request<{ ok: true }>("PUT", `/admin/announcements/${encodeURIComponent(id)}`, a),
  adminDeleteAnnouncement: (id: string) => del<{ ok: true }>(`/admin/announcements/${encodeURIComponent(id)}`),
  /** `user`: an administrator's choice of a person's id, or "all" for the whole site. */
  usage: (range: UsageRange, user = "") => get<UsageReport>(`/usage?range=${range}${user ? `&user=${encodeURIComponent(user)}` : ""}`),
  createOrder: (packageId: string, locale: string, acceptTerms = false) =>
    post<{ order: Order; checkout: { action: string; fields: Record<string, string> } }>("/billing/orders", { packageId, locale, acceptTerms }),
  order: (id: string) => get<{ order: Order }>(`/billing/orders/${encodeURIComponent(id)}`),
  refreshOrder: (id: string) => post<{ order: Order }>(`/billing/orders/${encodeURIComponent(id)}/refresh`),
  adminBilling: () => get<BillingAdminState>("/admin/billing"),
  adminSaveBilling: (b: BillingSettings) => put<Pick<BillingAdminState, "settings" | "meta">>("/admin/billing", b),
  adminTestMail: (to: string) => post<{ ok: true }>("/admin/mail/test", { to }),
  adminOrders: (status = "") => get<{ orders: AdminOrder[] }>(`/admin/orders${status ? `?status=${status}` : ""}`),
  adminRefreshOrder: (id: string) => post<{ order: Order }>(`/admin/orders/${encodeURIComponent(id)}/refresh`),
  adminCredits: (userId: string) => get<{ balance: number; ledger: LedgerEntry[] }>(`/admin/users/${encodeURIComponent(userId)}/credits`),
  adminSecurity: () => get<SecurityState>("/admin/security"),
  adminSecurityEvents: (kind = "", ip = "", limit = 100, noise = false) =>
    get<{ events: SecurityEvent[]; hiddenNoise: number }>(
      `/admin/security/events?kind=${encodeURIComponent(kind)}&ip=${encodeURIComponent(ip)}&limit=${limit}${noise ? "&noise=1" : ""}`,
    ),
  adminSaveSecurity: (b: SecuritySettings) => put<{ settings: SecuritySettings }>("/admin/security", b),
  adminBlockIp: (ip: string, minutes: number | null, reason = "") => post<{ ok: true }>("/admin/security/blocks", { ip, minutes, reason }),
  adminUnblockIp: (ip: string) => del<{ ok: true }>(`/admin/security/blocks/${encodeURIComponent(ip)}`),
  adminAdjustCredits: (userId: string, points: number, note: string) =>
    post<{ balance: number; user: User }>(`/admin/users/${encodeURIComponent(userId)}/credits`, { points, note }),
  summaryEstimate: (meetingId: string, prompt: string, slides = true) =>
    post<{ credits: number | null; available?: number }>(`/meetings/${meetingId}/summaries/estimate`, { prompt, slides }),
  login: (username: string, password: string) => post<{ user: User }>("/auth/login", { username, password }),
  logout: () => post<{ ok: true }>("/auth/logout"),
  setup: (b: { setupToken: string; username: string; displayName: string; password: string }) =>
    post<{ user: User }>("/auth/setup", b),
  inviteInfo: (token: string) =>
    get<{ kind: "invite" | "reset"; role: string; username: string | null; expiresAt: number }>(`/auth/invites/${encodeURIComponent(token)}`),
  acceptInvite: (token: string, b: { username?: string; displayName?: string; password: string }) =>
    post<{ user: User }>(`/auth/invites/${encodeURIComponent(token)}/accept`, b),

  // me
  updateMe: (b: { displayName?: string; locale?: string | null; theme?: "system" | "light" | "dark" | null; newUi?: boolean; mediaRetentionDays?: 7 | 30 | null }) => patch<{ user: User }>("/me", b),
  changePassword: (current: string, next: string) => post<{ ok: true }>("/me/password", { current, next }),
  sessions: () => get<{ sessions: SessionInfo[] }>("/me/sessions"),
  revokeSession: (id: string) => del<{ ok: true }>(`/me/sessions/${id}`),
  revokeOtherSessions: () => post<{ ok: true }>("/me/sessions/revoke-others"),

  // meetings
  meetings: (q = "") => get<{ meetings: MeetingSummary[] }>(`/meetings${q ? `?q=${encodeURIComponent(q)}` : ""}`),
  meeting: (id: string) => get<{ meeting: MeetingDetail }>(`/meetings/${id}`),
  createMeeting: (b: {
    title: string;
    occurredAt: number | null;
    file: { name: string; size: number; type: string };
    options: TranscribeOptions;
    summary: SummaryRequest | null;
    durationSec?: number | null;
  }) => post<{ meeting: MeetingSummary; chunkSize: number }>("/meetings", b),
  completeUpload: (id: string) => post<{ meeting: MeetingSummary }>(`/meetings/${id}/upload/complete`),
  /** One picture of what was on screen (JPEG), while the recording is being uploaded; sent again, it is stored once. */
  uploadSlide: (id: string, s: { key: string; at: number; blob: Blob }, signal?: AbortSignal) =>
    request<{ slide: Slide }>("POST", `/meetings/${id}/slides?at=${s.at.toFixed(2)}&key=${encodeURIComponent(s.key)}`, undefined, {
      body: s.blob,
      headers: { "X-MM-Client": "1", Accept: "application/json", "Content-Type": "image/jpeg" },
      signal,
    }),
  deleteSlide: (id: string, sid: string) => del<{ ok: true }>(`/meetings/${id}/slides/${encodeURIComponent(sid)}`),
  refineMeeting: (id: string) => post<{ meeting: MeetingDetail }>(`/meetings/${id}/refine`, {}),
  undoRefineMeeting: (id: string) => post<{ restored: number; meeting: MeetingDetail }>(`/meetings/${id}/refine/undo`, {}),
  adminRefine: () => get<RefineState>("/admin/refine"),
  adminSaveRefine: (s: RefineSettings) => put<RefineState>("/admin/refine", s),
  adminResetRefine: () => del<RefineState>("/admin/refine"),
  updateMeeting: (id: string, b: { title?: string; occurredAt?: number | null }) =>
    patch<{ meeting: MeetingSummary }>(`/meetings/${id}`, b),
  deleteMeeting: (id: string) => del<{ ok: true }>(`/meetings/${id}`),
  retranscribe: (id: string, options?: TranscribeOptions, resetSpeakerNames = false) =>
    post<{ meeting: MeetingSummary }>(`/meetings/${id}/retranscribe`, { ...(options ? { options } : {}), resetSpeakerNames }),
  /**
   * `summaries`: how many finished summaries got the new name, and how many could not be updated safely.
   * `voice`: whether the speaker's voice is now remembered under the name (null when the name did not change).
   */
  renameSpeaker: (id: string, key: string, name: string) =>
    patch<{ ok: true; summaries: { updated: number; skipped: number }; voice: VoiceOutcome | null }>(
      `/meetings/${id}/speakers/${encodeURIComponent(key)}`,
      { name },
    ),
  /** Answer voice recognition about a speaker. */
  speakerVoice: (id: string, key: string, action: "confirm" | "reject" | "forget" | "remember") =>
    post<{ ok: true; voice: VoiceOutcome }>(`/meetings/${id}/speakers/${encodeURIComponent(key)}/voice`, { action }),
  addSpeaker: (id: string, name: string) =>
    post<{ speaker: { key: string; name: string; color: number } }>(`/meetings/${id}/speakers`, { name }),
  updateSegment: (id: string, segId: number, b: { text?: string; speaker?: string | null }) =>
    patch<{ ok: true }>(`/meetings/${id}/segments/${segId}`, b),
  peaks: (id: string) => get<Peaks>(`/meetings/${id}/peaks`),
  createSummary: (id: string, b: SummaryRequest) => post<{ summary: Summary }>(`/meetings/${id}/summaries`, b),
  cancelSummary: (id: string, sid: string) => post<{ ok: true }>(`/meetings/${id}/summaries/${sid}/cancel`),
  updateSummary: (id: string, sid: string, content: string) =>
    patch<{ ok: true }>(`/meetings/${id}/summaries/${sid}`, { content }),
  deleteSummary: (id: string, sid: string) => del<{ ok: true }>(`/meetings/${id}/summaries/${sid}`),
  /** Speaker names a summary could not update by itself: replace them anyway, or keep the text as written. */
  resolveSummaryNames: (id: string, sid: string, action: "replace" | "keep", keys: string[]) =>
    post<{ summary: Summary }>(`/meetings/${id}/summaries/${encodeURIComponent(sid)}/speaker-names`, { action, keys }),

  // templates
  templates: () => get<{ templates: Template[] }>("/templates"),
  presets: () => get<{ presets: Preset[] }>("/presets"),
  createPreset: (b: PresetInput) => post<{ preset: Preset; presets: Preset[] }>("/presets", b),
  updatePreset: (id: string, b: PresetInput) => put<{ preset: Preset; presets: Preset[] }>(`/presets/${id}`, b),
  deletePreset: (id: string) => del<{ presets: Preset[] }>(`/presets/${id}`),
  createTemplate: (b: { name: string; description: string; body: string }) => post<{ template: Template }>("/templates", b),
  updateTemplate: (id: string, b: { name?: string; description?: string; body?: string }) =>
    patch<{ template: Template }>(`/templates/${id}`, b),
  deleteTemplate: (id: string) => del<{ ok: true }>(`/templates/${id}`),

  // voices
  voices: () => get<VoicesState>("/voices"),
  voiceSettings: (enabled: boolean) => patch<VoicesState>("/voices/settings", { enabled }),
  scanVoices: () => post<VoicesState & { outcome: { queued: number; remembered: number; recognised: number } }>("/voices/scan"),
  renameVoice: (id: string, name: string) => patch<VoicesState>(`/voices/${encodeURIComponent(id)}`, { name }),
  mergeVoice: (id: string, into: string) => post<VoicesState>(`/voices/${encodeURIComponent(id)}/merge`, { into }),
  deleteVoice: (id: string) => del<VoicesState>(`/voices/${encodeURIComponent(id)}`),
  deleteVoiceSample: (id: string, sampleId: number) => del<VoicesState>(`/voices/${encodeURIComponent(id)}/samples/${sampleId}`),

  // admin
  adminUsers: () => get<{ users: AdminUser[] }>("/admin/users"),
  adminUpdateUser: (id: string, b: { role?: string; disabled?: boolean; displayName?: string; billing?: "exempt" | "prepaid" }) =>
    patch<{ user: User }>(`/admin/users/${id}`, b),
  adminDeleteUser: (id: string) => del<{ ok: true }>(`/admin/users/${id}`),
  adminResetLink: (id: string) => post<{ url: string; expiresAt: number }>(`/admin/users/${id}/reset-link`),
  adminInvites: () => get<{ invites: Invite[] }>("/admin/invites"),
  adminCreateInvite: (b: { role: string; note: string | null; ttlHours: number; maxUses: number }) =>
    post<{ url: string; invite: Invite }>("/admin/invites", b),
  adminDeleteInvite: (id: string) => del<{ ok: true }>(`/admin/invites/${id}`),
  adminSystem: () => get<SystemInfo>("/admin/system"),
  adminSummarizer: () => get<SummarizerState>("/admin/summarizer"),
  adminSaveSummarizer: (b: SummarySettings) => request<SummarizerState>("PUT", "/admin/summarizer", b),
  adminResetSummarizer: () => del<SummarizerState>("/admin/summarizer"),
  adminTranscriber: () => get<TranscriberState>("/admin/transcriber"),
  adminSaveTranscriber: (b: TranscriberSettings) => request<TranscriberState>("PUT", "/admin/transcriber", b),
  adminResetTranscriber: () => del<TranscriberState>("/admin/transcriber"),
  adminMedia: () => get<MediaState>("/admin/media"),
  adminSaveMedia: (b: MediaPolicy) => request<MediaState>("PUT", "/admin/media", b),
  adminResetMedia: () => del<MediaState>("/admin/media"),
  adminWorkerKeys: () => get<{ keys: WorkerKey[]; enrollTtlMs: number }>("/admin/worker-keys"),
  adminCreateWorkerKey: (name: string) => post<{ id: string; name: string; code: string; expiresAt: number }>("/admin/worker-keys", { name }),
  adminRevokeWorkerKey: (id: string) => del<{ ok: true; requeued: number }>(`/admin/worker-keys/${encodeURIComponent(id)}`),
  adminWorkerProfiles: () =>
    get<{ profiles: Record<string, WorkerProfile>; local: string; defaultFallbackSec: number; wake: Record<string, WorkerWake> }>("/admin/worker-profiles"),
  adminSaveWorkerWake: (id: string, url: string | null) => request<{ wake: WorkerWake | null }>("PUT", `/admin/worker-wake/${encodeURIComponent(id)}`, { url }),
  adminTestWorkerWake: (id: string, url?: string) =>
    post<{ ok: boolean; status: number | null; error: string | null; running?: boolean }>(`/admin/worker-wake/${encodeURIComponent(id)}/test`, url ? { url } : {}),
  adminSaveWorkerProfile: (id: string, p: WorkerProfile) =>
    request<{ profile: WorkerProfile }>("PUT", `/admin/worker-profiles/${encodeURIComponent(id)}`, p),
  /** Look at a model server with the form's values, before they are saved. */
  adminProbeModel: (b: Pick<LocalModelSettings, "api" | "baseUrl" | "model">) =>
    post<{ status: LocalModelStatus; pull: ModelPull | null }>("/admin/summarizer/probe", b),
  adminPullModel: (b: Pick<LocalModelSettings, "api" | "baseUrl" | "model">) => post<{ pull: ModelPull }>("/admin/summarizer/pull", b),
  adminProbeApiModel: (b: Pick<ApiModelSettings, "provider" | "model">) => post<ApiModelProbe>("/admin/summarizer/probe-api", b),
};

export const mediaUrl = {
  audio: (id: string) => `/api/meetings/${id}/media/audio`,
  original: (id: string, download = false) => `/api/meetings/${id}/media/original${download ? "?download=1" : ""}`,
  export: (id: string, format: string) => `/api/meetings/${id}/export?format=${format}`,
};

const MAX_RETRIES = 5;

/**
 * Upload a file in sequential chunks with resume-on-mismatch. XHR is used for
 * byte-level progress, which fetch() cannot report for request bodies.
 */
export function uploadFile(
  meetingId: string,
  file: File,
  chunkSize: number,
  onProgress: (sent: number, total: number) => void,
  signal: AbortSignal,
  /** Called before each automatic retry after a dropped connection or server error. */
  onRetry?: (attempt: number, max: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let offset = 0;
    let retries = 0;
    let current: XMLHttpRequest | null = null;
    signal.addEventListener("abort", () => {
      current?.abort();
      reject(new ApiError(0, "Upload canceled.", "aborted"));
    });

    const sendNext = () => {
      if (signal.aborted) return;
      if (offset >= file.size) {
        resolve();
        return;
      }
      const end = Math.min(file.size, offset + chunkSize);
      const xhr = new XMLHttpRequest();
      current = xhr;
      xhr.open("PUT", `/api/meetings/${meetingId}/upload?offset=${offset}`);
      xhr.setRequestHeader("X-MM-Client", "1");
      xhr.setRequestHeader("Content-Type", "application/octet-stream");
      xhr.upload.onprogress = (e) => onProgress(offset + e.loaded, file.size);
      xhr.onload = () => {
        let data: Record<string, unknown> = {};
        try {
          data = JSON.parse(xhr.responseText || "{}");
        } catch {
          /* ignore */
        }
        if (xhr.status === 200) {
          offset = Number(data.received);
          retries = 0;
          onProgress(offset, file.size);
          sendNext();
        } else if (xhr.status === 409 && typeof data.received === "number") {
          offset = data.received;
          sendNext();
        } else if (xhr.status >= 500 && retries < MAX_RETRIES) {
          retries++;
          onRetry?.(retries, MAX_RETRIES);
          setTimeout(sendNext, 1000 * 2 ** retries);
        } else {
          reject(new ApiError(xhr.status, String(data.error ?? `Upload failed (${xhr.status}).`), String(data.code ?? "upload"), data));
        }
      };
      xhr.onerror = () => {
        if (retries < MAX_RETRIES) {
          retries++;
          onRetry?.(retries, MAX_RETRIES);
          setTimeout(sendNext, 1000 * 2 ** retries);
        } else {
          reject(new ApiError(0, "Network error during upload.", "network"));
        }
      };
      xhr.send(file.slice(offset, end));
    };
    sendNext();
  });
}
