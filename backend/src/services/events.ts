/**
 * In-process pub/sub used to push live updates to browsers over SSE.
 * Events are addressed to a user id; every open tab of that user receives them.
 */
export type AppEvent =
  | { type: "meeting.updated"; meetingId: string }
  | { type: "meeting.deleted"; meetingId: string }
  | { type: "summary.updated"; meetingId: string; summaryId: string };

type Listener = (event: AppEvent) => void;

const listeners = new Map<string, Set<Listener>>();

export function subscribe(userId: string, listener: Listener): () => void {
  let set = listeners.get(userId);
  if (!set) {
    set = new Set();
    listeners.set(userId, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) listeners.delete(userId);
  };
}

export function publish(userId: string, event: AppEvent): void {
  const set = listeners.get(userId);
  if (!set) return;
  for (const l of set) {
    try {
      l(event);
    } catch {
      // A broken listener must not affect the others.
    }
  }
}

export function listenerCount(): number {
  let n = 0;
  for (const s of listeners.values()) n += s.size;
  return n;
}
