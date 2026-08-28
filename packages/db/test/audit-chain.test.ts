import { describe, expect, it } from "vitest";
import { parseActor, rehash, verifyChain } from "@maestro/audit";
import {
  AuditAction,
  EvidencePackage,
  GATES_BY_RISK,
  GateDecision,
} from "@maestro/contracts";
import {
  buildDemoDataset,
  DEMO_AUDIT_EVENTS,
  DEMO_GATE_DECISIONS,
  DEMO_TICKETS,
  decisionsOfRun,
  demoRunId,
  toAuditEvent,
  toEvidencePackage,
} from "../src/index.js";

const data = buildDemoDataset();

/**
 * The audit chain is verified with `@maestro/audit`'s own verifier, not with a
 * second sha256 loop written here. M33 allows exactly one implementation of the
 * chain; a test that re-implements it would prove the copy, not the original.
 */
describe("audit chain (M33) — verified by @maestro/audit", () => {
  const events = data.auditLog.map((row) =>
    toAuditEvent({
      seq: row.seq as bigint,
      at: row.at as Date,
      actor: row.actor,
      action: row.action,
      subject: row.subject,
      prevHash: row.prevHash,
      hash: row.hash,
      metaJson: row.metaJson,
    }),
  );

  it("passes verifyChain from genesis with no findings", () => {
    const result = verifyChain(events);
    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.checked).toBe(data.auditLog.length);
    expect(result.checked).toBeGreaterThan(50);
  });

  it("is the same chain the module exported", () => {
    expect(events).toEqual([...DEMO_AUDIT_EVENTS]);
  });

  it("detects a single altered subject anywhere in the chain", () => {
    const tampered = events.map((event, index) =>
      index === 20 ? { ...event, subject: `${event.subject} (edited)` } : event,
    );
    const result = verifyChain(tampered);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.kind === "hash_mismatch")).toBe(true);
    expect(result.firstBadSeq).toBe(21);
  });

  it("detects a deleted record", () => {
    const result = verifyChain([...events.slice(0, 10), ...events.slice(11)]);
    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.kind === "prev_hash_mismatch")).toBe(true);
  });

  it("uses contract actions, actors the trail accepts, and unique hashes", () => {
    for (const event of events) {
      expect(AuditAction.options).toContain(event.action);
      expect(parseActor(event.actor), event.actor).not.toBeNull();
      expect(rehash(event)).toBe(event.hash);
    }
    expect(new Set(events.map((e) => e.hash)).size).toBe(events.length);
  });

  it("never lets two records share a predecessor (the DB unique index)", () => {
    const prev = data.auditLog.map((row) => row.prevHash);
    expect(new Set(prev).size).toBe(prev.length);
    expect(prev.filter((hash) => hash === "genesis").length).toBe(1);
  });

  it("records every run's start and every closed run's merge + closure", () => {
    const subjectsOf = (action: string): string[] =>
      events.filter((e) => e.action === action).map((e) => String(e.meta["ticketKey"] ?? e.subject));
    expect(new Set(subjectsOf("RUN_STARTED"))).toEqual(new Set(DEMO_TICKETS.map((t) => t.key)));
    const done = DEMO_TICKETS.filter((t) => t.status === "done").map((t) => t.key);
    expect(new Set(subjectsOf("RUN_CLOSED"))).toEqual(new Set(done));
    expect(new Set(subjectsOf("PR_MERGED"))).toEqual(new Set(done));
  });

  it("stores every demo parameter version as a PARAM_CHANGED record", () => {
    const changed = events.filter((e) => e.action === "PARAM_CHANGED");
    expect(changed.length).toBe(data.paramVersions.length);
    for (const version of data.paramVersions) {
      const record = changed.find(
        (e) => e.meta["key"] === version.key && e.meta["version"] === version.version,
      );
      expect(record, `${version.key} v${version.version}`).toBeDefined();
    }
  });
});

