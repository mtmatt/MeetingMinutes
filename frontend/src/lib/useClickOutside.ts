import { useEffect, type RefObject } from "react";

type Refs = RefObject<HTMLElement | null> | RefObject<HTMLElement | null>[];

/** Calls onOutside on a pointer press outside every given element, or on Escape. */
export function useClickOutside(refs: Refs, onOutside: () => void, active = true) {
  useEffect(() => {
    if (!active) return;
    const list = Array.isArray(refs) ? refs : [refs];
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (list.some((r) => r.current?.contains(target))) return;
      if (list.some((r) => r.current)) onOutside();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onOutside();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...(Array.isArray(refs) ? refs : [refs]), onOutside, active]);
}
