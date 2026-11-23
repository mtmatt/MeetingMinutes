import type { QueryClient } from "@tanstack/react-query";
import { quietGet } from "../api/client";

/** How long fetched page data counts as fresh; live updates refresh it whenever it changes. */
export const PAGE_DATA_FRESH_MS = 10_000;

/**
 * The data of the page the address opens on, fetched as soon as the app starts,
 * alongside the sign-in check instead of after it: one round trip less before
 * the library or a meeting appears. The page's own query uses the same key, so
 * it picks up this fetch rather than sending another.
 */
export function prefetchPageData(qc: QueryClient, pathname: string) {
  const meeting = /^\/m\/([^/]+)\/?$/.exec(pathname);
  if (pathname === "/") {
    void qc.prefetchQuery({ queryKey: ["meetings", ""], queryFn: () => quietGet("/meetings"), staleTime: PAGE_DATA_FRESH_MS });
  } else if (meeting) {
    const id = decodeURIComponent(meeting[1]!);
    void qc.prefetchQuery({ queryKey: ["meeting", id], queryFn: () => quietGet(`/meetings/${encodeURIComponent(id)}`), staleTime: PAGE_DATA_FRESH_MS });
  }
}
