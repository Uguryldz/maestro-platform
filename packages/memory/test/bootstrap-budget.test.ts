import { GateDecision, type JournalEntry } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import {
  buildBootstrapPackage,
  type BootstrapDeps,
  type BootstrapInput,
} from "../src/bootstrap.js";
import { entry, fixedClock, RUN_ID, SAMPLE_EMAIL, testMasker, TICKET_KEY } from "./fakes/support.js";

const NOW = "2026-08-08T12:00:00+03:00";

function deps(): BootstrapDeps {
  return { masker: testMasker(), clock: fixedClock(NOW) };
}

function gate(input: {
  step: GateDecision["step"];
  decision: GateDecision["decision"];
  signatureSeq: number;
  reason?: string;
  at?: string;
  actorGroup?: string;
  actorUserId?: string;
  sodVerified?: boolean;
}): GateDecision {
  return GateDecision.parse({
    step: input.step,
    decision: input.decision,
    actorUserId: input.actorUserId ?? "u.yildiz",
    actorGroup: input.actorGroup ?? "tech-leads",
    sodVerified: input.sodVerified ?? true,
    signatureSeq: input.signatureSeq,
    source: "studio",
    at: input.at ?? "2026-08-07T09:00:00+03:00",
    ...(input.reason === undefined ? {} : { reason: input.reason }),
  });
}

const JOURNAL: JournalEntry[] = [
  entry({ seq: 0, kind: "intake", title: "ticket read" }),
  entry({ seq: 1, kind: "analysis", title: "impact matrix written" }),
  entry({ seq: 2, kind: "gate", actor: "human", title: "TL rejected: migration touched" }),
  entry({ seq: 3, kind: "engineering", title: "patch reworked" }),
];

function input(overrides: Partial<BootstrapInput> = {}): BootstrapInput {
  return {
    runId: RUN_ID,
    ticketKey: TICKET_KEY,
    entries: JOURNAL,
    gateDecisions: [gate({ step: "5", decision: "reject", signatureSeq: 4, reason: "migration touched" })],
    lastDiff: {
      sha: "abc1234",
      filesChanged: ["src/pay/service.ts", "db/migrations/0007_add_col.sql"],
      insertions: 40,
      deletions: 3,
      note: "reworked the mapper",
    },
    protectedPaths: ["db/migrations/**", "**/*.pem"],
    workspacePresent: true,
    ...overrides,
  };
}

describe("buildBootstrapPackage · budget and masking", () => {
  it("keeps a huge diff listing inside the text budget", () => {
    const pack = buildBootstrapPackage(
      input({
        lastDiff: {
          filesChanged: Array.from({ length: 500 }, (_, i) => `src/file-${i}.ts`),
        },
      }),
      { ...deps(), maxChars: 4000 },
    );
    expect(pack.text.length).toBeLessThanOrEqual(4000);
    expect(pack.text).toContain("more files)");
  });

  it("keeps the M52 warning when one reviewer pasted a log into a rejection (Y-3)", () => {
    // A single 40 000-character rejection reason used to push the protected
    // paths section — the last thing in the text — past the budget, so the
    // resumed agent was never told not to touch the migration.
    const pack = buildBootstrapPackage(
      input({
        gateDecisions: [
          gate({
            step: "5",
            decision: "reject",
            signatureSeq: 4,
            reason: `build log follows: ${"x".repeat(40000)}`,
          }),
        ],
      }),
      deps(),
    );
    expect(pack.text.length).toBeLessThanOrEqual(16000);
    expect(pack.text).toContain("## protected paths");
    expect(pack.text).toContain("!! the last diff already touches protected paths");
    expect(pack.text).toContain("db/migrations/0007_add_col.sql");
    // The reason is present, but as a field-clipped line, not as a flood.
    expect(pack.text).toContain("build log follows");
    const reasonLine = pack.text
      .split("\n")
      .find((line) => line.includes("build log follows")) as string;
    expect(reasonLine.length).toBeLessThanOrEqual(600);
    expect(pack.text).toContain("## living summary");
  });

  it("keeps the M52 warning even on a tight budget", () => {
    const pack = buildBootstrapPackage(input(), { ...deps(), maxChars: 1500 });
    expect(pack.text.length).toBeLessThanOrEqual(1500);
    expect(pack.text).toContain("## open rejections");
    expect(pack.text).toContain("!! the last diff already touches protected paths");
  });

  it("says how many open rejections it left out (O-11)", () => {
    const steps: GateDecision["step"][] = [
      "0", "2", "3", "4", "5", "7", "8", "9", "10", "11", "12", "13", "2b", "3o", "6a",
    ];
    const many = steps.map((step, i) =>
      gate({ step, decision: "reject", signatureSeq: i + 1, reason: `finding ${i + 1}` }),
    );
    const pack = buildBootstrapPackage(input({ gateDecisions: many }), deps());
    expect(pack.openRejections).toHaveLength(15);
    expect(pack.text).toContain("(5 earlier open rejections omitted)");
    // The newest are the ones printed.
    expect(pack.text).toContain("finding 15");
  });

  it("does not strip the brackets off another session's tokens (O-9)", () => {
    // Journal entries were masked by the run that wrote them. Re-masking the
    // assembled text de-fangs tokens the current masker did not mint, and
    // `[EMAIL_1.ab12]` silently becomes `EMAIL_1.ab12` — the reader can no
    // longer tell that something was removed there.
    const writer = testMasker();
    const masked = writer.text(`reporter ${SAMPLE_EMAIL}`);
    const token = /\[EMAIL_1\.[0-9a-f]+\]/.exec(masked)?.[0] as string;
    const pack = buildBootstrapPackage(
      input({
        entries: [entry({ seq: 0, kind: "intake", title: `ticket from ${masked}` })],
      }),
      deps(),
    );
    expect(pack.text).toContain(token);
    expect(pack.text).not.toContain(SAMPLE_EMAIL);
  });

  it("still refuses to hand out unmasked PII a caller assembled by hand", () => {
    expect(() =>
      buildBootstrapPackage(
        input({ entries: [entry({ seq: 0, title: `call ${SAMPLE_EMAIL}` })] }),
        deps(),
      ),
    ).toThrow();
  });

  it("flags a decision that failed its SoD check (M32)", () => {
    const pack = buildBootstrapPackage(
      input({
        gateDecisions: [
          gate({ step: "5", decision: "reject", signatureSeq: 1, reason: "no tests" }),
          gate({ step: "5", decision: "approve", signatureSeq: 2, sodVerified: false }),
        ],
      }),
      deps(),
    );
    expect(pack.suspectDecisions).toHaveLength(1);
    expect(pack.text).toContain("## decisions that failed the SoD check (M32)");
    expect(pack.openRejections).toHaveLength(1);
  });

  it("works with nothing but a journal", () => {
    const pack = buildBootstrapPackage(
      { runId: RUN_ID, ticketKey: TICKET_KEY, entries: JOURNAL, workspacePresent: false },
      deps(),
    );
    expect(pack.openRejections).toEqual([]);
    expect(pack.diff).toBeUndefined();
    expect(pack.text).toContain("## living summary");
  });
});
