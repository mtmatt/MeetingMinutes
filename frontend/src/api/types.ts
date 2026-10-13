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
  /** Whether speaker diarization ran in the latest transcription; null for transcripts made before this was recorded. */
  diarization: { status: "ok" | "off" | "unavailable" | "failed"; reason?: string | null; speakers?: number } | null;
  createdAt: number;
  updatedAt: number;
  transcribedAt: number | null;
}

/**
 * Voice recognition state of a meeting's speaker.
 * confirmed: named by the user; their voice is remembered under that name.
 * auto: named by recognition; the user has not confirmed it yet.
 * suggested: sounds like `profile`, name unchanged.
 * rejected: the user said a guess was wrong; not guessed again.
 * ignored: the user asked not to remember this voice.
 */
export type VoiceStatus = "confirmed" | "auto" | "suggested" | "rejected" | "ignored";

export interface SpeakerVoice {
  status: VoiceStatus | null;
  /** Still a default label ("Speaker 2"), which is never remembered as a voice. */
  defaultName: boolean;
  profile: { id: string; name: string } | null;
  /** Similarity to the profile's voice, for recognised and suggested speakers. */
  score: number | null;
  /** Whether the speaker has a usable voice fingerprint. */
  fingerprint: boolean;
  speechSec: number | null;
}

export interface Speaker {
  key: string;
  name: string;
  color: number;
  voice: SpeakerVoice | null;
}

/** What happened to a speaker's voice after naming or answering about it. */
export interface VoiceOutcome {
  remembered: "remembered" | "short" | "pending" | "off";
  profile: { id: string; name: string } | null;
}

export interface VoiceSample {
  id: number;
  meetingId: string | null;
  meetingTitle: string | null;
  speakerKey: string | null;
  speakerName: string | null;
  speechSec: number;
  createdAt: number;
}

export interface VoiceProfile {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  speechSec: number;
  /** False when its samples sound like different people. */
  consistent: boolean;
  /** Speakers named after it by recognition and not yet confirmed, and speakers it is suggested for. */
  recognised: number;
  suggested: number;
  /** Where recognition named a speaker after this person, waiting to be confirmed. */
  awaiting: { meetingId: string; meetingTitle: string; speakerKey: string; score: number | null }[];
  samples: VoiceSample[];
}

export interface VoicesState {
  enabled: boolean;
  minSpeechSec: number;
  profiles: VoiceProfile[];
  /** Recordings waiting for (or getting) voice fingerprints; failed: whose last attempt failed, with the latest error. */
  scan: { queued: number; running: number; failed: number; error: string | null };
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
  /** Speaker key → the name this summary uses; null until it is written. */
  speakerNames: Record<string, string> | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}

export interface MeetingDetail extends MeetingSummary {
  autoSummary: SummaryRequest | null;
  /** Whether the owner has voice recognition on. */
  voiceRecognition: boolean;
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
  maxUses: number;
  useCount: number;
  status: "active" | "used_up" | "revoked" | "expired";
  /** Usernames of the people who joined through it, oldest first. */
  usedBy: string[];
  /** When it was used up. */
  usedAt: number | null;
  revokedAt: number | null;
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
    /** Speaker diarization as found by the worker's last GPU session ("unknown" before any). Older workers sent a boolean. */
    diarization?: "unknown" | "ready" | "unavailable" | boolean;
    diarizationError?: string | null;
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
  /** Transcriptions; voiceprints are the background voice fingerprint jobs. */
  jobs: { queued: number; running: number; voiceprints?: { queued: number; running: number } };
  summaries: { running: number; queued: number; concurrency: number };
  /** isolationError: summaries are paused because Codex tools cannot be verified as disabled. */
  codex: { available: boolean; loggedIn: boolean; version: string | null; detail: string; isolationError?: string | null };
  disk: { freeBytes: number; totalBytes: number } | null;
  stats: { users: number; meetings: number; audioHours: number };
}

export interface Peaks {
  version: number;
  duration: number;
  pointsPerSecond: number;
  peaks: number[];
}
