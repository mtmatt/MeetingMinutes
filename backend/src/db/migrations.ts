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
  // Server-wide settings an administrator changes on the admin page (JSON
  // values), starting with which model writes summaries. summaries.provider
  // records which one wrote each summary; everything before this was Codex.
  `
  CREATE TABLE settings (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
  );
  ALTER TABLE summaries ADD COLUMN provider TEXT CHECK (provider IN ('local', 'codex'));
  UPDATE summaries SET provider = 'codex' WHERE status IN ('running', 'done', 'failed');
  `,
  // Compact originals: once a meeting has been transcribed (and some days have
  // passed), its original can be replaced by an audio-only Opus copy, which
  // drops any video. jobs.kind gains 'compact'; SQLite cannot change a CHECK
  // constraint, so the jobs table is rebuilt (nothing references it).
  `
  CREATE TABLE jobs_new (
    id           TEXT PRIMARY KEY,
    meeting_id   TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    status       TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'canceled')),
    worker_id    TEXT,
    attempts     INTEGER NOT NULL DEFAULT 0,
    error        TEXT,
    created_at   INTEGER NOT NULL,
    claimed_at   INTEGER,
    heartbeat_at INTEGER,
    finished_at  INTEGER,
    kind         TEXT NOT NULL DEFAULT 'transcribe' CHECK (kind IN ('transcribe', 'voiceprint', 'compact')),
    learn        INTEGER NOT NULL DEFAULT 0
  );
  INSERT INTO jobs_new (id, meeting_id, status, worker_id, attempts, error, created_at, claimed_at, heartbeat_at, finished_at, kind, learn)
    SELECT id, meeting_id, status, worker_id, attempts, error, created_at, claimed_at, heartbeat_at, finished_at, kind, learn FROM jobs;
  DROP TABLE jobs;
  ALTER TABLE jobs_new RENAME TO jobs;
  CREATE INDEX jobs_status ON jobs(status, created_at);
  CREATE INDEX jobs_meeting ON jobs(meeting_id, status);
  ALTER TABLE meetings ADD COLUMN compacted_at INTEGER;
  ALTER TABLE meetings ADD COLUMN original_size INTEGER;
  `,
  // Workers on other machines: each has its own revocable credential
  // (services/workerKeys.ts), traded once for a short-lived enrollment code.
  `
  CREATE TABLE worker_keys (
    id                TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    token_hash        TEXT,
    enroll_hash       TEXT,
    enroll_expires_at INTEGER,
    created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at        INTEGER NOT NULL,
    enrolled_at       INTEGER,
    last_used_at      INTEGER,
    last_ip           TEXT,
    revoked_at        INTEGER
  );
  CREATE UNIQUE INDEX worker_keys_token ON worker_keys(token_hash) WHERE token_hash IS NOT NULL;
  CREATE UNIQUE INDEX worker_keys_enroll ON worker_keys(enroll_hash) WHERE enroll_hash IS NOT NULL;
  `,
  // Hosted APIs replace Codex: summaries.provider gains 'api' ('codex' stays for
  // summaries written before). SQLite cannot change a CHECK constraint, so the
  // table is rebuilt (nothing references it).
  `
  CREATE TABLE summaries_new (
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
    finished_at     INTEGER,
    speaker_names   TEXT,
    provider        TEXT CHECK (provider IN ('local', 'api', 'codex'))
  );
  INSERT INTO summaries_new (id, meeting_id, created_by, template_id, template_name, prompt, output_language, status, content, error, model, usage, created_at, started_at, finished_at, speaker_names, provider)
    SELECT id, meeting_id, created_by, template_id, template_name, prompt, output_language, status, content, error, model, usage, created_at, started_at, finished_at, speaker_names, provider FROM summaries;
  DROP TABLE summaries;
  ALTER TABLE summaries_new RENAME TO summaries;
  CREATE INDEX summaries_meeting ON summaries(meeting_id, created_at DESC);
  CREATE INDEX summaries_status ON summaries(status, created_at);
  `,
  // Presets: named transcription and automatic-summary settings a person
  // applies when adding a recording; at most one per person is the default.
  `
  CREATE TABLE transcribe_presets (
    id         TEXT PRIMARY KEY,
    owner_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    options    TEXT NOT NULL,
    summary    TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX transcribe_presets_name ON transcribe_presets(owner_id, name);
  CREATE UNIQUE INDEX transcribe_presets_default ON transcribe_presets(owner_id) WHERE is_default = 1;
  `,
  // The colour theme, with the account (like the language), instead of only in one browser.
  `ALTER TABLE users ADD COLUMN theme TEXT CHECK (theme IN ('system', 'light', 'dark'));`,
  // Signing up with an email address, and paying with prepaid points: transcription by the
  // minute of recording, summaries by the tokens the model read and wrote.
  // Accounts from before (and invited ones) stay 'exempt': they are never charged.
  `
  ALTER TABLE users ADD COLUMN email TEXT;
  ALTER TABLE users ADD COLUMN email_verified_at INTEGER;
  ALTER TABLE users ADD COLUMN billing TEXT NOT NULL DEFAULT 'exempt' CHECK (billing IN ('exempt', 'prepaid'));
  -- Prepaid points left, in thousandths of a point (rates may be fractions of a point).
  ALTER TABLE users ADD COLUMN credits INTEGER NOT NULL DEFAULT 0;
  CREATE UNIQUE INDEX users_email ON users(email COLLATE NOCASE) WHERE email IS NOT NULL;

  -- A link sent to confirm an address: at sign-up, or when someone changes theirs.
  CREATE TABLE email_verifications (
    id         TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    email      TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at    INTEGER
  );
  CREATE INDEX email_verifications_user ON email_verifications(user_id);

  -- Every change of a balance (thousandths of a point), with the balance after it.
  CREATE TABLE credit_ledger (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    delta       INTEGER NOT NULL,
    balance     INTEGER NOT NULL,
    kind        TEXT NOT NULL CHECK (kind IN ('purchase', 'transcription', 'summary', 'adjust')),
    -- Usage: the meeting (it may since have been deleted, so its title is kept too),
    -- and what was used: {"sec": 3600} or {"input": 12000, "output": 900}.
    meeting_id  TEXT,
    title       TEXT,
    quantity    TEXT,
    order_id    TEXT,
    note        TEXT,
    created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX credit_ledger_user ON credit_ledger(user_id, id DESC);

  -- An order sent to ECPay; its id is the MerchantTradeNo.
  CREATE TABLE payment_orders (
    id           TEXT PRIMARY KEY,
    user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
    package_id   TEXT NOT NULL,
    points       INTEGER NOT NULL,
    amount       INTEGER NOT NULL,
    item_name    TEXT NOT NULL,
    status       TEXT NOT NULL CHECK (status IN ('pending', 'paid', 'failed')),
    mode         TEXT NOT NULL CHECK (mode IN ('stage', 'production')),
    merchant_id  TEXT NOT NULL,
    -- From ECPay: its trade number, how it was paid, and for ATM / convenience-store
    -- payments the account or code to pay to (JSON).
    trade_no     TEXT,
    payment_type TEXT,
    payment_info TEXT,
    error        TEXT,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    paid_at      INTEGER
  );
  CREATE INDEX payment_orders_user ON payment_orders(user_id, created_at DESC);
  CREATE INDEX payment_orders_status ON payment_orders(status, created_at DESC);

  -- The length the browser read from the file, to check a balance before anything is uploaded.
  ALTER TABLE meetings ADD COLUMN declared_sec REAL;
  -- Prepaid work: the points (thousandths) set aside while queued or running, and what was charged.
  ALTER TABLE jobs ADD COLUMN hold INTEGER;
  ALTER TABLE jobs ADD COLUMN charged INTEGER;
  ALTER TABLE summaries ADD COLUMN hold INTEGER;
  ALTER TABLE summaries ADD COLUMN charged INTEGER;
  `,
  // Security monitor: suspicious requests counted per kind, address, account tried and
  // minute (a flood is a few rows), and addresses blocked automatically or by hand.
  `
  CREATE TABLE security_events (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL,
    severity   TEXT NOT NULL CHECK (severity IN ('info', 'warn', 'high')),
    ip         TEXT NOT NULL,
    username   TEXT NOT NULL DEFAULT '',
    user_id    TEXT,
    detail     TEXT,
    count      INTEGER NOT NULL DEFAULT 1,
    first_at   INTEGER NOT NULL,
    last_at    INTEGER NOT NULL,
    bucket     INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX security_events_bucket ON security_events(kind, ip, username, bucket);
  CREATE INDEX security_events_time ON security_events(last_at DESC);
  CREATE INDEX security_events_ip ON security_events(ip, last_at);
  CREATE INDEX security_events_user ON security_events(username, kind, last_at);

  CREATE TABLE ip_blocks (
    ip         TEXT PRIMARY KEY,
    reason     TEXT NOT NULL,
    auto       INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    -- NULL: until an administrator removes it.
    expires_at INTEGER,
    created_by TEXT REFERENCES users(id) ON DELETE SET NULL
  );
  `,
  // A buyer's agreement to the terms of sale (and that points are delivered at once, so the
  // seven-day withdrawal does not apply), with the version of the terms they agreed to.
  `
  ALTER TABLE payment_orders ADD COLUMN terms_accepted_at INTEGER;
  ALTER TABLE payment_orders ADD COLUMN terms_version INTEGER;
  `,
  // Announcements from the administrators: shown as a banner to whom they are for, between
  // their start and end, until each person dismisses one; and who has seen which.
  `
  CREATE TABLE announcements (
    id          TEXT PRIMARY KEY,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL DEFAULT '',
    level       TEXT NOT NULL CHECK (level IN ('info', 'warning', 'critical')),
    audience    TEXT NOT NULL CHECK (audience IN ('everyone', 'users', 'prepaid', 'exempt', 'admins')),
    starts_at   INTEGER,
    ends_at     INTEGER,
    dismissible INTEGER NOT NULL DEFAULT 1,
    created_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE TABLE announcement_seen (
    announcement_id TEXT NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    seen_at         INTEGER NOT NULL,
    PRIMARY KEY (announcement_id, user_id)
  );
  `,
  // 16: a prepaid transcription's limit (seconds) as the worker was told when it claimed the job,
  // so that what it reports afterwards is never charged beyond it.
  `ALTER TABLE jobs ADD COLUMN max_sec REAL;`,
  // 17: the person tries the new interface (a preview, off until they turn it on in Settings).
  `ALTER TABLE users ADD COLUMN new_ui INTEGER NOT NULL DEFAULT 0;`,
  // 18: recordings deleted after a while (the transcript and summaries stay): when a meeting's
  // were, and how long a person wants theirs kept (NULL: as long as the site keeps them; 7 or 30 days).
  `
  ALTER TABLE meetings ADD COLUMN media_deleted_at INTEGER;
  ALTER TABLE users ADD COLUMN media_retention_days INTEGER;
  `,
  // 19: correcting a transcript with a hosted model from the meeting's topic: each run, and each
  // sentence's text before it was corrected (NULL: not corrected), so a correction can be undone.
  `
  CREATE TABLE refinements (
    id           TEXT PRIMARY KEY,
    meeting_id   TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
    created_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
    status       TEXT NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed', 'canceled')),
    error        TEXT,
    model        TEXT,
    usage        TEXT,
    topic        TEXT,
    changed      INTEGER,
    hold         INTEGER,
    charged      INTEGER,
    then_summary TEXT,
    created_at   INTEGER NOT NULL,
    started_at   INTEGER,
    finished_at  INTEGER
  );
  CREATE INDEX refinements_meeting ON refinements(meeting_id, created_at DESC);
  CREATE INDEX refinements_status ON refinements(status, created_at);
  ALTER TABLE segments ADD COLUMN original_text TEXT;
  `,
];
