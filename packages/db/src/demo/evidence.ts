import type { Prisma } from "@prisma/client";
import type { EvidencePackage } from "@maestro/contracts";
import { ago, demoRunId } from "./clock.js";
import { decisionsOfRun } from "./decisions.js";
import { KNOWLEDGE_DOCS } from "./registry.js";
import { DEMO_TICKETS, type DemoTicket } from "./tickets.js";

/** Evidence packages (M34/M56) — one per closed run, 10-year retention. */

export class NoTemplateVersionError extends Error {
  constructor(ticketKey: string) {
    super(`no analysis template version existed when ${ticketKey} started`);
    this.name = "NoTemplateVersionError";
  }
}

/**
 * M83: a flow ends with the template version it *started* with. The version is
 * therefore looked up by the run's `startedAt`, not by "whatever is newest" —
 * which is exactly the bug that pinning exists to prevent, and the reason
 * `KnowledgeDoc` is keyed by `(id, version)`.
 */
function templateVersionAt(ticket: DemoTicket): number {
  const startedAt = ago(ticket.ageHours).getTime();
  const candidates = KNOWLEDGE_DOCS.filter(
    (doc) => doc.id === "analiz-sablonu" && (doc.updatedAt as Date).getTime() <= startedAt,
  );
  const version = candidates.reduce<number | null>(
    (best, doc) => (best === null || doc.version > best ? doc.version : best),
    null,
  );
  if (version === null) throw new NoTemplateVersionError(ticket.key);
  return version;
}

function manifestOf(ticket: DemoTicket): EvidencePackage {
  return {
    runId: demoRunId(ticket.key),
    ticketKey: ticket.key,
    createdAt: ago(ticket.idleHours).toISOString(),
    templateVersion: `v${templateVersionAt(ticket)}`,
    files: [
      { name: "analysis.md", sha256: "0".repeat(64), bytes: 18_432, contentType: "text/markdown" },
      { name: "diff.patch", sha256: "1".repeat(64), bytes: 42_110, contentType: "text/x-diff" },
      { name: "test-report.xml", sha256: "2".repeat(64), bytes: 9_876, contentType: "application/xml" },
    ],
    // The whole approval chain, not an empty array: without it the package
    // proves the work happened but not that anyone signed it off (M34).
    approvals: decisionsOfRun(ticket.key).map(({ ticketKey: _ticketKey, ...decision }) => decision),
    retentionYears: 10,
    objectLock: false,
  };
}

export const EVIDENCE_PACKAGES: Prisma.EvidencePackageRowCreateManyInput[] = DEMO_TICKETS.filter(
  (ticket) => ticket.status === "done",
).map((ticket) => ({
  runId: demoRunId(ticket.key),
  ticketKey: ticket.key,
  createdAt: ago(ticket.idleHours),
  manifestJson: manifestOf(ticket) as unknown as Prisma.InputJsonValue,
  storageKey: `evidence/${ticket.key}/package.zip`,
}));
