import { useCallback, useRef, useState, type ReactNode } from "react";
import { useClickOutside } from "../lib/useClickOutside";

/** A button that toggles a popover menu. Children receive a close() callback. */
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
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useClickOutside(ref, close, open);
  return (
    <div className="menu-anchor" ref={ref}>
      {trigger({ open, toggle: () => setOpen((o) => !o) })}
      {open && (
        <div className={`menu ${align === "left" ? "left" : ""} ${up ? "up" : ""} ${className}`} role="menu">
          {children(close)}
        </div>
      )}
    </div>
  );
}
