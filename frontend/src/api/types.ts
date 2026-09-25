export type Role = "admin" | "member";
export type Locale = "en" | "zh-TW";

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  disabled: boolean;
  locale: Locale | null;
  createdAt: number;
  lastLoginAt: number | null;
}

export type MeetingStatus = "uploading" | "queued" | "processing" | "ready" | "failed";
export type SummaryStatus = "queued" | "running" | "done" | "failed" | "canceled";
export type OutputLanguage = "zh-TW" | "en" | "auto";
export type Script = "zh-TW" | "zh-CN" | "none";

export interface TranscribeOptions {
  language: string;
  diarize: boolean;
  numSpeakers: number | null;
  minSpeakers: number | null;
  maxSpeakers: number | null;
  vocabulary: string;
  script: Script;
}

export interface SummaryRequest {
  templateId: string | null;
  prompt: string;
  outputLanguage: OutputLanguage;
}

export interface MeetingSummary {
  id: string;
  title: string;
  occurredAt: number | null;
  status: MeetingStatus;
  stage: string | null;
  progress: number;
  error: string | null;
  media: {
    name: string;
    mime: string;
    size: number;
    received: number;
    hasVideo: boolean;
    hasPlayback: boolean;
    hasPeaks: boolean;
  };
  durationSec: number | null;
  language: string | null;
  options: TranscribeOptions;
  speakerCount: number;
  preview: string | null;
  summaryExcerpt: string | null;
  /** Present on search results: where the query occurs in the transcript. */
  match?: { text: string; start: number } | null;
  latestSummary: { id: string; status: SummaryStatus; createdAt: number } | null;
  createdAt: number;
  updatedAt: number;
  transcribedAt: number | null;
}

export interface Speaker {
  key: string;
  name: string;
  color: number;
}

export interface Segment {
  id: number;
  start: number;
  end: number;
  speaker: string | null;
  text: string;
  edited: boolean;
}

export interface Summary {
  id: string;
  meetingId: string;
  templateId: string | null;
  templateName: string | null;
  prompt: string;
  outputLanguage: OutputLanguage;
  status: SummaryStatus;
  content: string | null;
  error: string | null;
  model: string | null;
  usage: Record<string, number> | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface MeetingDetail extends MeetingSummary {
  autoSummary: SummaryRequest | null;
  speakers: Speaker[];
  segments: Segment[];
  summaries: Summary[];
}

export interface Template {
  id: string;
  builtin: boolean;
  name: string;
  description: string;
  body: string;
  updatedAt: number;
}

export interface SessionInfo {
  id: string;
  current: boolean;
  ip: string | null;
  userAgent: string | null;
  createdAt: number;
  lastSeenAt: number;
}

export interface AdminUser extends User {
  meetings: number;
}

export interface Invite {
  id: string;
  role: Role;
  note: string | null;
  createdAt: number;
  expiresAt: number;
  usedAt: number | null;
  usedBy: string | null;
}

export interface WorkerInfo {
  id: string;
  name: string;
  info: {
    gpu?: string;
    vramTotalGb?: number;
    vramFreeGb?: number;
    asrModel?: string;
    asrBackend?: string;
    diarization?: boolean;
    state?: string;
    jobId?: string | null;
    cuda?: boolean | null;
    modelsLoaded?: boolean;
    version?: string;
  };
  lastSeenAt: number;
  online: boolean;
}

export interface SystemInfo {
  workers: WorkerInfo[];
  jobs: { queued: number; running: number };
  summaries: { running: number; queued: number; concurrency: number };
  codex: { available: boolean; loggedIn: boolean; version: string | null; detail: string };
  disk: { freeBytes: number; totalBytes: number } | null;
  stats: { users: number; meetings: number; audioHours: number };
}

export interface Peaks {
  version: number;
  duration: number;
  pointsPerSecond: number;
  peaks: number[];
}
