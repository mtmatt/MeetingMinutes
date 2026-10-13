/**
 * Speaker recognition by voice.
 *
 * Every transcription brings a voice fingerprint per speaker (a speaker
 * embedding from the diarization model; older meetings get theirs from a
 * "voiceprint" job). When the user names a speaker, that fingerprint becomes a
 * sample of the voice profile with that name. Speakers of later meetings who
 * still have a default name ("Speaker 2") are compared with the user's
 * profiles: a close match is named after the profile (and marked as
 * recognised, so the user can confirm or reject it), a weaker one is only
 * suggested. Only confirmed speakers ever become samples, so a wrong guess
 * never teaches the profile the wrong voice.
 */
import { config } from "../config";
import { db, now } from "../db";
import { newId } from "../lib/util";
import type { JobRow, MeetingRow, SpeakerRow, VoiceProfileRow, VoiceSampleRow, VoiceStatus } from "../types";
import { publish } from "./events";
import { renameSpeaker } from "./speakerNames";

/** A fingerprint as the worker reports it. */
export interface Voice {
  embedding: number[];
  speechSec: number;
}

/**
 * How far the best profile must be ahead of the next one for a speaker to be
 * named automatically. Two similar voices both above the threshold are only
 * suggested, and the user picks.
 */
const MARGIN = 0.05;
/** Recent samples per profile used for matching, which bounds the work for people met often. */
const SAMPLES_PER_PROFILE = 20;

// ---------------------------------------------------------- fingerprints

/** Unit-length Float32 bytes, or null for a vector that cannot be normalised. */
export function encodeVoice(values: ArrayLike<number>): Uint8Array | null {
  const v = Float32Array.from(values);
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (!v.length || !Number.isFinite(norm) || norm < 1e-8) return null;
  for (let i = 0; i < v.length; i++) v[i]! /= norm;
  return new Uint8Array(v.buffer);
}

export function decodeVoice(bytes: Uint8Array): Float32Array {
  // A copy: SQLite's buffer need not be aligned for Float32Array.
  const copy = bytes.slice();
  return new Float32Array(copy.buffer, 0, copy.byteLength >> 2);
}

