import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import "./Modal.css";

export interface ModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  /** Already-translated dialog title. */
  readonly title: string;
  /** Footer slot, usually a cancel + confirm Button pair. */
  readonly footer?: ReactNode;
  /** Already-translated accessible name for the close affordance. */
  readonly closeLabel: string;
  readonly children: ReactNode;
}

/**
 * Mirrors `.modal-bg` / `.modal` from the mock, rendered as a real <dialog> so
 * focus trapping, Escape and the top layer come from the platform rather than
 * from hand-rolled key handlers.
 */
export function Modal({ open, onClose, title, footer, closeLabel, children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (dialog === null) return;
    // jsdom implements showModal only in recent versions; guard so tests that
    // render a closed modal never explode on an older DOM.
    if (open && !dialog.open) dialog.showModal?.();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  if (!open) return null;

  return (
    <dialog
      ref={ref}
      className="ui-modal"
      aria-label={title}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        // Clicking the backdrop (the dialog element itself) dismisses.
        if (event.target === ref.current) onClose();
      }}
    >
      <header className="ui-modal__hd">
        <h3>{title}</h3>
        <button type="button" className="ui-modal__x" onClick={onClose} aria-label={closeLabel}>
          ✕
        </button>
      </header>
      <div className="ui-modal__bd">{children}</div>
      {footer !== undefined && <footer className="ui-modal__ft">{footer}</footer>}
    </dialog>
  );
}
