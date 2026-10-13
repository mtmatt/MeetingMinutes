import { AlertTriangle, CheckCircle2, X } from "lucide-react";
import { useI18n } from "../i18n";
import { apiErrorMessage } from "../lib/errors";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

/** A button in a toast, such as "Undo"; using it closes the toast. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

interface ToastItem {
  id: number;
  message: string;
  kind: "info" | "error";
  action?: ToastAction;
}

interface ToastApi {
  show: (message: string, action?: ToastAction) => void;
  error: (message: string | unknown) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const remove = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (message: string, kind: ToastItem["kind"], action?: ToastAction) => {
      const id = ++seq.current;
      setItems((xs) => [...xs.slice(-3), { id, message, kind, action }]);
      // Longer when there is something to do, so the button can be reached.
      setTimeout(() => remove(id), kind === "error" ? 6000 : action ? 8000 : 3200);
    },
    [remove],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show: (m, action) => push(m, "info", action),
      error: (e) => push(typeof e === "string" ? e : apiErrorMessage(e, t), "error"),
    }),
    [push, t],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind === "error" ? "error" : ""}`}>
            {t.kind === "error" ? <AlertTriangle /> : <CheckCircle2 />}
            <span className="grow">{t.message}</span>
            {t.action && (
              <button
                className="btn btn-sm btn-ghost toast-action"
                onClick={() => {
                  remove(t.id);
                  t.action!.onClick();
                }}
              >
                {t.action.label}
              </button>
            )}
            <button className="icon-btn sm" style={{ color: "inherit" }} onClick={() => remove(t.id)} aria-label="Dismiss">
              <X />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const v = useContext(ToastContext);
  if (!v) throw new Error("useToast outside provider");
  return v;
}
