/**
 * Crash-safe storage for in-browser recordings. MediaRecorder hands us a chunk
 * every few seconds; each one is written to IndexedDB immediately, so a closed
 * tab, a browser crash or a flat battery loses at most one chunk. A recording
 * stays here until it is uploaded or explicitly discarded.
 */

const DB_NAME = "mm-recordings";
const DB_VERSION = 1;

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
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore("meta", { keyPath: "id" });
      const chunks = db.createObjectStore("chunks", { autoIncrement: true });
      chunks.createIndex("rec", "rec");
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
  const tx = db.transaction(["meta", "chunks"], "readwrite");
  tx.objectStore("meta").delete(id);
  const idx = tx.objectStore("chunks").index("rec");
  const req = idx.openKeyCursor(IDBKeyRange.only(id));
  req.onsuccess = () => {
    const cursor = req.result;
    if (cursor) {
      tx.objectStore("chunks").delete(cursor.primaryKey);
      cursor.continue();
    }
  };
  await done(tx);
}
