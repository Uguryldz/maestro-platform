import { TicketKey } from "./common.js";

/**
 * Branch naming is a CONTRACT, not an adapter detail (M49 trunk-based).
 * The producer (engineering session) and the consumer (CI signal parser)
 * must derive it from the same place — a mismatched convention is exactly
 * how v1's CI gate silently stopped firing.
 */
export const FEATURE_BRANCH_PREFIX = "feature/";

const FEATURE_BRANCH_RE = /^(?:refs\/heads\/)?feature\/([A-Z][A-Z0-9]+-\d+)(?:-[a-z0-9-]*)?$/;

/** Slugify a short description for the branch suffix (ASCII, lowercase). */
export function branchSlug(text: string): string {
  const map: Record<string, string> = { ç: "c", ğ: "g", ı: "i", ö: "o", ş: "s", ü: "u" };
  return text
    .toLowerCase()
    .replace(/[çğıöşü]/g, (c) => map[c] ?? c)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/** Canonical feature branch name for a ticket, e.g. feature/UGURPAY-123-limit-artirma. */
export function featureBranchName(ticketKey: TicketKey, description?: string): string {
  const slug = description ? branchSlug(description) : "";
  return `${FEATURE_BRANCH_PREFIX}${ticketKey}${slug ? `-${slug}` : ""}`;
}

/** Extract the ticket key from a branch name or ref; null when it is not ours. */
export function extractTicketKeyFromBranch(branchOrRef: string): TicketKey | null {
  const match = FEATURE_BRANCH_RE.exec(branchOrRef.trim());
  return match?.[1] ?? null;
}