/** Cosine similarity of unit vectors; null when they come from models of different sizes. */
export function similarity(a: Float32Array, b: Float32Array): number | null {
  if (a.length !== b.length) return null;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

function mean(vectors: Float32Array[]): Float32Array {
  const out = new Float32Array(vectors[0]!.length);
  for (const v of vectors) for (let i = 0; i < out.length; i++) out[i]! += v[i]!;
  return decodeVoice(encodeVoice(out) ?? new Uint8Array(out.buffer));
}

/** Names the backend gives speakers ("Speaker 3"), and how people write them in Chinese. */
export function isDefaultName(name: string): boolean {
  return /^\s*(speaker|發言者|講者|發言人|說話者|说话人|发言人)\s*\d+\s*$/i.test(name);
}

// --------------------------------------------------------------- profiles

export function recognitionEnabled(userId: string): boolean {
  return !!db.query<{ v: number }, { u: string }>("SELECT voice_recognition AS v FROM users WHERE id = $u").get({ u: userId })?.v;
}

function profileByName(ownerId: string, name: string): VoiceProfileRow | null {
  return db
    .query<VoiceProfileRow, { o: string; n: string }>("SELECT * FROM voice_profiles WHERE owner_id = $o AND name = $n")
    .get({ o: ownerId, n: name.trim() });
}

export function getProfile(ownerId: string, id: string): VoiceProfileRow | null {
  return db.query<VoiceProfileRow, { o: string; id: string }>("SELECT * FROM voice_profiles WHERE owner_id = $o AND id = $id").get({ o: ownerId, id });
}

function findOrCreateProfile(ownerId: string, name: string): VoiceProfileRow {
  const existing = profileByName(ownerId, name);
  if (existing) return existing;
  const t = now();
  const row: VoiceProfileRow = { id: newId(12), owner_id: ownerId, name: name.trim(), created_at: t, updated_at: t };
  db.query("INSERT INTO voice_profiles (id, owner_id, name, created_at, updated_at) VALUES ($id, $o, $n, $t, $t)").run({
    id: row.id,
    o: ownerId,
    n: row.name,
    t,
  });
  return row;
}

/**
 * Delete a profile that has nothing left: no samples, and no speaker who was
 * named after it (a confirmed speaker may still be waiting for its fingerprint).
 */
function pruneProfile(profileId: string | null) {
  if (!profileId) return;
  const used = db
    .query<{ n: number }, { p: string }>(
      `SELECT (SELECT COUNT(*) FROM voice_samples WHERE profile_id = $p)
            + (SELECT COUNT(*) FROM speakers WHERE profile_id = $p AND voice_status IN ('confirmed', 'auto')) AS n`,
    )
    .get({ p: profileId })!.n;
  if (used) return;
  db.query("UPDATE speakers SET voice_status = NULL, voice_score = NULL, profile_id = NULL WHERE profile_id = $p").run({ p: profileId });
  db.query("DELETE FROM voice_profiles WHERE id = $p").run({ p: profileId });
}

interface ProfileVoices {
  profile: VoiceProfileRow;
  centroid: Float32Array;
  samples: Float32Array[];
}

/** Profiles by fingerprint model, reused while nothing is learned (e.g. across one scan). */
export type ProfileCache = Map<string, ProfileVoices[]>;

/** The user's profiles with samples from `model`, for matching: the most recent samples of each. */
function profileVoices(ownerId: string, model: string): ProfileVoices[] {
  const rows = db
    .query<
      { profile_id: string; embedding: Uint8Array; name: string; p_created: number; p_updated: number },
      { o: string; model: string; n: number }
    >(
      `SELECT * FROM (
         SELECT s.profile_id, s.embedding, p.name, p.created_at AS p_created, p.updated_at AS p_updated,
           ROW_NUMBER() OVER (PARTITION BY s.profile_id ORDER BY s.created_at DESC, s.id DESC) AS rn
         FROM voice_samples s JOIN voice_profiles p ON p.id = s.profile_id
         WHERE p.owner_id = $o AND s.model = $model
       ) WHERE rn <= $n`,
    )
    .all({ o: ownerId, model, n: SAMPLES_PER_PROFILE });
  const by = new Map<string, ProfileVoices>();
  for (const r of rows) {
    let pv = by.get(r.profile_id);
    if (!pv) {
      pv = {
        profile: { id: r.profile_id, owner_id: ownerId, name: r.name, created_at: r.p_created, updated_at: r.p_updated },
        centroid: new Float32Array(0),
        samples: [],
      };
      by.set(r.profile_id, pv);
    }
    pv.samples.push(decodeVoice(r.embedding));
  }
  for (const pv of by.values()) pv.centroid = mean(pv.samples);
  return [...by.values()];
}

/** How much a voice sounds like a profile: its closest recording, or the profile's average voice. */
function score(voice: Float32Array, pv: ProfileVoices): number | null {
  let best = similarity(voice, pv.centroid);
  if (best == null) return null;
  for (const s of pv.samples) best = Math.max(best, similarity(voice, s) ?? best);
  return best;
}

// ------------------------------------------------------- meeting speakers

function speakersOf(meetingId: string): SpeakerRow[] {
  return db.query<SpeakerRow, { m: string }>("SELECT * FROM speakers WHERE meeting_id = $m ORDER BY key").all({ m: meetingId });
}

function getSpeaker(meetingId: string, key: string): SpeakerRow | null {
  return db.query<SpeakerRow, { m: string; k: string }>("SELECT * FROM speakers WHERE meeting_id = $m AND key = $k").get({ m: meetingId, k: key });
}

function setVoiceLink(meetingId: string, key: string, link: { profileId: string | null; status: VoiceStatus | null; score?: number | null; nameBefore?: string | null }) {
  db.query(
    "UPDATE speakers SET profile_id = $p, voice_status = $s, voice_score = $score, name_before = $before WHERE meeting_id = $m AND key = $k",
  ).run({ m: meetingId, k: key, p: link.profileId, s: link.status, score: link.score ?? null, before: link.nameBefore ?? null });
}

const hasUsableVoice = (s: SpeakerRow) => !!s.voice && !!s.voice_model && (s.speech_sec ?? 0) >= config.voice.minSpeechSec;

/**
 * Keep a confirmed speaker's fingerprint as a sample of its profile. Returns
 * whether the profile has a sample of this speaker. A fingerprint that is too
 * short, or arrives while recognition is off (`learn`), does not replace an
 * earlier sample of the speaker: that one stays, with the speaker's profile.
 */
function syncSample(meetingId: string, s: SpeakerRow, learn: boolean): boolean {
  if (s.voice_status !== "confirmed" || !s.profile_id) {
    db.query("DELETE FROM voice_samples WHERE meeting_id = $m AND speaker_key = $k").run({ m: meetingId, k: s.key });
    return false;
  }
  if (!learn || !hasUsableVoice(s)) {
    const kept = db
      .query("UPDATE voice_samples SET profile_id = $p WHERE meeting_id = $m AND speaker_key = $k")
      .run({ p: s.profile_id, m: meetingId, k: s.key });
    return kept.changes > 0;
  }
  db.query(
    `INSERT INTO voice_samples (profile_id, meeting_id, speaker_key, model, embedding, speech_sec, created_at)
     VALUES ($p, $m, $k, $model, $e, $sec, $t)
     ON CONFLICT (meeting_id, speaker_key) DO UPDATE SET profile_id = excluded.profile_id, model = excluded.model,
       embedding = excluded.embedding, speech_sec = excluded.speech_sec`,
  ).run({ p: s.profile_id, m: meetingId, k: s.key, model: s.voice_model!, e: s.voice!, sec: s.speech_sec!, t: now() });
  db.query("UPDATE voice_profiles SET updated_at = $t WHERE id = $p").run({ p: s.profile_id, t: now() });
  return true;
}

/**
 * What became of a speaker's voice after naming it:
 * remembered (a sample of the profile), short (too little speech to be
 * useful), pending (its fingerprint is being made), or off (nothing kept).
 */
export type Remembered = "remembered" | "short" | "pending" | "off";

/** The speaker is the person `profileId`: link them and keep their voice. Only while recognition is on. */
function confirm(m: MeetingRow, key: string, profileId: string): Remembered {
  const before = getSpeaker(m.id, key);
  if (!before) return "off";
  setVoiceLink(m.id, key, { profileId, status: "confirmed" });
  const s = getSpeaker(m.id, key)!;
  const kept = syncSample(m.id, s, true);
  if (before.profile_id && before.profile_id !== profileId) pruneProfile(before.profile_id);
  if (kept) return "remembered";
  if (s.voice) return "short";
  // No fingerprint yet (a meeting from before fingerprints, or a speaker added by hand).
  const talk = speechByKey(m.id).get(key) ?? 0;
  if (talk >= config.voice.minSpeechSec) {
    enqueueVoiceprint(m, false);
    return "pending";
  }
  if (talk > 0) {
    db.query("UPDATE speakers SET speech_sec = $sec WHERE meeting_id = $m AND key = $k").run({ m: m.id, k: key, sec: talk });
    return "short";
  }
  // Nothing said yet: the fingerprint is made once paragraphs are assigned to them.
  return "pending";
}

/** Stop linking the speaker to anyone, leaving them in `status` (see VoiceStatus). */
function unlink(m: MeetingRow, key: string, status: "rejected" | "ignored" | null) {
  const before = getSpeaker(m.id, key);
  if (!before) return;
  setVoiceLink(m.id, key, { profileId: null, status });
  db.query("DELETE FROM voice_samples WHERE meeting_id = $m AND speaker_key = $k").run({ m: m.id, k: key });
  pruneProfile(before.profile_id);
}

export interface SpeakerVoiceOutcome {
  remembered: Remembered;
  profile: { id: string; name: string } | null;
}

/**
 * The user gave a speaker a name: remember the voice under that name, unless
 * it is a default label ("Speaker 2"), the user asked not to (`remember`), or
 * asked earlier not to remember this speaker. Call after renaming the speaker.
 */
export function speakerNamed(m: MeetingRow, key: string, name: string, remember = true): SpeakerVoiceOutcome {
  let result: SpeakerVoiceOutcome = { remembered: "off", profile: null };
  const changed: string[] = [];
  db.transaction(() => {
    const s = getSpeaker(m.id, key);
    if (!s || s.voice_status === "ignored") return;
    if (!remember) {
      unlink(m, key, "ignored");
      return;
    }
    if (isDefaultName(name)) {
      // Taking a person's name away says the speaker is not them: recognition must not name them so again.
      if (s.voice_status && s.voice_status !== "rejected") unlink(m, key, "rejected");
      return;
    }
    if (!recognitionEnabled(m.owner_id)) {
      // A renamed speaker is no longer whoever they were linked to.
      if (s.voice_status && s.voice_status !== "rejected") unlink(m, key, null);
      return;
    }
    const profile = findOrCreateProfile(m.owner_id, name);
    result = { remembered: confirm(m, key, profile.id), profile: { id: profile.id, name: profile.name } };
    // Nobody else in this meeting is this person now; refresh the other guesses.
    changed.push(...identifySpeakers(m));
  })();
  announceSummaryChanges(m, changed);
  return result;
}

export type VoiceAction = "confirm" | "reject" | "forget" | "remember";

/**
 * confirm: a recognised or suggested speaker is that person (a suggestion is
 *   renamed to the profile's name); their voice becomes a sample.
 * reject: they are not; a recognised speaker gets their previous name back,
 *   and is not guessed again.
 * forget: keep the name but not the voice (a sample is removed), and never
 *   remember or recognise this speaker.
 * remember: undo "forget": remember the voice under the speaker's name.
 */
export function speakerVoiceAction(m: MeetingRow, key: string, action: VoiceAction): SpeakerVoiceOutcome | null {
  const s = getSpeaker(m.id, key);
  if (!s) return null;
  let result: SpeakerVoiceOutcome = { remembered: "off", profile: null };
  const changed: string[] = [];
  db.transaction(() => {
    if (action === "confirm") {
      if (!recognitionEnabled(m.owner_id)) return;
      const profile = s.profile_id ? db.query<VoiceProfileRow, { p: string }>("SELECT * FROM voice_profiles WHERE id = $p").get({ p: s.profile_id }) : null;
      if (!profile || (s.voice_status !== "auto" && s.voice_status !== "suggested")) return;
      if (s.name !== profile.name) changed.push(...renameSpeaker(m.id, key, profile.name).changed);
      result = { remembered: confirm(m, key, profile.id), profile: { id: profile.id, name: profile.name } };
      changed.push(...identifySpeakers(m));
    } else if (action === "reject") {
      if (s.voice_status !== "auto" && s.voice_status !== "suggested") return;
      if (s.voice_status === "auto" && s.name_before) changed.push(...renameSpeaker(m.id, key, s.name_before).changed);
      unlink(m, key, "rejected");
    } else if (action === "forget") {
      unlink(m, key, "ignored");
    } else {
      if (isDefaultName(s.name) || !recognitionEnabled(m.owner_id)) return;
      const profile = findOrCreateProfile(m.owner_id, s.name);
      result = { remembered: confirm(m, key, profile.id), profile: { id: profile.id, name: profile.name } };
      changed.push(...identifySpeakers(m));
    }
  })();
  announceSummaryChanges(m, changed);
  return result;
}

/** Tell the owner's browsers which summaries changed (after the transaction that changed them). */
export function announceSummaryChanges(m: MeetingRow, summaryIds: string[]) {
  for (const id of new Set(summaryIds)) publish(m.owner_id, { type: "summary.updated", meetingId: m.id, summaryId: id });
}

// ------------------------------------------------------------ recognition

/**
 * Name (or suggest a name for) the meeting's speakers who still have a default
 * name, by comparing their voices with the owner's profiles. Each profile goes
 * to at most one speaker, the closest, and never to one whose name is already
 * taken in this meeting. Returns the ids of summaries whose names changed.
 */
export function identifySpeakers(m: MeetingRow, cache: ProfileCache = new Map()): string[] {
  if (!recognitionEnabled(m.owner_id)) return [];
  const speakers = speakersOf(m.id);
  const open = (s: SpeakerRow) => (s.voice_status == null || s.voice_status === "suggested") && isDefaultName(s.name);
  const candidates = speakers.filter((s) => open(s) && hasUsableVoice(s));
  // A suggestion that no longer applies (its speaker became too short, etc.) goes away below.
  const stale = speakers.filter((s) => open(s) && s.voice_status === "suggested" && !hasUsableVoice(s));
  if (!candidates.length && !stale.length) return [];

  const takenNames = new Set(speakers.filter((s) => !open(s)).map((s) => s.name.trim().toLowerCase()));
  const takenProfiles = new Set(speakers.filter((s) => !open(s) && s.profile_id).map((s) => s.profile_id!));
  const profiles = cache;
  const pairs: { s: SpeakerRow; pv: ProfileVoices; score: number; runnerUp: number }[] = [];
  for (const s of candidates) {
    const model = s.voice_model!;
    if (!profiles.has(model)) profiles.set(model, profileVoices(m.owner_id, model));
    const voice = decodeVoice(s.voice!);
    const scored = profiles
      .get(model)!
      .map((pv) => ({ pv, score: score(voice, pv) }))
      .filter((x): x is { pv: ProfileVoices; score: number } => x.score != null)
      .sort((a, b) => b.score - a.score);
    for (const [i, x] of scored.entries()) {
      if (takenProfiles.has(x.pv.profile.id) || takenNames.has(x.pv.profile.name.trim().toLowerCase())) continue;
      if (x.score < config.voice.suggest) break;
      // The closest other profile, taken or not: a near tie is never a sure match.
      const runnerUp = scored.find((y, j) => j !== i)?.score ?? -1;
      pairs.push({ s, pv: x.pv, score: x.score, runnerUp });
    }
  }

  // Closest pairs first; each speaker and each profile is used once.
  pairs.sort((a, b) => b.score - a.score);
  const assigned = new Map<string, (typeof pairs)[number]>();
  const usedProfiles = new Set<string>();
  for (const p of pairs) {
    if (assigned.has(p.s.key) || usedProfiles.has(p.pv.profile.id)) continue;
    assigned.set(p.s.key, p);
    usedProfiles.add(p.pv.profile.id);
  }

  const changed: string[] = [];
  for (const s of [...candidates, ...stale]) {
    const p = assigned.get(s.key);
    if (!p) {
      if (s.voice_status === "suggested") setVoiceLink(m.id, s.key, { profileId: null, status: null });
      continue;
    }
    const score = Math.round(p.score * 1000) / 1000;
    if (p.score >= config.voice.match && p.score - p.runnerUp >= MARGIN) {
      changed.push(...renameSpeaker(m.id, s.key, p.pv.profile.name).changed);
      setVoiceLink(m.id, s.key, { profileId: p.pv.profile.id, status: "auto", score, nameBefore: s.name });
    } else {
      setVoiceLink(m.id, s.key, { profileId: p.pv.profile.id, status: "suggested", score });
    }
  }
  return changed;
}

/**
 * Remember the speakers the user named before voice profiles existed (or
 * while recognition was off): each name becomes a profile, unless it is a
 * default label or the user said not to remember that speaker.
 */
function learnNamedSpeakers(m: MeetingRow): number {
  if (!recognitionEnabled(m.owner_id)) return 0;
  let n = 0;
  for (const s of speakersOf(m.id)) {
    if (s.voice_status != null || isDefaultName(s.name) || !hasUsableVoice(s)) continue;
    const profile = findOrCreateProfile(m.owner_id, s.name);
    if (confirm(m, s.key, profile.id) === "remembered") n++;
  }
  return n;
}

// ------------------------------------------------- results from the worker

/**
 * Keep the fingerprints of a new transcription's speakers, and carry each
 * speaker's link to a profile over from the previous transcription when the
 * speaker kept its key and still sounds the same. Runs inside completeJob's
 * transaction, after the speakers were re-created; `previous` are the rows
 * from before.
 */
export function storeTranscriptVoices(
  m: MeetingRow,
  previous: SpeakerRow[],
  model: string | undefined,
  voices: Record<string, Voice> | undefined,
) {
  const meetingId = m.id;
  const learn = recognitionEnabled(m.owner_id);
  const before = new Map(previous.map((s) => [s.key, s]));
  const keep = new Set<string>();
  for (const s of speakersOf(meetingId)) {
    const v = model ? voices?.[s.key] : undefined;
    const bytes = v ? encodeVoice(v.embedding) : null;
    if (bytes) {
      db.query("UPDATE speakers SET voice = $v, voice_model = $model, speech_sec = $sec WHERE meeting_id = $m AND key = $k").run({
        m: meetingId,
        k: s.key,
        v: bytes,
        model: model!,
        sec: v!.speechSec,
      });
    }
    const old = before.get(s.key);
    if (!bytes && old?.voice && old.name === s.name) {
      // No new fingerprint (an older worker, or making one failed): the speaker keeps theirs.
      db.query("UPDATE speakers SET voice = $v, voice_model = $model, speech_sec = $sec WHERE meeting_id = $m AND key = $k").run({
        m: meetingId,
        k: s.key,
        v: old.voice,
        model: old.voice_model,
        sec: old.speech_sec,
      });
    }
    if (!old?.voice_status || old.voice_status === "suggested" || old.name !== s.name) continue;
    // Separating speakers again may give a key to someone else.
    const sameModel = old.voice_model === model;
    const sim = old.voice && bytes && sameModel ? similarity(decodeVoice(old.voice), decodeVoice(bytes)) : null;
    if (sim != null && sim < config.voice.suggest) continue;
    setVoiceLink(meetingId, s.key, { profileId: old.profile_id, status: old.voice_status, score: old.voice_score, nameBefore: old.name_before });
    if (old.voice_status === "confirmed") {
      if (syncSample(meetingId, getSpeaker(meetingId, s.key)!, learn)) keep.add(s.key);
    }
  }
  // Samples of speakers that are gone stay with their profiles, detached from this meeting's speakers.
  const samples = db
    .query<{ id: number; speaker_key: string | null }, { m: string }>("SELECT id, speaker_key FROM voice_samples WHERE meeting_id = $m")
    .all({ m: meetingId });
  for (const smp of samples) {
    if (smp.speaker_key && !keep.has(smp.speaker_key)) db.query("UPDATE voice_samples SET speaker_key = NULL WHERE id = $id").run({ id: smp.id });
  }
}

/**
 * Fingerprints for an older meeting arrived: store them, then learn and
 * recognise. Call inside a transaction; returns the summaries that changed.
 */
export function completeVoiceprint(job: JobRow, model: string, voices: Record<string, Voice>): { m: MeetingRow; changed: string[] } | null {
  const m = db.query<MeetingRow, { id: string }>("SELECT * FROM meetings WHERE id = $id").get({ id: job.meeting_id });
  if (!m) return null;
  const changed: string[] = [];
  const learn = recognitionEnabled(m.owner_id);
  const talk = speechByKey(m.id);
  for (const s of speakersOf(m.id)) {
    const v = voices[s.key];
    const bytes = v ? encodeVoice(v.embedding) : null;
    if (bytes) {
      db.query("UPDATE speakers SET voice = $v, voice_model = $model, speech_sec = $sec WHERE meeting_id = $m AND key = $k").run({
        m: m.id,
        k: s.key,
        v: bytes,
        model,
        sec: v!.speechSec,
      });
    } else if (s.speech_sec == null) {
      // Tried: too little clear speech. Not tried again by "find voices".
      db.query("UPDATE speakers SET speech_sec = $sec WHERE meeting_id = $m AND key = $k").run({ m: m.id, k: s.key, sec: talk.get(s.key) ?? 0 });
    }
  }
  for (const s of speakersOf(m.id)) if (s.voice_status === "confirmed") syncSample(m.id, s, learn);
  if (job.learn) learnNamedSpeakers(m);
  changed.push(...identifySpeakers(m));
  return { m, changed };
}

function speechByKey(meetingId: string): Map<string, number> {
  const rows = db
    .query<{ speaker: string; sec: number }, { m: string }>(
      "SELECT speaker, SUM(end_sec - start_sec) AS sec FROM segments WHERE meeting_id = $m AND speaker IS NOT NULL GROUP BY speaker",
    )
    .all({ m: meetingId });
  return new Map(rows.map((r) => [r.speaker, r.sec]));
}

/** What a voiceprint job needs: each speaker's spans in the transcript, as corrected by the user. */
export function voiceprintSpans(meetingId: string): Record<string, [number, number][]> {
  const rows = db
    .query<{ speaker: string; start_sec: number; end_sec: number }, { m: string }>(
      "SELECT speaker, start_sec, end_sec FROM segments WHERE meeting_id = $m AND speaker IS NOT NULL ORDER BY idx",
    )
    .all({ m: meetingId });
  const out: Record<string, [number, number][]> = {};
  for (const r of rows) (out[r.speaker] ??= []).push([r.start_sec, r.end_sec]);
  return out;
}

// ------------------------------------------------------------- job queue

/** Queue fingerprints for a transcribed meeting (at most one waiting job per meeting). */
export function enqueueVoiceprint(m: MeetingRow, learn: boolean): boolean {
  if (m.status !== "ready") return false;
  const queued = db
    .query<{ id: string }, { m: string }>("SELECT id FROM jobs WHERE meeting_id = $m AND kind = 'voiceprint' AND status = 'queued'")
    .get({ m: m.id });
  if (queued) {
    if (learn) db.query("UPDATE jobs SET learn = 1 WHERE id = $id").run({ id: queued.id });
    return true;
  }
  db.query("INSERT INTO jobs (id, meeting_id, kind, learn, status, created_at) VALUES ($id, $m, 'voiceprint', $l, 'queued', $t)").run({
    id: newId(12),
    m: m.id,
    l: learn ? 1 : 0,
    t: now(),
  });
  return true;
}

/** A speaker has enough speech in the transcript but no fingerprint yet, and was never tried. */
function needsFingerprint(m: MeetingRow): boolean {
  const talk = speechByKey(m.id);
  return speakersOf(m.id).some((s) => !s.voice && s.speech_sec == null && (talk.get(s.key) ?? 0) >= config.voice.minSpeechSec);
}

export interface ScanOutcome {
  /** Meetings queued for fingerprints; they are learned from when those arrive. */
  queued: number;
  /** Speakers remembered now, from their names. */
  remembered: number;
  /** Speakers named or suggested now, from their voices. */
  recognised: number;
}

/**
 * "Find voices in past recordings": remember everyone the user has already
 * named, and recognise the people still called "Speaker N", in every
 * transcribed meeting. Meetings without fingerprints get a voiceprint job.
 */
export function scanPastMeetings(ownerId: string): ScanOutcome {
  const out: ScanOutcome = { queued: 0, remembered: 0, recognised: 0 };
  const meetings = db
    .query<MeetingRow, { u: string }>("SELECT * FROM meetings WHERE owner_id = $u AND status = 'ready' ORDER BY COALESCE(occurred_at, created_at)")
    .all({ u: ownerId });
  // Remember named voices everywhere first, so recognition can use all of them.
  // Speakers without a fingerprint are learned and recognised when their job is done.
  db.transaction(() => {
    for (const m of meetings) {
      if (needsFingerprint(m) && enqueueVoiceprint(m, true)) out.queued++;
      out.remembered += learnNamedSpeakers(m);
    }
  })();
  const cache: ProfileCache = new Map();
  for (const m of meetings) {
    const before = speakersOf(m.id).filter((s) => s.voice_status === "auto" || s.voice_status === "suggested").length;
    const changed: string[] = [];
    db.transaction(() => changed.push(...identifySpeakers(m, cache)))();
    announceSummaryChanges(m, changed);
    const after = speakersOf(m.id).filter((s) => s.voice_status === "auto" || s.voice_status === "suggested").length;
    out.recognised += Math.max(0, after - before);
    if (after !== before) publish(m.owner_id, { type: "meeting.updated", meetingId: m.id });
  }
  return out;
}

// ---------------------------------------------------------------- reading

export interface SpeakerVoice {
  status: VoiceStatus | null;
  /** The speaker still has a default label ("Speaker 2"), which is never remembered as a voice. */
  defaultName: boolean;
  profile: { id: string; name: string } | null;
  /** Similarity to the profile when recognised or suggested, 0..1. */
  score: number | null;
  /** Whether this speaker has a voice fingerprint, and enough speech for one to count. */
  fingerprint: boolean;
  speechSec: number | null;
}

export function speakerVoices(meetingId: string): Map<string, SpeakerVoice> {
  const rows = db
    .query<SpeakerRow & { profile_name: string | null }, { m: string }>(
      `SELECT s.*, p.name AS profile_name FROM speakers s LEFT JOIN voice_profiles p ON p.id = s.profile_id WHERE s.meeting_id = $m`,
    )
    .all({ m: meetingId });
  return new Map(
    rows.map((s) => [
      s.key,
      {
        status: s.voice_status,
        defaultName: isDefaultName(s.name),
        profile: s.profile_id && s.profile_name != null ? { id: s.profile_id, name: s.profile_name } : null,
        score: s.voice_score,
        fingerprint: hasUsableVoice(s),
        speechSec: s.speech_sec,
      },
    ]),
  );
}

export function profileList(ownerId: string) {
  const profiles = db
    .query<VoiceProfileRow, { o: string }>("SELECT * FROM voice_profiles WHERE owner_id = $o ORDER BY name")
    .all({ o: ownerId });
  const samples = db
    .query<VoiceSampleRow & { title: string | null; speaker_name: string | null }, { o: string }>(
      `SELECT s.*, m.title, sp.name AS speaker_name FROM voice_samples s
       JOIN voice_profiles p ON p.id = s.profile_id
       LEFT JOIN meetings m ON m.id = s.meeting_id
       LEFT JOIN speakers sp ON sp.meeting_id = s.meeting_id AND sp.key = s.speaker_key
       WHERE p.owner_id = $o ORDER BY s.created_at DESC, s.id DESC`,
    )
    .all({ o: ownerId });
  const linked = db
    .query<{ profile_id: string; status: VoiceStatus; n: number }, { o: string }>(
      `SELECT sp.profile_id, sp.voice_status AS status, COUNT(*) AS n FROM speakers sp
       JOIN voice_profiles p ON p.id = sp.profile_id WHERE p.owner_id = $o GROUP BY sp.profile_id, sp.voice_status`,
    )
    .all({ o: ownerId });
  // Speakers recognition named after a profile, for the user to check.
  const awaiting = db
    .query<{ profile_id: string; meeting_id: string; key: string; title: string; score: number | null }, { o: string }>(
      `SELECT sp.profile_id, sp.meeting_id, sp.key, m.title, sp.voice_score AS score FROM speakers sp
       JOIN voice_profiles p ON p.id = sp.profile_id JOIN meetings m ON m.id = sp.meeting_id
       WHERE p.owner_id = $o AND sp.voice_status = 'auto' ORDER BY COALESCE(m.occurred_at, m.created_at) DESC`,
    )
    .all({ o: ownerId });
  return profiles.map((p) => {
    const own = samples.filter((s) => s.profile_id === p.id);
    const vectors = own.map((s) => ({ model: s.model, v: decodeVoice(s.embedding) }));
    // Samples that sound unlike each other suggest the name was used for more
    // than one person (e.g. "Guest"), which makes recognition unreliable.
    let lowest: number | null = null;
    for (let i = 0; i < vectors.length; i++) {
      for (let j = i + 1; j < vectors.length; j++) {
        if (vectors[i]!.model !== vectors[j]!.model) continue;
        const sim = similarity(vectors[i]!.v, vectors[j]!.v);
        if (sim != null) lowest = lowest == null ? sim : Math.min(lowest, sim);
      }
    }
    const count = (status: VoiceStatus) => linked.find((l) => l.profile_id === p.id && l.status === status)?.n ?? 0;
    return {
      id: p.id,
      name: p.name,
      createdAt: p.created_at,
      updatedAt: p.updated_at,
      speechSec: own.reduce((n, s) => n + s.speech_sec, 0),
      consistent: lowest == null || lowest >= config.voice.suggest,
      recognised: count("auto"),
      suggested: count("suggested"),
      awaiting: awaiting
        .filter((a) => a.profile_id === p.id)
        .map((a) => ({ meetingId: a.meeting_id, meetingTitle: a.title, speakerKey: a.key, score: a.score })),
      samples: own.map((s) => ({
        id: s.id,
        meetingId: s.meeting_id,
        meetingTitle: s.title,
        speakerKey: s.speaker_key,
        speakerName: s.speaker_name,
        speechSec: s.speech_sec,
        createdAt: s.created_at,
      })),
    };
  });
}

export function scanStatus(ownerId: string) {
  const rows = db
    .query<{ status: string; n: number }, { o: string }>(
      `SELECT j.status, COUNT(*) AS n FROM jobs j JOIN meetings m ON m.id = j.meeting_id
       WHERE m.owner_id = $o AND j.kind = 'voiceprint' AND j.status IN ('queued', 'running') GROUP BY j.status`,
    )
    .all({ o: ownerId });
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  // Meetings whose latest voiceprint failed for good (e.g. no diarization model on the worker).
  const failed = db
    .query<{ error: string | null }, { o: string }>(
      `SELECT j.error FROM jobs j JOIN meetings m ON m.id = j.meeting_id
       WHERE m.owner_id = $o AND j.kind = 'voiceprint' AND j.status = 'failed'
         AND j.created_at = (SELECT MAX(created_at) FROM jobs k WHERE k.meeting_id = j.meeting_id AND k.kind = 'voiceprint')
       ORDER BY j.finished_at DESC`,
    )
    .all({ o: ownerId });
  return { queued: by.queued ?? 0, running: by.running ?? 0, failed: failed.length, error: failed[0]?.error ?? null };
}

// ---------------------------------------------------------------- editing

/** Rename a profile, and every speaker named after it. */
export function renameProfile(ownerId: string, id: string, name: string): string[] {
  const changed: { m: MeetingRow; ids: string[] }[] = [];
  db.transaction(() => {
    db.query("UPDATE voice_profiles SET name = $n, updated_at = $t WHERE id = $id AND owner_id = $o").run({ id, o: ownerId, n: name.trim(), t: now() });
    changed.push(...renameLinkedSpeakers(id, name.trim()));
  })();
  for (const c of changed) {
    announceSummaryChanges(c.m, c.ids);
    publish(ownerId, { type: "meeting.updated", meetingId: c.m.id });
  }
  return changed.map((c) => c.m.id);
}

function renameLinkedSpeakers(profileId: string, name: string) {
  const rows = db
    .query<{ meeting_id: string; key: string }, { p: string }>(
      "SELECT meeting_id, key FROM speakers WHERE profile_id = $p AND voice_status IN ('confirmed', 'auto')",
    )
    .all({ p: profileId });
  const out: { m: MeetingRow; ids: string[] }[] = [];
  for (const r of rows) {
    const m = db.query<MeetingRow, { id: string }>("SELECT * FROM meetings WHERE id = $id").get({ id: r.meeting_id })!;
    out.push({ m, ids: renameSpeaker(r.meeting_id, r.key, name).changed });
  }
  return out;
}

/** Two profiles are the same person (named differently): move everything to `into`. */
export function mergeProfiles(ownerId: string, from: string, into: string) {
  const target = getProfile(ownerId, into)!;
  const changed: { m: MeetingRow; ids: string[] }[] = [];
  db.transaction(() => {
    db.query("UPDATE voice_samples SET profile_id = $into WHERE profile_id = $from").run({ from, into });
    // A meeting where both names appear keeps the suggestions apart; linked speakers move.
    db.query("UPDATE speakers SET profile_id = NULL, voice_status = NULL, voice_score = NULL WHERE profile_id = $from AND voice_status = 'suggested'").run({ from });
    db.query("UPDATE speakers SET profile_id = $into WHERE profile_id = $from").run({ from, into });
    db.query("DELETE FROM voice_profiles WHERE id = $from AND owner_id = $o").run({ from, o: ownerId });
    db.query("UPDATE voice_profiles SET updated_at = $t WHERE id = $into").run({ into, t: now() });
    changed.push(...renameLinkedSpeakers(into, target.name));
  })();
  for (const c of changed) {
    announceSummaryChanges(c.m, c.ids);
    publish(ownerId, { type: "meeting.updated", meetingId: c.m.id });
  }
}

/**
 * Forget a person: their profile and every sample of their voice. Speakers the
 * user named keep their names, but are not learned from again; speakers that
 * recognition named get their previous names back.
 */
export function deleteProfile(ownerId: string, id: string) {
  const linked = db
    .query<SpeakerRow, { p: string }>("SELECT * FROM speakers WHERE profile_id = $p")
    .all({ p: id });
  const changed: { m: MeetingRow; ids: string[] }[] = [];
  db.transaction(() => {
    for (const s of linked) {
      if (s.voice_status !== "auto" || !s.name_before) continue;
      const m = db.query<MeetingRow, { id: string }>("SELECT * FROM meetings WHERE id = $id").get({ id: s.meeting_id })!;
      changed.push({ m, ids: renameSpeaker(s.meeting_id, s.key, s.name_before).changed });
    }
    db.query("UPDATE speakers SET voice_status = 'ignored', voice_score = NULL, name_before = NULL WHERE profile_id = $p AND voice_status = 'confirmed'").run({ p: id });
    db.query("UPDATE speakers SET voice_status = NULL, voice_score = NULL, name_before = NULL WHERE profile_id = $p AND voice_status IN ('auto', 'suggested')").run({ p: id });
    db.query("DELETE FROM voice_profiles WHERE id = $id AND owner_id = $o").run({ id, o: ownerId });
  })();
  for (const c of changed) announceSummaryChanges(c.m, c.ids);
  for (const meetingId of new Set(linked.map((s) => s.meeting_id))) publish(ownerId, { type: "meeting.updated", meetingId });
}

/** Remove one recording of a person's voice; its speaker is not learned from again. */
export function deleteSample(ownerId: string, profileId: string, sampleId: number): boolean {
  const s = db
    .query<VoiceSampleRow, { id: number; o: string; p: string }>(
      "SELECT s.* FROM voice_samples s JOIN voice_profiles p ON p.id = s.profile_id WHERE s.id = $id AND p.owner_id = $o AND p.id = $p",
    )
    .get({ id: sampleId, o: ownerId, p: profileId });
  if (!s) return false;
  db.transaction(() => {
    db.query("DELETE FROM voice_samples WHERE id = $id").run({ id: s.id });
    if (s.meeting_id && s.speaker_key) {
      db.query("UPDATE speakers SET voice_status = 'ignored', profile_id = NULL, voice_score = NULL WHERE meeting_id = $m AND key = $k AND profile_id = $p").run({
        m: s.meeting_id,
        k: s.speaker_key,
        p: s.profile_id,
      });
    }
    pruneProfile(s.profile_id);
  })();
  if (s.meeting_id) publish(ownerId, { type: "meeting.updated", meetingId: s.meeting_id });
  return true;
}
