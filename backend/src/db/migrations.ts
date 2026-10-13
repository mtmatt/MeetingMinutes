/**
 * Ordered schema migrations. Each entry runs once, inside a transaction, and
 * bumps PRAGMA user_version. Never edit an entry that has shipped; append a new one.
 * All timestamps are Unix epoch milliseconds.
 */
export const migrations: string[] = [
  `
  CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
    display_name  TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role          TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    disabled      INTEGER NOT NULL DEFAULT 0,
    locale        TEXT,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    last_login_at INTEGER
  );

  CREATE TABLE sessions (
    id           TEXT PRIMARY KEY,
    token_hash   TEXT NOT NULL UNIQUE,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    ip           TEXT,
    user_agent   TEXT
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  -- Single-use links: 'invite' creates an account, 'reset' sets a new password for target_user_id.
  CREATE TABLE invites (
    id             TEXT PRIMARY KEY,
    token_hash     TEXT NOT NULL UNIQUE,
    kind           TEXT NOT NULL CHECK (kind IN ('invite', 'reset')),
    role           TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
    note           TEXT,
    target_user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
    created_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at     INTEGER NOT NULL,
    expires_at     INTEGER NOT NULL,
    used_at        INTEGER,
    used_by        TEXT REFERENCES users(id) ON DELETE SET NULL
  );

  CREATE TABLE meetings (
    id              TEXT PRIMARY KEY,
    owner_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title           TEXT NOT NULL,
    occurred_at     INTEGER,
    status          TEXT NOT NULL CHECK (status IN ('uploading', 'queued', 'processing', 'ready', 'failed')),
    stage           TEXT,
    progress        REAL NOT NULL DEFAULT 0,
    error           TEXT,
    media_name      TEXT NOT NULL,
    media_mime      TEXT NOT NULL,
    media_size      INTEGER NOT NULL,
    media_received  INTEGER NOT NULL DEFAULT 0,
    media_ext       TEXT NOT NULL,
    has_video       INTEGER NOT NULL DEFAULT 0,
    has_playback    INTEGER NOT NULL DEFAULT 0,
    has_peaks       INTEGER NOT NULL DEFAULT 0,
    duration_sec    REAL,
    language        TEXT,
    options         TEXT NOT NULL DEFAULT '{}',
    auto_summary    TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    transcribed_at  INTEGER
  );
  CREATE INDEX meetings_owner ON meetings(owner_id, created_at DESC);

  CREATE TABLE speakers (
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    key        TEXT NOT NULL,
    name       TEXT NOT NULL,
    color      INTEGER NOT NULL,
    PRIMARY KEY (meeting_id, key)
  );

  CREATE TABLE segments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    idx        INTEGER NOT NULL,
    start_sec  REAL NOT NULL,
    end_sec    REAL NOT NULL,
    speaker    TEXT,
    text       TEXT NOT NULL,
    edited     INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX segments_meeting ON segments(meeting_id, idx);

  CREATE TABLE templates (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT REFERENCES users(id) ON DELETE CASCADE,
    builtin     INTEGER NOT NULL DEFAULT 0,
    name        TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    body        TEXT NOT NULL,
    sort        INTEGER NOT NULL DEFAULT 0,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX templates_owner ON templates(owner_id);

  CREATE TABLE summaries (
    id              TEXT PRIMARY KEY,
    meeting_id      TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
    template_id     TEXT,
    template_name   TEXT,
    prompt          TEXT NOT NULL,
    output_language TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'canceled')),
    content         TEXT,
    error           TEXT,
    model           TEXT,
    usage           TEXT,
    created_at      INTEGER NOT NULL,
    started_at      INTEGER,
    finished_at     INTEGER
  );
  CREATE INDEX summaries_meeting ON summaries(meeting_id, created_at DESC);
  CREATE INDEX summaries_status ON summaries(status, created_at);

  CREATE TABLE jobs (
    id           TEXT PRIMARY KEY,
    meeting_id   TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    status       TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'canceled')),
    worker_id    TEXT,
    attempts     INTEGER NOT NULL DEFAULT 0,
    error        TEXT,
    created_at   INTEGER NOT NULL,
    claimed_at   INTEGER,
    heartbeat_at INTEGER,
    finished_at  INTEGER
  );
  CREATE INDEX jobs_status ON jobs(status, created_at);

  CREATE TABLE workers (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    info         TEXT NOT NULL DEFAULT '{}',
    last_seen_at INTEGER NOT NULL
  );
  `,
  // Whether speaker diarization ran for the latest transcription, and why not.
  `ALTER TABLE meetings ADD COLUMN diarization TEXT;`,
  // Invitation links usable a set number of times. used_at now marks the use
  // that exhausted the link (or its only use); invite_uses records every one.
  `
  ALTER TABLE invites ADD COLUMN max_uses INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE invites ADD COLUMN use_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE invites ADD COLUMN revoked_at INTEGER;
  CREATE TABLE invite_uses (
    invite_id TEXT NOT NULL REFERENCES invites(id) ON DELETE CASCADE,
    user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
    used_at   INTEGER NOT NULL
  );
  CREATE INDEX invite_uses_invite ON invite_uses(invite_id, used_at);
  UPDATE invites SET use_count = 1 WHERE used_at IS NOT NULL;
  INSERT INTO invite_uses (invite_id, user_id, used_at) SELECT id, used_by, used_at FROM invites WHERE used_at IS NOT NULL;
  `,
  // The speaker names each summary was written with (JSON: speaker key → name),
  // so renaming a speaker can update exactly that name. Existing summaries are
  // assumed to use the current names.
  `
  ALTER TABLE summaries ADD COLUMN speaker_names TEXT;
  UPDATE summaries SET speaker_names = (
    SELECT COALESCE(json_group_object(key, name), '{}') FROM speakers WHERE speakers.meeting_id = summaries.meeting_id
  ) WHERE content IS NOT NULL;
  `,
  // Voice profiles: people a user has named, remembered by their voice, so they
  // are recognised in later recordings. A sample is one meeting speaker's voice
  // fingerprint (a unit-length Float32 speaker embedding); it outlives the
  // meeting it came from (meeting_id then becomes NULL) until the profile or
  // the sample is deleted. speaker_key is cleared when that meeting's speakers
  // are separated again.
  //
  // speakers.voice_status: confirmed (the user named them: their voice is a
  // sample of profile_id), auto (named by recognition, not yet confirmed;
  // name_before is restored if rejected), suggested (a possible match shown to
  // the user, name unchanged), rejected (the user said a guess was wrong: not
  // guessed again, but remembered once the user names them), ignored (the
  // user asked not to remember this voice: never recognised or remembered).
  //
  // jobs.kind: transcribe, or voiceprint (fingerprints of an older meeting's
  // speakers; learn: also remember the speakers named before profiles existed).
  `
  ALTER TABLE users ADD COLUMN voice_recognition INTEGER NOT NULL DEFAULT 1;
  CREATE TABLE voice_profiles (
    id         TEXT PRIMARY KEY,
    owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL COLLATE NOCASE,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX voice_profiles_name ON voice_profiles(owner_id, name);
  CREATE TABLE voice_samples (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_id  TEXT NOT NULL REFERENCES voice_profiles(id) ON DELETE CASCADE,
    meeting_id  TEXT REFERENCES meetings(id) ON DELETE SET NULL,
    speaker_key TEXT,
    model       TEXT NOT NULL,
    embedding   BLOB NOT NULL,
    speech_sec  REAL NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX voice_samples_speaker ON voice_samples(meeting_id, speaker_key);
  CREATE INDEX voice_samples_profile ON voice_samples(profile_id);
  ALTER TABLE speakers ADD COLUMN voice BLOB;
  ALTER TABLE speakers ADD COLUMN voice_model TEXT;
  ALTER TABLE speakers ADD COLUMN speech_sec REAL;
  ALTER TABLE speakers ADD COLUMN profile_id TEXT REFERENCES voice_profiles(id) ON DELETE SET NULL;
  ALTER TABLE speakers ADD COLUMN voice_status TEXT CHECK (voice_status IN ('confirmed', 'auto', 'suggested', 'rejected', 'ignored'));
  ALTER TABLE speakers ADD COLUMN voice_score REAL;
  ALTER TABLE speakers ADD COLUMN name_before TEXT;
  CREATE INDEX speakers_profile ON speakers(profile_id) WHERE profile_id IS NOT NULL;
  ALTER TABLE jobs ADD COLUMN kind TEXT NOT NULL DEFAULT 'transcribe' CHECK (kind IN ('transcribe', 'voiceprint'));
  ALTER TABLE jobs ADD COLUMN learn INTEGER NOT NULL DEFAULT 0;
  `,
];
