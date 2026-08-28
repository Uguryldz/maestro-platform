import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

interface Props {
  readonly children: ReactNode;
}

interface State {
  readonly error: Error | null;
}

/**
 * Catches render failures — most importantly MissingMessageError, thrown when a
 * screen asks for a catalog key nobody wrote. The catalog fails loudly by
 * design (no silent fallback to the key name), so this boundary is what turns
 * that throw into a visible red panel instead of a blank page.
 *
 * The message shown here is the ONE place raw English text is allowed: if the
 * catalog itself is broken, a catalog lookup cannot describe the problem.
 *
 * That licence is narrow, and the detail is now scoped to match it. A broken
 * catalog needs the missing KEY on screen — that is the only way to act on it,
 * and a key is a build-time identifier we wrote ourselves. Every other error
 * reaching here shows its class and nothing more: an `ApiError`'s message is
 * `api ${status} ${code}` (api/errors.ts), so a wrapped one used to put an HTTP
 * status and a server error code in front of an end user who can do nothing
 * with either. The full error still goes to the console for an operator with
 * devtools open, which is where that detail belongs.
 */

/** Names whose `message` is safe and necessary to show — see the note above. */
const DETAILED_ERRORS: readonly string[] = ["MissingMessageError"];
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("[studio] render failed", error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    return (
      <div
        role="alert"
        style={{
          margin: 20,
          padding: 16,
          border: "1px solid var(--red)",
          background: "var(--red-bg)",
          color: "var(--red)",
          borderRadius: 9,
          fontSize: 13,
        }}
      >
        {/*
          Both languages, hard-coded, on purpose. This panel is what shows when
          the CATALOG is broken, so it cannot call `t()` to translate itself —
          a lookup is exactly the thing that just failed. Turkish first because
          it is the platform's primary language, and the operator who hits this
          must not be handed a sentence they cannot read.
        */}
        <strong lang="tr">Studio bu ekranı görüntüleyemedi.</strong>
        <br />
        <strong lang="en">Studio failed to render this screen.</strong>
        <pre style={{ whiteSpace: "pre-wrap", marginBottom: 0 }}>
          {DETAILED_ERRORS.includes(error.name) ? `${error.name}: ${error.message}` : error.name}
        </pre>
      </div>
    );
  }
}
