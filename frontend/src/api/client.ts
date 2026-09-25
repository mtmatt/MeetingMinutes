import type {
  AdminUser,
  Invite,
  MeetingDetail,
  MeetingSummary,
  Peaks,
  SessionInfo,
  Summary,
  SummaryRequest,
  SystemInfo,
  Template,
  TranscribeOptions,
  User,
} from "./types";

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
const post = <T>(p: string, b: Json = {}) => request<T>("POST", p, b);
const patch = <T>(p: string, b: Json) => request<T>("PATCH", p, b);
const del = <T>(p: string) => request<T>("DELETE", p);

export const api = {
  // auth
  authState: () => get<{ needsSetup: boolean; user: User | null; helpContact: string | null }>("/auth/state"),
  login: (username: string, password: string) => post<{ user: User }>("/auth/login", { username, password }),
  logout: () => post<{ ok: true }>("/auth/logout"),
  setup: (b: { setupToken: string; username: string; displayName: string; password: string }) =>
    post<{ user: User }>("/auth/setup", b),
  inviteInfo: (token: string) =>
    get<{ kind: "invite" | "reset"; role: string; username: string | null; expiresAt: number }>(`/auth/invites/${encodeURIComponent(token)}`),
  acceptInvite: (token: string, b: { username?: string; displayName?: string; password: string }) =>
    post<{ user: User }>(`/auth/invites/${encodeURIComponent(token)}/accept`, b),

  // me
  updateMe: (b: { displayName?: string; locale?: string | null }) => patch<{ user: User }>("/me", b),
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
  }) => post<{ meeting: MeetingSummary; chunkSize: number }>("/meetings", b),
  completeUpload: (id: string) => post<{ meeting: MeetingSummary }>(`/meetings/${id}/upload/complete`),
  updateMeeting: (id: string, b: { title?: string; occurredAt?: number | null }) =>
    patch<{ meeting: MeetingSummary }>(`/meetings/${id}`, b),
  deleteMeeting: (id: string) => del<{ ok: true }>(`/meetings/${id}`),
  retranscribe: (id: string, options?: TranscribeOptions) =>
    post<{ meeting: MeetingSummary }>(`/meetings/${id}/retranscribe`, options ? { options } : {}),
  renameSpeaker: (id: string, key: string, name: string) =>
    patch<{ ok: true }>(`/meetings/${id}/speakers/${encodeURIComponent(key)}`, { name }),
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

  // templates
  templates: () => get<{ templates: Template[] }>("/templates"),
  createTemplate: (b: { name: string; description: string; body: string }) => post<{ template: Template }>("/templates", b),
  updateTemplate: (id: string, b: { name?: string; description?: string; body?: string }) =>
    patch<{ template: Template }>(`/templates/${id}`, b),
  deleteTemplate: (id: string) => del<{ ok: true }>(`/templates/${id}`),

  // admin
  adminUsers: () => get<{ users: AdminUser[] }>("/admin/users"),
  adminUpdateUser: (id: string, b: { role?: string; disabled?: boolean; displayName?: string }) =>
    patch<{ user: User }>(`/admin/users/${id}`, b),
  adminDeleteUser: (id: string) => del<{ ok: true }>(`/admin/users/${id}`),
  adminResetLink: (id: string) => post<{ url: string; expiresAt: number }>(`/admin/users/${id}/reset-link`),
  adminInvites: () => get<{ invites: Invite[] }>("/admin/invites"),
  adminCreateInvite: (b: { role: string; note: string | null; ttlHours: number }) =>
    post<{ url: string; invite: Invite }>("/admin/invites", b),
  adminDeleteInvite: (id: string) => del<{ ok: true }>(`/admin/invites/${id}`),
  adminSystem: () => get<SystemInfo>("/admin/system"),
};

export const mediaUrl = {
  audio: (id: string) => `/api/meetings/${id}/media/audio`,
  original: (id: string, download = false) => `/api/meetings/${id}/media/original${download ? "?download=1" : ""}`,
  export: (id: string, format: string) => `/api/meetings/${id}/export?format=${format}`,
};

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
        } else if (xhr.status >= 500 && retries < 5) {
          retries++;
          setTimeout(sendNext, 1000 * 2 ** retries);
        } else {
          reject(new ApiError(xhr.status, String(data.error ?? `Upload failed (${xhr.status}).`), String(data.code ?? "upload")));
        }
      };
      xhr.onerror = () => {
        if (retries < 5) {
          retries++;
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
