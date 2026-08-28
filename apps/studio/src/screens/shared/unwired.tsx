import type { ReactNode } from "react";
import { ApiError } from "../../api/errors.ts";
import { NotAvailable, QueryState } from "./QueryState.tsx";
import "../common/screens.css";

/**
 * Renders a screen section whose BFF read model may not exist yet.
 *
 * Several cluster C screens are written against endpoints the BFF has not built
 * (the write surfaces were deliberately deferred; the read models for variants,
 * eval, cache, greenfield, routing, pii and the decision ledger are simply not
 * there yet). Those routes answer 404.
 *
 * A plain 404 renders through the error path as "record not found", which tells
 * the operator the wrong thing: the record is not missing, the endpoint was
 * never built. This wrapper distinguishes the two — a 404/501, or a 503 whose
 * code is `capability_not_wired`, becomes cluster A's `<NotAvailable>` ("not
 * published yet / not wired in this deployment, deliberately blank rather than
 * invented"), while every other failure keeps its translated error.
 *
 * The 503 case matters because the read models that refuse by name (runners,
 * scans, eval — a store this deployment did not wire) answer `503
 * capability_not_wired`, NOT 404. Without it those screens render a red "veri
 * alınamadı" ERROR for a capability that is simply absent — the operator reads a
 * breakage where the honest message is "this platform does not have this yet".
 * A 503 with any OTHER code is a genuine outage and keeps its error.
 *
 * The screens behind this are complete. When a route lands, its screen starts
 * rendering real data with no further change; nothing here needs deleting.
 *
 * NOTE this is a presentation fallback, not a pretence that the call succeeded:
 * no placeholder rows are shown, and the request is still made, so the moment
 * the server answers the screen is live.
 */
export interface MaybeUnwiredProps {
  readonly isPending: boolean;
  readonly error: unknown;
  readonly isEmpty?: boolean;
  readonly emptyTitle?: string;
  readonly emptyIcon?: string;
  readonly onRetry?: (() => void) | undefined;
  readonly skeletonRows?: number;
  readonly children: ReactNode;
}

/** True when a failure means "this endpoint does not exist / is not wired here", not "it broke". */
export function isNotBuilt(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.status === 404 || error.status === 501) return true;
  // A read model that refuses by name (unwired store) answers 503 with this
  // exact code. Any other 503 is a real outage and stays an error.
  return error.status === 503 && error.code === "capability_not_wired";
}

/**
 * An honest "not wired yet" strip for screens whose UI is COMPLETE but whose
 * effect on the engine is not live: the page renders and saves, yet the thing
 * it configures does not fire yet (template edits the engine ignores, notify
 * settings no channel delivers). `MaybeUnwired` covers the missing-READ case;
 * this covers the missing-EFFECT case — without it the screen quietly poses as
 * a working control panel.
 */
export function UnwiredNote({ children }: { readonly children: ReactNode }): ReactNode {
  return (
    <div className="scr-note scr-note--warn" role="note">
      {children}
    </div>
  );
}

export function MaybeUnwired({
  isPending,
  error,
  isEmpty = false,
  emptyTitle,
  emptyIcon,
  onRetry,
  skeletonRows = 4,
  children,
}: MaybeUnwiredProps): ReactNode {
  if (!isPending && isNotBuilt(error)) return <NotAvailable />;

  return (
    <QueryState
      isPending={isPending}
      error={error}
      isEmpty={isEmpty}
      {...(emptyTitle === undefined ? {} : { emptyTitle })}
      {...(emptyIcon === undefined ? {} : { emptyIcon })}
      {...(onRetry === undefined ? {} : { onRetry })}
      skeletonRows={skeletonRows}
    >
      {children}
    </QueryState>
  );
}
