import { parseWebhookEvent } from "@maestro/adapter-jira";
import type { WorkEvent, WorkEventReader } from "@maestro/bff";

/**
 * The `WorkEventReader` the BFF injects.
 *
 * `WorkPort` has no `parseEvent`, so the BFF declares the narrow shape it needs
 * out of a VERIFIED delivery and the composition root builds it from the same
 * driver the work port came from. Deriving it here — rather than in the BFF —
 * is what keeps `apps/bff` free of a Jira import (M44).
 *
 * The reader is deliberately not a re-implementation: it delegates to the
 * driver's own `parseWebhookEvent` and only narrows the result. A second
 * parser would be a second grammar to keep in step with Jira, and the two
 * would drift on the first payload shape nobody thought to test.
 */
export function jiraWorkEventReader(): WorkEventReader {
  return {
    read(payload: unknown): WorkEvent {
      const event = parseWebhookEvent(payload);
      if (event.kind === "other") return { kind: "other" };

      // Labels decide whether an `opt_in` project takes the ticket at all
      // (M48a), so they are read from the issue the driver already validated
      // rather than from the raw envelope.
      const labels = labelsOf(event.issue);
      // Status, issue type and assignee decide which FLOW the ticket runs
      // (`apps/bff/src/flow-decision.ts`). They are read from the delivery for
      // the same reason labels are: the frozen `TicketSnapshot` carries no
      // status at all, so a second Jira round-trip would be the only other way
      // to learn it — and it would be a different read of a moving ticket.
      const status = nameOf(event.issue, "status");
      const issueType = nameOf(event.issue, "issuetype");
      const assignee = assigneeOf(event.issue);
      return {
        kind: event.kind,
        ticketKey: event.ticketKey,
        ...(labels === null ? {} : { labels }),
        ...(status === null ? {} : { status }),
        ...(issueType === null ? {} : { issueType }),
        ...(assignee === null ? {} : { assignee }),
      };
    },
  };
}

/**
 * `issue.fields.labels`, or `null` when the payload carries none.
 *
 * `null` and `[]` are different answers and the difference matters: an empty
 * array says "this ticket has no labels", which in an `opt_in` project means
 * "do not take it". A payload that simply omitted the field must not be read
 * as that, so it stays absent and the caller decides.
 */
function labelsOf(issue: unknown): string[] | null {
  const fields = asRecord(asRecord(issue)?.["fields"]);
  const labels = fields?.["labels"];
  if (!Array.isArray(labels)) return null;
  return labels.filter((label): label is string => typeof label === "string");
}

/**
 * `issue.fields.<field>.name`, or `null` when the payload carries none.
 *
 * Both `status` and `issuetype` are objects with a `name` in every Jira flavour
 * (DC and Cloud alike), which is the value a listening rule's `matchValue`
 * holds — an admin picks it off the Studio screen as the words they see in
 * Jira. Whitespace-only is treated as absent: a rule must not match on it.
 */
function nameOf(issue: unknown, field: string): string | null {
  const fields = asRecord(asRecord(issue)?.["fields"]);
  const name = asRecord(fields?.[field])?.["name"];
  return typeof name === "string" && name.trim().length > 0 ? name.trim() : null;
}

/**
 * The assignee, in the form the listening rules store it.
 *
 * `accountId` FIRST because that is what `ListeningRule.assigneeAccountId`
 * holds and, on Jira Cloud, the only identifier an assignee object carries at
 * all — `name`/`key`/`emailAddress` are absent there (the same asymmetry that
 * broke membership checks, HANDOFF item 3). The DC fields follow as a fallback
 * so a Data Center deployment, whose users have no `accountId`, still matches.
 *
 * `null` (unassigned, or a payload that omitted the field) matches only rules
 * that name no assignee.
 */
function assigneeOf(issue: unknown): string | null {
  const fields = asRecord(asRecord(issue)?.["fields"]);
  const assignee = asRecord(fields?.["assignee"]);
  if (assignee === null) return null;
  for (const key of ["accountId", "name", "key", "emailAddress"]) {
    const value = assignee[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
