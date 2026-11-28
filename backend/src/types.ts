export type Role = "admin" | "member";

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: Role;
  disabled: number;
  locale: string | null;
  /** "system", "light" or "dark"; null until chosen. */
  theme: string | null;
  /** 1: the person uses the new interface (a preview). */
  new_ui: number;
  /** Days to keep recordings (7 or 30); null: as long as the site keeps them. */
  media_retention_days: number | null;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
  /** Recognise speakers by voice and remember the voices this user names. */
  voice_recognition: number;
  email: string | null;
  email_verified_at: number | null;
  /** "exempt": never charged (invited accounts, and all from before billing); "prepaid": pays with points. */
  billing: "exempt" | "prepaid";
  /** Prepaid points left, in thousandths of a point. */
  credits: number;
}

export interface SessionRow {
  id: string;
  token_hash: string;
  user_id: string;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
  ip: string | null;
  user_agent: string | null;
}

export type MeetingStatus = "uploading" | "queued" | "processing" | "ready" | "failed";

export interface TranscribeOptions {
  /** "auto" or a Qwen3-ASR language name such as "Chinese" / "English". */
  language: string;
  diarize: boolean;
  numSpeakers: number | null;
  minSpeakers: number | null;
  maxSpeakers: number | null;
  /** Names, jargon and acronyms fed to the ASR model as context. */
  vocabulary: string;
  /** Chinese script normalisation applied after ASR. */
  script: "zh-TW" | "zh-CN" | "none";
  /** Correct the transcript with a hosted model from the meeting's topic once it is transcribed. */
  refine: boolean;
}

export type OutputLanguage = "zh-TW" | "en" | "auto";

export interface SummaryRequest {
  templateId: string | null;
  prompt: string;
  outputLanguage: OutputLanguage;
}

export interface MeetingRow {
  id: string;
  /** The length the browser read from the file when it was added (seconds), if it could. */
  declared_sec: number | null;
  owner_id: string;
  title: string;
  occurred_at: number | null;
  status: MeetingStatus;
  stage: string | null;
  progress: number;
  error: string | null;
  media_name: string;
  media_mime: string;
  media_size: number;
  media_received: number;
  media_ext: string;
  has_video: number;
  has_playback: number;
  has_peaks: number;
  duration_sec: number | null;
  language: string | null;
  options: string;
  auto_summary: string | null;
  created_at: number;
  updated_at: number;
  transcribed_at: number | null;
  /** JSON DiarizationOutcome of the latest transcription; null before this was recorded. */
  diarization: string | null;
  /** When the original was replaced by a compact audio-only copy (Opus); null while it is as uploaded. */
  compacted_at: number | null;
  /** Size of the original as uploaded, once it has been compacted. */
  original_size: number | null;
  /** When the recording was deleted under the retention period (the transcript stays). */
  media_deleted_at: number | null;
}

export type VoiceStatus = "confirmed" | "auto" | "suggested" | "rejected" | "ignored";

export interface SpeakerRow {
  meeting_id: string;
  key: string;
  name: string;
  color: number;
  /** Voice fingerprint: unit-length Float32 speaker embedding. */
  voice: Uint8Array | null;
  voice_model: string | null;
  speech_sec: number | null;
  profile_id: string | null;
  voice_status: VoiceStatus | null;
  voice_score: number | null;
  /** The name before recognition renamed this speaker; restored if the user rejects it. */
  name_before: string | null;
}

export interface VoiceProfileRow {
  id: string;
  owner_id: string;
  name: string;
  created_at: number;
  updated_at: number;
}

export interface VoiceSampleRow {
  id: number;
  profile_id: string;
  meeting_id: string | null;
  speaker_key: string | null;
  model: string;
  embedding: Uint8Array;
  speech_sec: number;
  created_at: number;
}

export interface SegmentRow {
  id: number;
  meeting_id: string;
  idx: number;
  start_sec: number;
  end_sec: number;
  speaker: string | null;
  text: string;
  edited: number;
  /** The text before the transcript was corrected with a hosted model (null: not corrected). */
  original_text: string | null;
}

export interface RefinementRow {
  id: string;
  meeting_id: string;
  created_by: string | null;
  status: "queued" | "running" | "done" | "failed" | "canceled";
  error: string | null;
  model: string | null;
  usage: string | null;
  topic: string | null;
  changed: number | null;
  hold: number | null;
  charged: number | null;
  /** The automatic summary to write once the transcript is corrected (JSON SummaryRequest). */
  then_summary: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export type SummaryProvider = "local" | "api";

export type SummaryStatus = "queued" | "running" | "done" | "failed" | "canceled";

export interface SummaryRow {
  id: string;
  /** Prepaid: points (thousandths) set aside while queued or running, and charged when done. */
  hold: number | null;
  charged: number | null;
  meeting_id: string;
  created_by: string | null;
  template_id: string | null;
  template_name: string | null;
  prompt: string;
  output_language: OutputLanguage;
  status: SummaryStatus;
  content: string | null;
  error: string | null;
  model: string | null;
  usage: string | null;
  /** JSON: speaker key → the name this summary uses; null until written. */
  speaker_names: string | null;
  /** Which kind of model wrote it (set when it starts); null while queued. "codex": written before Codex was removed. */
  provider: SummaryProvider | "codex" | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

export interface TemplateRow {
  id: string;
  owner_id: string | null;
  builtin: number;
  name: string;
  description: string;
  body: string;
  sort: number;
  created_at: number;
  updated_at: number;
}

export type JobKind = "transcribe" | "voiceprint" | "compact";

export interface JobRow {
  id: string;
  meeting_id: string;
  kind: JobKind;
  /** voiceprint jobs: also remember the speakers named before voice profiles existed. */
  learn: number;
  status: "queued" | "running" | "done" | "failed" | "canceled";
  worker_id: string | null;
  attempts: number;
  error: string | null;
  created_at: number;
  claimed_at: number | null;
  heartbeat_at: number | null;
  finished_at: number | null;
  /** Prepaid transcriptions: points (thousandths) set aside while the job is queued or running, and charged. */
  hold: number | null;
  charged: number | null;
  /** Prepaid transcriptions: the most audio (seconds) the worker was told it may transcribe; nothing longer is charged. */
  max_sec: number | null;
}

export type AppEnv = {
  Variables: {
    user: UserRow;
    session: SessionRow;
    clientIp: string;
    /** The error code an answer carried (set by app.onError), for the security monitor. */
    errorCode: string | undefined;
    /** The username a sign-in tried, for the security monitor. */
    attemptedUser: string | undefined;
    /** On the worker API: a worker on this machine (shared token) or a remote one (its key). */
    worker: { local: boolean; keyId: string | null };
  };
};
