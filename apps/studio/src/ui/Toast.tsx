import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";
import "./Toast.css";

export type ToastTone = "info" | "success" | "warning" | "error";

export interface Toast {
  readonly id: string;
  readonly tone: ToastTone;
  /** Already-translated sentence. Never a raw server string. */
  readonly message: string;
}

export interface ToastApi {
  /** Shows a toast; returns its id so a caller can dismiss it early. */
  readonly show: (tone: ToastTone, message: string) => string;
  readonly dismiss: (id: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const AUTO_DISMISS_MS = 6000;

export function ToastProvider({ children }: { readonly children: ReactNode }): ReactNode {
  const [toasts, setToasts] = useState<readonly Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback(
    (tone: ToastTone, message: string) => {
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      setToasts((current) => [...current, { id, tone, message }]);
      // Errors stay until dismissed: an operator who stepped away must still
      // see that their approval failed.
      if (tone !== "error") setTimeout(() => dismiss(id), AUTO_DISMISS_MS);
      return id;
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(() => ({ show, dismiss }), [show, dismiss]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="ui-toasts" role="region" aria-live="polite">
        {toasts.map((toast) => (
          <output key={toast.id} className={`ui-toast ui-toast--${toast.tone}`}>
            <span>{toast.message}</span>
            <button type="button" className="ui-toast__x" onClick={() => dismiss(toast.id)}>
              ✕
            </button>
          </output>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (ctx === null) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
