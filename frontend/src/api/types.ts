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

/** Named settings for adding a recording, applied in one click; the default one by itself. */
export interface Preset {
  id: string;
  name: string;
  options: TranscribeOptions;
  /** The automatic summary; null for none. */
  summary: SummaryRequest | null;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export type PresetInput = Pick<Preset, "name" | "options" | "summary" | "isDefault">;

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
    /** The original was replaced by an audio-only Opus copy; any video is gone. */
    compacted?: boolean;
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
  /** Which kind of model wrote it; null while queued. */
  provider: SummaryProvider | null;
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
    /** A Mac: memory shared by the CPU and GPU (no free-memory figure; never checked before a job). */
    unifiedMemoryGb?: number | null;
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
    /** What the worker can run: without GPU packages, only the APIs. */
    capabilities?: { asr: string[]; diarization: string[] };
  };
  lastSeenAt: number;
  online: boolean;
}

export interface SystemInfo {
  workers: WorkerInfo[];
  /** Transcriptions; voiceprints are the background voice fingerprint jobs. */
  jobs: {
    queued: number;
    running: number;
    voiceprints?: { queued: number; running: number };
    compactions?: { queued: number; running: number };
  };
  summaries: { running: number; queued: number; concurrency: number; provider: SummaryProvider };
  transcriber?: TranscriberInfo;
  disk: { freeBytes: number; totalBytes: number } | null;
  stats: { users: number; meetings: number; audioHours: number };
}

export interface Peaks {
  version: number;
  duration: number;
  pointsPerSecond: number;
  peaks: number[];
}

export type SummaryProvider = "local" | "api";
/** Hosted providers that can write summaries (each with a fixed address). */
export type ApiProvider = "anthropic" | "openai" | "openrouter" | "gemini";

/** Where summaries are written, as shown to everyone who starts one. */
export interface SummarizerInfo {
  provider: SummaryProvider;
  /** The hosted provider, for provider "api". */
  vendor: ApiProvider | null;
  model: string | null;
  /** A local model on this machine: transcripts never leave the server. */
  onServer: boolean;
  /** Host the transcript is sent to: the provider's, or a model server's on another machine. */
  host: string | null;
}

export type AsrEngine = "local" | "api";
export type AsrProvider = "openrouter" | "openai";
export type DiarizationEngine = "local" | "cpu" | "pyannoteai";
export type ApiKeyName = AsrProvider | "pyannoteai";

/** Where recordings are transcribed, as everyone signed in is told. */
export interface TranscriberInfo {
  engine: AsrEngine;
  /** Who separates speakers; with pyannoteAI the whole recording is uploaded there. Absent from older servers. */
  diarization?: DiarizationEngine;
  provider: AsrProvider | null;
  model: string | null;
  /** The recording stays on this machine (the local model, or an API server on this machine). */
  onServer: boolean;
  /** Host speech is sent to; null when it stays on this machine. */
  host: string | null;
  /** Some machines recognise speech locally and some through the API (each worker has its own settings). */
  mixed?: boolean;
  /** Some machines separate speakers with pyannoteAI and some do not. */
  diarizationMixed?: boolean;
}

export interface TranscriberSettings {
  engine: AsrEngine;
  diarization: DiarizationEngine;
  api: {
    provider: AsrProvider;
    /** OpenAI-compatible servers only; empty means api.openai.com. */
    baseUrl: string;
    model: string;
  };
}

export interface TranscriberState {
  settings: TranscriberSettings;
  /** What .env says; in force while nothing is saved. */
  defaults: TranscriberSettings;
  saved: boolean;
  updatedAt: number | null;
  updatedBy: string | null;
  /** Online workers and which providers each has a key for; null keys: a worker too old for API transcription. */
  workers: {
    id: string;
    name: string;
    keys: Record<ApiKeyName, boolean> | null;
    /** What the worker can run; null for one from before pyannoteAI (local models only, plus the transcription API). */
    capabilities: { asr: string[]; diarization: string[] } | null;
  }[];
  /** Environment variables a worker reads the key from, per provider. */
  keyVariables: Record<ApiKeyName, string[]>;
  addresses: Record<AsrProvider, string>;
}

/** A machine's own choices over the site-wide transcription settings; null follows them. */
export interface WorkerProfile {
  engine: AsrEngine | null;
  diarization: DiarizationEngine | null;
  /** Takes a job only after it has waited this long while another worker is online; null: not a fallback. */
  fallbackSec: number | null;
}

/** A worker on another machine, as the admin page lists it (never its token). */
export interface WorkerKey {
  id: string;
  name: string;
  createdAt: number;
  createdBy: string | null;
  pending: boolean;
  enrollExpiresAt: number | null;
  enrolledAt: number | null;
  lastUsedAt: number | null;
  lastIp: string | null;
  revokedAt: number | null;
  online: boolean;
}

/** Whether originals are later kept as audio only. */
export interface MediaPolicy {
  compact: boolean;
  /** Days after transcription. */
  afterDays: number;
}

export interface MediaState {
  settings: MediaPolicy;
  defaults: MediaPolicy;
  saved: boolean;
  updatedAt: number | null;
  updatedBy: string | null;
  stats: {
    compacted: number;
    savedBytes: number;
    /** Not compacted yet, due or not, and what compacting them would save. */
    candidates: number;
    candidateSavingBytes: number;
    due: number;
    dueSavingBytes: number;
    failed: number;
    bitrateKbps: number;
  };
}

export type LocalModelApi = "ollama" | "openai";

export interface LocalModelSettings {
  api: LocalModelApi;
  baseUrl: string;
  model: string;
  contextTokens: number;
  think: boolean;
  keepAliveSec: number;
}

export interface ApiModelSettings {
  provider: ApiProvider;
  model: string;
  /** Context to use when the provider does not report the model's. */
  contextTokens: number;
}

export interface SummarySettings {
  provider: SummaryProvider;
  local: LocalModelSettings;
  api: ApiModelSettings;
}

export interface ApiProviderInfo {
  label: string;
  /** Environment variables that hold its key. */
  keyVariables: string[];
  host: string;
  defaultModel: string;
}

/** A hosted model checked before saving: its limits, or what is wrong. */
export interface ApiModelProbe {
  ok: boolean;
  keyConfigured: boolean;
  contextLength?: number | null;
  maxOutputTokens?: number | null;
  error?: string;
}

export interface SummarizerState {
  settings: SummarySettings;
  /** What .env says; in force while nothing is saved. */
  defaults: SummarySettings;
  saved: boolean;
  updatedAt: number | null;
  updatedBy: string | null;
  /** LLM_API_KEY is set in .env (the key itself never reaches the browser). */
  apiKeyConfigured: boolean;
  /** Which hosted providers have a key in .env (never the keys). */
  apiKeys: Record<ApiProvider, boolean>;
  apiProviders: Record<ApiProvider, ApiProviderInfo>;
}

export interface LocalModelStatus {
  reachable: boolean;
  server: string | null;
  models: { name: string; size: number | null; details: string | null }[];
  installed: boolean;
  loaded: { sizeBytes: number; vramBytes: number } | null;
  contextLength: number | null;
  thinking: boolean | null;
  error: string | null;
}

export interface ModelPull {
  model: string;
  baseUrl: string;
  status: string;
  completed: number | null;
  total: number | null;
  done: boolean;
  error: string | null;
  startedAt: number;
}
