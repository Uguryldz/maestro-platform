import { describe, expect, it } from "vitest";
import { buildSessionBootstrap, composeTurnPrompt, DEFAULT_BOOTSTRAP_LIMITS } from "../src/bootstrap.js";
import { bootstrapContext, journalEntry } from "./helpers.js";

describe("buildSessionBootstrap", () => {
  it("hands the agent the ledger, the living summary and the workspace state (M30)", () => {
    const text = buildSessionBootstrap(bootstrapContext());
    expect(text).toContain("UGURPAY-42");
    expect(text).toContain("Ticket accepted; analysis approved.");
    expect(text).toContain("#0 [2026-08-08T10:00:00.000Z] ai/intake: ticket picked up");
    expect(text).toContain("branch: feat/x");
    expect(text).toContain("base commit: abc1234");
    expect(text).toContain("Add the missing null check in the payment mapper.");
  });

  it("names the protected paths before the session is judged by them (M52)", () => {
    const text = buildSessionBootstrap(bootstrapContext({ protectedPaths: ["db/migrations/**", "**/secrets/**"] }));
    expect(text).toContain("db/migrations/**");
    expect(text).toContain("**/secrets/**");
    expect(text).toContain("fails the session and hands the ticket to a human");
  });

  it("lists the MCP servers as the only way out (K66)", () => {
    const text = buildSessionBootstrap(bootstrapContext());
    expect(text).toContain("- jira");
    expect(text).toContain("- workspace");
  });

  it("says so explicitly when the sandbox is fresh", () => {
    const text = buildSessionBootstrap(
      bootstrapContext({ workspace: { path: "/w/x", present: false, branch: null, baseSha: null, dirtyFiles: [] } }),
    );
    expect(text).toContain("NOT PRESENT");
    expect(text).not.toContain("branch:");
  });

  it("reports the previous turn's dirty files when the workspace survived", () => {
    const text = buildSessionBootstrap(
      bootstrapContext({
        workspace: { path: "/w/x", present: true, branch: "b", baseSha: "a1b2c3d", dirtyFiles: ["src/a.ts"] },
      }),
    );
    expect(text).toContain("- src/a.ts");
  });

  it("keeps the newest journal entries and says how many were dropped", () => {
    const journal = Array.from({ length: 45 }, (_, i) => journalEntry(i));
    const text = buildSessionBootstrap(bootstrapContext({ journal }));
    expect(text).toContain("(5 older entries omitted");
    expect(text).not.toContain("#4 [");
    expect(text).toContain("#44 [");
  });

  it("clips a long detail rather than blowing the context window", () => {
    const journal = [journalEntry(1, { detail: "x".repeat(900) })];
    const text = buildSessionBootstrap(bootstrapContext({ journal }));
    expect(text).toContain(`[${900 - DEFAULT_BOOTSTRAP_LIMITS.maxDetailChars} chars trimmed]`);
  });

  it("is a pure function of its input", () => {
    const ctx = bootstrapContext();
    expect(buildSessionBootstrap(ctx)).toBe(buildSessionBootstrap(ctx));
  });

  it("admits an empty ledger instead of pretending there is history", () => {
    const text = buildSessionBootstrap(bootstrapContext({ journal: [], livingSummary: null }));
    expect(text).toContain("(none yet)");
    expect(text).toContain("first thing that ever happened");
  });
});

describe("composeTurnPrompt", () => {
  it("bootstraps a new session", () => {
    const prompt = composeTurnPrompt(bootstrapContext(), false);
    expect(prompt).toContain("# Session bootstrap");
  });

  it("sends the task alone on resume — the vendor session already holds the rest", () => {
    const ctx = bootstrapContext();
    expect(composeTurnPrompt(ctx, true)).toBe(ctx.task);
  });
});
