import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useClickOutside } from "../lib/useClickOutside";

const GAP = 6;
const EDGE = 8;
const MEASURE: CSSProperties = { position: "fixed", left: 0, top: 0, right: "auto", bottom: "auto", visibility: "hidden" };
const ITEMS = "a[href], button:not(:disabled), [tabindex]:not([tabindex='-1'])";

/**
 * A button that toggles a popover menu. Children receive a close() callback.
 *
 * The popover is rendered on <body> and placed against the viewport, so a menu
 * inside a scrolling, clipped or sticky container (the summary column, for
 * one) is never cut off or covered. It flips above the button when there is no
 * room below and follows the button while the page scrolls. Opening moves
 * focus into the menu; arrow keys move between items; Escape or Tab closes it
 * and returns focus to the button.
 */
export function Menu({
  trigger,
  children,
  align = "right",
  up = false,
  className = "",
}: {
  trigger: (props: { open: boolean; toggle: () => void }) => ReactNode;
  children: (close: () => void) => ReactNode;
  align?: "left" | "right";
  up?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState<CSSProperties | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useClickOutside([ref, menuRef], close, open);

  const focusTrigger = () => ref.current?.querySelector<HTMLElement>("button, a[href]")?.focus();

  /** Where the popover goes, from the trigger's current position; null when the trigger is off screen. */
  const place = useCallback((): CSSProperties | null => {
    const anchor = ref.current?.getBoundingClientRect();
    const menu = menuRef.current;
    if (!anchor || !menu) return null;
    const vw = document.documentElement.clientWidth;
    const vh = window.innerHeight;
    if (anchor.bottom < 0 || anchor.top > vh) return null;
    const w = menu.offsetWidth;
    const h = menu.scrollHeight;
    let left = align === "left" ? anchor.left : anchor.right - w;
    left = Math.max(EDGE, Math.min(left, vw - w - EDGE));
    const below = vh - anchor.bottom - GAP - EDGE;
    const above = anchor.top - GAP - EDGE;
    const goUp = up ? above >= h || above > below : below < h && above > below;
    const next: CSSProperties = { position: "fixed", left, right: "auto", bottom: "auto" };
    next.top = goUp ? Math.max(EDGE, anchor.top - GAP - h) : anchor.bottom + GAP;
    // Very long menus scroll instead of running off screen.
    const room = goUp ? above : below;
    if (h > room) {
      next.maxHeight = Math.max(160, room);
      next.overflowY = "auto";
    }
    return next;
  }, [align, up]);

  useLayoutEffect(() => {
    setStyle(open ? place() : null);
  }, [open, place]);

  // Once placed, move focus to the first item.
  const placed = style != null;
  useEffect(() => {
    if (open && placed) menuRef.current?.querySelector<HTMLElement>(ITEMS)?.focus({ preventScroll: true });
  }, [open, placed]);

  // Keep the popover attached to its button while the page or a container
  // scrolls; close it once the button has scrolled out of view.
  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const follow = (e: Event) => {
      if (menuRef.current && e.target instanceof Node && menuRef.current.contains(e.target)) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const next = place();
        if (next) setStyle(next);
        else setOpen(false);
      });
    };
    window.addEventListener("scroll", follow, true);
    window.addEventListener("resize", follow);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", follow, true);
      window.removeEventListener("resize", follow);
    };
  }, [open, place]);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(menuRef.current?.querySelectorAll<HTMLElement>(ITEMS) ?? []);
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      items[(i + step + items.length) % items.length]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      items[e.key === "Home" ? 0 : items.length - 1]?.focus();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      close();
      focusTrigger();
    } else if (e.key === "Tab") {
      // Leave the menu from where it was opened, so Tab continues in page order.
      close();
      focusTrigger();
    }
  };

  return (
    <div className="menu-anchor" ref={ref}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open &&
        createPortal(
          <div
            ref={menuRef}
            className={`menu ${align === "left" ? "left" : ""} ${up ? "up" : ""} ${className}`}
            role="menu"
            onKeyDown={onKeyDown}
            // Measured unplaced (same sizing rules as when placed), then positioned before paint.
            style={style ?? MEASURE}
          >
            {children(close)}
          </div>,
          document.body,
        )}
    </div>
  );
}