describe("gate decision <-> audit record <-> evidence package", () => {
  it("gives every decision an audit record with the same seq", () => {
    expect(DEMO_GATE_DECISIONS.length).toBeGreaterThanOrEqual(15);
    for (const decision of DEMO_GATE_DECISIONS) {
      const record = data.auditLog.find((row) => Number(row.seq) === decision.signatureSeq);
      expect(record, `${decision.ticketKey}/${decision.step}`).toBeDefined();
      expect(record?.action).toBe(decision.decision === "approve" ? "GATE_APPROVE" : "GATE_REJECT");
      expect(record?.actor).toBe(decision.actorUserId);
      expect((record?.at as Date).toISOString()).toBe(decision.at);
    }
  });

  it("issues no duplicate signature", () => {
    const seqs = DEMO_GATE_DECISIONS.map((decision) => decision.signatureSeq);
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it("orders the whole audit array by time (no inversions)", () => {
    const times = data.auditLog.map((row) => (row.at as Date).getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i], `inversion at row ${i}`).toBeGreaterThanOrEqual(times[i - 1] ?? 0);
    }
  });

  it("validates every decision against GateDecision", () => {
    for (const { ticketKey: _ticketKey, ...decision } of DEMO_GATE_DECISIONS) {
      const parsed = GateDecision.safeParse(decision);
      expect(parsed.success, `${_ticketKey}/${decision.step}: ${parsed.error?.message ?? ""}`).toBe(true);
    }
  });

  it("verifies separation of duties instead of asserting it", () => {
    for (const decision of DEMO_GATE_DECISIONS) {
      expect(decision.sodVerified, `${decision.ticketKey}/${decision.step}`).toBe(true);
    }
    const gates501 = decisionsOfRun("UGURPAY-501");
    const po = gates501.find((g) => g.step === "4");
    const techLead = gates501.find((g) => g.step === "5");
    expect(po?.actorUserId).toBeDefined();
    expect(techLead?.actorUserId).toBeDefined();
    expect(po?.actorUserId).not.toBe(techLead?.actorUserId);
  });

  it("gives the approvers the groups their decisions claim", () => {
    const groupsByEmail = new Map(
      data.users.map((user) => [String(user.email), user.groupsJson as string[]]),
    );
    for (const decision of DEMO_GATE_DECISIONS) {
      expect(groupsByEmail.get(decision.actorUserId), decision.actorUserId).toContain(
        decision.actorGroup,
      );
    }
  });

  it("closes every done run with exactly the gate set its risk tier demands (M51)", () => {
    const done = DEMO_TICKETS.filter((ticket) => ticket.status === "done");
    expect(done.length).toBe(5);
    for (const ticket of done) {
      const row = data.evidencePackages.find((pkg) => pkg.runId === demoRunId(ticket.key));
      expect(row, ticket.key).toBeDefined();
      const manifest = toEvidencePackage({ manifestJson: row?.manifestJson });
      const parsed = EvidencePackage.safeParse(manifest);
      expect(parsed.success, `${ticket.key}: ${parsed.error?.message ?? ""}`).toBe(true);
      expect(manifest.approvals.length, ticket.key).toBeGreaterThan(0);
      expect(manifest.approvals.map((a) => a.step).sort(), ticket.key).toEqual(
        [...GATES_BY_RISK[ticket.risk!]].sort(),
      );
      for (const approval of manifest.approvals) {
        expect(approval.decision, `${ticket.key}/${approval.step}`).toBe("approve");
        expect(approval.signatureSeq, `${ticket.key}/${approval.step}`).toBeGreaterThan(0);
      }
    }
  });

  it("writes an evidence package for exactly the closed runs (M56)", () => {
    const done = data.runs.filter((run) => run.status === "done").map((run) => run.id).sort();
    expect(data.evidencePackages.map((pkg) => pkg.runId).sort()).toEqual(done);
  });

  it("pins each package to the template version that existed at start (M83)", () => {
    const versionOf = (ticketKey: string): string =>
      toEvidencePackage({
        manifestJson: data.evidencePackages.find((pkg) => pkg.runId === demoRunId(ticketKey))
          ?.manifestJson,
      }).templateVersion;
    // UGURPAY-478 started after analiz-sablonu v3 landed; UGURMOB-166 before.
    expect(versionOf("UGURPAY-478")).toBe("v3");
    expect(versionOf("UGURMOB-166")).toBe("v2");
  });
});
