import { GateDecision, type JournalEntry } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import {
  buildBootstrapPackage,
  type BootstrapDeps,
  type BootstrapInput,
} from "../src/bootstrap.js";
import { appendJournal } from "../src/journal.js";
import { buildLivingSummary } from "../src/summary.js";
import { fakeJournalStore, JournalTable } from "./fakes/journal-table.js";
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

describe("buildBootstrapPackage", () => {
  it("carries summary, diff, open rejections and protected paths", () => {
    const pack = buildBootstrapPackage(input(), deps());
    expect(pack.generatedAt).toBe(NOW);
    expect(pack.upToSeq).toBe(3);
    expect(pack.text).toContain("## living summary");
    expect(pack.text).toContain("impact matrix written");
    expect(pack.text).toContain("## last diff");
    expect(pack.text).toContain("sha abc1234");
    expect(pack.text).toContain("## open rejections");
    expect(pack.text).toContain("migration touched");
    expect(pack.text).toContain("## protected paths");
    expect(pack.diff?.fileCount).toBe(2);
  });

  it("warns that the last diff already touches a protected path (M52)", () => {
    const pack = buildBootstrapPackage(input(), deps());
    expect(pack.protectedPathHits).toEqual([
      { file: "db/migrations/0007_add_col.sql", pattern: "db/migrations/**" },
    ]);
    expect(pack.text).toContain("!! the last diff already touches protected paths");
  });

  it("falls back to the M52 defaults when the repo declares none", () => {
    const pack = buildBootstrapPackage(input({ protectedPaths: undefined }), deps());
    expect(pack.protectedPaths).toContain("**/migrations/**");
    expect(pack.protectedPathHits.map((hit) => hit.file)).toEqual([
      "db/migrations/0007_add_col.sql",
    ]);
  });

  it("rebuilds a deleted workspace's context out of the record alone (M65)", async () => {
    // The honest form of this test: nothing is handed to the bootstrap that a
    // disk could have supplied. The journal is read back out of the store and
    // the gate decisions out of their own table, exactly as they would be
    // after the clone was swept — and the diff the agent last produced is
    // recovered from the journal entry that recorded it, not from a workspace.
    const table = new JournalTable();
    const store = fakeJournalStore(table);
    const journalDeps = { store, masker: testMasker(), clock: fixedClock(NOW) };
    await appendJournal(journalDeps, {
      runId: RUN_ID,
      actor: "ai",
      kind: "analysis",
      title: "impact matrix written",
    });
    await appendJournal(journalDeps, {
      runId: RUN_ID,
      actor: "human",
      kind: "gate",
      title: "TL rejected: migration touched",
    });
    await appendJournal(journalDeps, {
      runId: RUN_ID,
      actor: "ai",
      kind: "engineering",
      title: "diff abc1234 pushed",
      detail: "2 files: src/pay/service.ts, db/migrations/0007_add_col.sql",
    });

    // A new process, a new masker, an empty disk.
    const recovered = await store.list(RUN_ID);
    const pack = buildBootstrapPackage(
      {
        runId: RUN_ID,
        ticketKey: TICKET_KEY,
        entries: recovered,
        gateDecisions: [
          gate({ step: "5", decision: "reject", signatureSeq: 4, reason: "migration touched" }),
        ],
        lastDiff: {
          sha: "abc1234",
          filesChanged: ["src/pay/service.ts", "db/migrations/0007_add_col.sql"],
        },
        protectedPaths: ["db/migrations/**"],
        workspacePresent: false,
        sessionRestored: true,
      },
      deps(),
    );

    expect(pack.upToSeq).toBe(2);
    expect(pack.text).toContain("workspace: ABSENT");
    expect(pack.text).toContain("60 days");
    expect(pack.text).toContain("nothing has been lost");
    expect(pack.text).toContain("session: restored from the archive");
    // …and every load-bearing piece is in the text although no clone exists.
    expect(pack.text).toContain("impact matrix written");
    expect(pack.text).toContain("TL rejected: migration touched");
    expect(pack.text).toContain("diff abc1234 pushed");
    expect(pack.text).toContain("migration touched");
    expect(pack.text).toContain("!! the last diff already touches protected paths");
    expect(pack.summary.text).toBe(buildLivingSummary(RUN_ID, recovered).text);
  });

  it("says the same thing with or without the clone, minus the two status lines", () => {
    const withWorkspace = buildBootstrapPackage(input(), deps());
    const archived = buildBootstrapPackage(
      input({ workspacePresent: false, sessionRestored: true }),
      deps(),
    );
    const strip = (text: string): string =>
      text
        .split("\n")
        .filter((line) => !line.startsWith("workspace:") && !line.startsWith("session:"))
        .join("\n");
    expect(strip(archived.text)).toBe(strip(withWorkspace.text));
  });

  it("tells a session-less resume to start fresh from the written context", () => {
    const pack = buildBootstrapPackage(
      input({ workspacePresent: false, sessionRestored: false }),
      deps(),
    );
    expect(pack.text).toContain("no agent session file available");
    expect(pack.text).toContain("impact matrix written");
  });

  it("masks anything a caller assembled by hand", () => {
    const pack = buildBootstrapPackage(
      input({
        lastDiff: {
          filesChanged: ["src/a.ts"],
          note: `pinged ${SAMPLE_EMAIL} about the mapper`,
        },
      }),
      deps(),
    );
    expect(pack.diff?.note).toMatch(/\[EMAIL_1\.[0-9a-f]+\]/);
    expect(pack.text).not.toContain(SAMPLE_EMAIL);
  });
});
