export type Role = "admin" | "member";

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  password_hash: string;
  role: Role;
  disabled: number;
  locale: string | null;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
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
}

export type OutputLanguage = "zh-TW" | "en" | "auto";

export interface SummaryRequest {
  templateId: string | null;
  prompt: string;
  outputLanguage: OutputLanguage;
}

export interface MeetingRow {
  id: string;
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
}

export interface SpeakerRow {
  meeting_id: string;
  key: string;
  name: string;
  color: number;
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
}

export type SummaryStatus = "queued" | "running" | "done" | "failed" | "canceled";

export interface SummaryRow {
  id: string;
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

export interface JobRow {
  id: string;
  meeting_id: string;
  status: "queued" | "running" | "done" | "failed" | "canceled";
  worker_id: string | null;
  attempts: number;
  error: string | null;
  created_at: number;
  claimed_at: number | null;
  heartbeat_at: number | null;
  finished_at: number | null;
}

export type AppEnv = {
  Variables: {
    user: UserRow;
    session: SessionRow;
    clientIp: string;
  };
};
