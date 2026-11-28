/**
 * Crash-safe storage for in-browser recordings. MediaRecorder hands us a chunk
 * every few seconds; each one is written to IndexedDB immediately, so a closed
 * tab, a browser crash or a flat battery loses at most one chunk. A recording
 * stays here until it is uploaded or explicitly discarded.
 */

import type { CapturedSlide, Region } from "./slides";

const DB_NAME = "mm-recordings";
/** 2: slides picked from the shared tab, kept with their recording. */
const DB_VERSION = 2;

export interface RecordingMeta {
  id: string;
  startedAt: number;
  mimeType: string;
  source: "mic" | "meeting";
  bytes: number;
  /** Recorded time, excluding pauses. */
  durationMs: number;
  /** True once the user pressed stop (false means it was interrupted). */
  finished: boolean;
  /** Account that made the recording; on a shared computer, others must not see it. */
  ownerId?: string;
  /** Slides were being picked from the shared tab. */
  slides?: boolean;
  /** Where the slide is on the shared screen, as far as was known: restored slides are cut to it. */
  slideRegion?: Region;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = req.result;
      if (e.oldVersion < 1) {
        db.createObjectStore("meta", { keyPath: "id" });
        const chunks = db.createObjectStore("chunks", { autoIncrement: true });
        chunks.createIndex("rec", "rec");
      }
      if (e.oldVersion < 2) {
        const slides = db.createObjectStore("slides", { keyPath: "key" });
        slides.createIndex("rec", "rec");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function saveMeta(meta: RecordingMeta): Promise<void> {
  const db = await open();
  const tx = db.transaction("meta", "readwrite");
  tx.objectStore("meta").put(meta);
  await done(tx);
}

export async function appendChunk(meta: RecordingMeta, chunk: Blob): Promise<void> {
  const db = await open();
  const tx = db.transaction(["meta", "chunks"], "readwrite");
  tx.objectStore("chunks").add({ rec: meta.id, blob: chunk });
  tx.objectStore("meta").put(meta);
  await done(tx);
}

/**
 * Recordings kept in this browser by the given account. Recordings from before
 * accounts were recorded (no ownerId) stay visible, so nobody loses one.
 */
export async function listRecordings(ownerId: string): Promise<RecordingMeta[]> {
  const db = await open();
  const tx = db.transaction("meta", "readonly");
  const req = tx.objectStore("meta").getAll();
  await done(tx);
  return (req.result as RecordingMeta[])
    .filter((m) => !m.ownerId || m.ownerId === ownerId)
    .sort((a, b) => b.startedAt - a.startedAt);
}

export async function loadRecording(id: string): Promise<Blob | null> {
  const db = await open();
  const tx = db.transaction(["meta", "chunks"], "readonly");
  const metaReq = tx.objectStore("meta").get(id);
  const chunksReq = tx.objectStore("chunks").index("rec").getAll(IDBKeyRange.only(id));
  await done(tx);
  const meta = metaReq.result as RecordingMeta | undefined;
  const parts = (chunksReq.result as { blob: Blob }[]).map((c) => c.blob);
  if (!meta || parts.length === 0) return null;
  return new Blob(parts, { type: meta.mimeType.split(";")[0] });
}

export async function deleteRecording(id: string): Promise<void> {
  const db = await open();
  const tx = db.transaction(["meta", "chunks", "slides"], "readwrite");
  tx.objectStore("meta").delete(id);
  for (const store of ["chunks", "slides"]) {
    const req = tx.objectStore(store).index("rec").openKeyCursor(IDBKeyRange.only(id));
    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        tx.objectStore(store).delete(cursor.primaryKey);
        cursor.continue();
      }
    };
  }
  await done(tx);
}

/** Keep a slide with its recording; `replaces`: an earlier picture of the same slide, removed. */
export async function saveSlide(recordingId: string, slide: CapturedSlide, replaces?: string): Promise<void> {
  const db = await open();
  const tx = db.transaction("slides", "readwrite");
  if (replaces) tx.objectStore("slides").delete(replaces);
  tx.objectStore("slides").put({ ...slide, rec: recordingId });
  await done(tx);
}

/** Forget one stored slide picture (the person removed it). */
export async function deleteStoredSlide(key: string): Promise<void> {
  const db = await open();
  const tx = db.transaction("slides", "readwrite");
  tx.objectStore("slides").delete(key);
  await done(tx);
}

/** The slides kept with a recording, in the order they appeared. */
export async function loadSlides(recordingId: string): Promise<CapturedSlide[]> {
  const db = await open();
  const tx = db.transaction("slides", "readonly");
  const req = tx.objectStore("slides").index("rec").getAll(IDBKeyRange.only(recordingId));
  await done(tx);
  return (req.result as (CapturedSlide & { rec: string })[])
    .map(({ rec: _rec, ...s }) => s)
    .sort((a, b) => a.at - b.at);
}

/** Recordings kept in this browser at this address, whoever made them (0 when storage cannot be read). */
export async function countRecordings(): Promise<number> {
  try {
    const db = await open();
    const tx = db.transaction("meta", "readonly");
    const req = tx.objectStore("meta").count();
    await done(tx);
    return req.result;
  } catch {
    return 0;
  }
}
