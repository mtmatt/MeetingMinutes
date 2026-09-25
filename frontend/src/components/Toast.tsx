import { AlertTriangle, CheckCircle2, X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

interface ToastItem {
  id: number;
  message: string;
  kind: "info" | "error";
}

interface ToastApi {
  show: (message: string) => void;
  error: (message: string | unknown) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const seq = useRef(0);

  const remove = useCallback((id: number) => setItems((xs) => xs.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (message: string, kind: ToastItem["kind"]) => {
      const id = ++seq.current;
      setItems((xs) => [...xs.slice(-3), { id, message, kind }]);
      setTimeout(() => remove(id), kind === "error" ? 6000 : 3200);
    },
    [remove],
  );

  const api = useMemo<ToastApi>(
    () => ({
      show: (m) => push(m, "info"),
      error: (e) => push(typeof e === "string" ? e : e instanceof Error ? e.message : "Something went wrong", "error"),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind === "error" ? "error" : ""}`}>
            {t.kind === "error" ? <AlertTriangle /> : <CheckCircle2 />}
            <span className="grow">{t.message}</span>
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
