import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { requireUser } from "../auth/middleware";
import { subscribe, type AppEvent } from "../services/events";
import type { AppEnv } from "../types";

export const eventRoutes = new Hono<AppEnv>();
eventRoutes.use(requireUser);

/** Server-sent events stream of changes to the signed-in user's meetings. */
eventRoutes.get("/", (c) => {
  const userId = c.get("user").id;
  c.header("X-Accel-Buffering", "no");
  c.header("Cache-Control", "no-cache, no-transform");
  return streamSSE(c, async (stream) => {
    const queue: AppEvent[] = [];
    let wake: (() => void) | null = null;
    const unsubscribe = subscribe(userId, (e) => {
      queue.push(e);
      wake?.();
    });
    stream.onAbort(() => {
      unsubscribe();
      wake?.();
    });
    await stream.writeSSE({ event: "ready", data: "{}" });
    while (!stream.aborted && !stream.closed) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
          setTimeout(resolve, 20_000);
        });
        wake = null;
      }
      if (stream.aborted || stream.closed) break;
      if (queue.length === 0) {
        await stream.write(": ping\n\n");
        continue;
      }
      // Coalesce bursts (progress updates) into one message per meeting.
      const batch = queue.splice(0, queue.length);
      const seen = new Set<string>();
      const unique: AppEvent[] = [];
      for (let i = batch.length - 1; i >= 0; i--) {
        const key = JSON.stringify(batch[i]);
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(batch[i]!);
      }
      for (const e of unique.reverse()) await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
    }
    unsubscribe();
  });
});
