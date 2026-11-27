import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { api } from "../api/client";
import type { AnnouncementList } from "../api/types";

/**
 * Announcements for the signed-in person. Pushed changes arrive over the live
 * updates stream; the interval catches scheduled ones whose start has come.
 */
export function useAnnouncements(enabled = true) {
  return useQuery({ queryKey: ["announcements"], queryFn: api.announcements, enabled, refetchInterval: 5 * 60_000, staleTime: 60_000 });
}

/** Close banners, or mark announcements read: the list comes back updated. */
export function useMarkSeen() {
  const qc = useQueryClient();
  return useCallback(
    async (ids: string[]) => {
      if (!ids.length) return;
      // At once, so the banner goes away without waiting for the server.
      qc.setQueryData<AnnouncementList>(["announcements"], (old) =>
        old
          ? {
              ...old,
              active: old.active.map((a) => (ids.includes(a.id) ? { ...a, seen: true } : a)),
              unseen: old.active.filter((a) => !a.seen && !ids.includes(a.id)).length,
            }
          : old,
      );
      try {
        qc.setQueryData(["announcements"], await api.markAnnouncementsSeen(ids));
      } catch {
        void qc.invalidateQueries({ queryKey: ["announcements"] });
      }
    },
    [qc],
  );
}
