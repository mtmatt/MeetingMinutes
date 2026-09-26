import { useSyncExternalStore } from "react";

/**
 * What the current page is about, shown compactly in the masthead once the
 * page's own header has scrolled away (e.g. the meeting being worked on).
 */
export interface PageContext {
  title: string;
  subtitle?: string;
  onClick?: () => void;
}

let current: PageContext | null = null;
const listeners = new Set<() => void>();

export function setPageContext(ctx: PageContext | null) {
  current = ctx;
  for (const l of listeners) l();
}

export function usePageContext(): PageContext | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => current,
  );
}
