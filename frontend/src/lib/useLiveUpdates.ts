import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

/**
 * Subscribe to the backend's SSE stream and refresh affected queries.
 * EventSource reconnects automatically after network interruptions.
 */
export function useLiveUpdates(enabled: boolean) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const pending = new Map<string, ReturnType<typeof setTimeout>>();
    const invalidate = (key: unknown[]) => {
      const k = JSON.stringify(key);
      if (pending.has(k)) return;
      pending.set(
        k,
        setTimeout(() => {
          pending.delete(k);
          void qc.invalidateQueries({ queryKey: key });
        }, 250),
      );
    };
    const es = new EventSource("/api/events");
    const onMeeting = (e: MessageEvent) => {
      const data = JSON.parse(e.data) as { meetingId: string };
      invalidate(["meeting", data.meetingId]);
      invalidate(["meetings"]);
    };
    es.addEventListener("meeting.updated", onMeeting);
    es.addEventListener("summary.updated", onMeeting);
    es.addEventListener("meeting.deleted", (e) => {
      const data = JSON.parse((e as MessageEvent).data) as { meetingId: string };
      qc.removeQueries({ queryKey: ["meeting", data.meetingId] });
      invalidate(["meetings"]);
    });
    // After a reconnect we may have missed events; refresh everything visible.
    es.addEventListener("ready", () => {
      void qc.invalidateQueries({ queryKey: ["meetings"] });
      void qc.invalidateQueries({ queryKey: ["meeting"] });
    });
    return () => {
      es.close();
      for (const t of pending.values()) clearTimeout(t);
    };
  }, [enabled, qc]);
}
