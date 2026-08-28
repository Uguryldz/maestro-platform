import { IsoDateTime } from "@maestro/contracts";
import { JiraResponseError } from "./errors.js";

/**
 * Jira DC serialises timestamps as `2026-08-08T13:12:33.000+0300` — an RFC 822
 * style offset without the colon, which our IsoDateTime contract rejects.
 * Webhook envelopes additionally carry epoch millis. Normalise both to the
 * contract form instead of loosening the contract.
 */
export function normalizeJiraDateTime(value: unknown, context: string): IsoDateTime {
  let candidate: string;
  if (typeof value === "number" && Number.isFinite(value)) {
    candidate = new Date(value).toISOString();
  } else if (typeof value === "string") {
    candidate = value.trim().replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  } else {
    throw new JiraResponseError(context, [`expected an ISO timestamp, got ${typeof value}`]);
  }

  const parsed = IsoDateTime.safeParse(candidate);
  if (!parsed.success) {
    throw new JiraResponseError(context, [`"${candidate}" is not an ISO-8601 timestamp with offset`]);
  }
  return parsed.data;
}
