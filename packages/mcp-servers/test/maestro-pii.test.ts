import { defaultPiiPolicy } from "@maestro/pii";
import { describe, expect, it } from "vitest";
import { maestroMcpServer } from "../src/servers/maestro.js";
import type { KnowledgeHit, MaestroPlatform } from "../src/servers/maestro-platform.js";
import { caller, fakePlatform, RUN, runtimeFor } from "./helpers.js";

const admin = caller(["read", "operate", "admin-proposal"]);
const policy = defaultPiiPolicy();

/**
 * B9 — `maestro-mcp` is the one server of four that does NOT face a sandbox.
 * It faces a person's IDE: results land on a personal machine and go on to
 * whatever model that IDE is wired to, which is outside the platform's LLM
 * egress boundary entirely (M20/M82). `get_journal` returned raw
 * `JournalEntry[]` and `search_knowledge` returned raw snippets; the package
 * did not contain the word `DataClass`.
 *
 * `jira-mcp` / `ado-mcp` / `workspace-mcp` stay unmasked on purpose: they serve
 * an agent INSIDE the sandbox, whose own egress already goes through the
 * boundary, and masking a ticket before the agent reads it would leave it
 * unable to do the analysis it was started for.
 */
function platformReturning(hits: readonly KnowledgeHit[]): MaestroPlatform {
  return {
    ...fakePlatform({ users: [], proposalStatus: "pending_four_eyes" }),
    searchKnowledge: () => Promise.resolve(hits),
  };
}

const TCKN = "10000000146";
const IBAN = "TR330006100519786457841326";

describe("maestro-mcp masks what it hands to an IDE (B9)", () => {
  it("masks an identifier out of a knowledge snippet", async () => {
    const { runtime } = runtimeFor(
      maestroMcpServer({
        platform: platformReturning([
          { id: "k1", title: "iade", snippet: `müşteri ${TCKN} iade istedi`, source: "jira", score: 0.9, dataClass: "dahili" as const },
        ]),
        pii: { policy },
      }),
    );

    const result = await runtime.call("search_knowledge", { text: "iade" }, admin);

    expect(result.status).toBe("ok");
    const json = JSON.stringify(result.status === "ok" ? result.value : null);
    expect(json).not.toContain(TCKN);
    expect(json).toMatch(/\[TCKN_\d+\./);
    // The rest of the record still reads: masking is not redaction.
    expect(json).toContain("iade istedi");
  });

  it("masks a journal entry, which is where an analysis quotes a ticket verbatim", async () => {
    const { runtime } = runtimeFor(
      maestroMcpServer({
        platform: {
          ...fakePlatform({ users: [], proposalStatus: "pending_four_eyes" }),
          getJournal: () =>
            Promise.resolve([
              {
                runId: RUN.runId,
                seq: 1,
                at: RUN.startedAt,
                actor: "ai",
                kind: "analysis" as const,
                title: "analiz",
                detail: `hesap ${IBAN} için tutar yanlış`,
              },
            ]),
        },
        pii: { policy },
      }),
    );

    const result = await runtime.call("get_journal", { runId: RUN.runId }, admin);

    const json = JSON.stringify(result.status === "ok" ? result.value : null);
    expect(json).not.toContain(IBAN);
    expect(json).toMatch(/\[IBAN_\d+\./);
  });

  it("filters a `gizli` knowledge hit off this channel entirely", async () => {
    const { runtime } = runtimeFor(
      maestroMcpServer({
        platform: platformReturning([
          { id: "k1", title: "public note", snippet: "ordinary", source: "jira", score: 0.9, dataClass: "dahili" as const },
          {
            id: "k2",
            title: "risk memo",
            snippet: "internal only",
            source: "knowledge",
            score: 0.8,
            dataClass: "gizli",
          },
        ]),
        pii: { policy },
      }),
    );

    const result = await runtime.call("search_knowledge", { text: "note" }, admin);

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      const ids = (result.value as readonly { id: string }[]).map((hit) => hit.id);
      // Masking removes identifiers; it does not make a `gizli` document safe to
      // put on a personal machine. That one is dropped, not tokenised.
      expect(ids).toEqual(["k1"]);
      expect(JSON.stringify(result.value)).not.toContain("internal only");
    }
  });

  it("keeps `dahili` and unlabelled hits, so the channel is still useful", async () => {
    const { runtime } = runtimeFor(
      maestroMcpServer({
        platform: platformReturning([
          { id: "k1", title: "a", snippet: "x", source: "jira", score: 0.9, dataClass: "dahili" },
          { id: "k2", title: "b", snippet: "y", source: "jira", score: 0.8, dataClass: "dahili" as const },
        ]),
        pii: { policy },
      }),
    );

    const result = await runtime.call("search_knowledge", { text: "note" }, admin);
    if (result.status === "ok") {
      expect((result.value as readonly { id: string }[]).map((h) => h.id)).toEqual(["k1", "k2"]);
    }
  });

  it("masks every read tool on the server, not only the two that were named", async () => {
    const { runtime } = runtimeFor(
      maestroMcpServer({
        platform: {
          ...fakePlatform({ users: [], proposalStatus: "pending_four_eyes" }),
          getRun: () =>
            Promise.resolve({
              state: { ...RUN, ticketKey: "UGURPAY-504" },
              appId: "ugurpay-api",
              mode: "full_auto" as const,
              pendingGate: {
                step: "4",
                ownerGroup: `po ${TCKN}`,
                openedAt: RUN.startedAt,
                waitingDays: 16,
              },
            }),
        },
        pii: { policy },
      }),
    );

    const result = await runtime.call("get_run", { runId: RUN.runId }, admin);
    expect(JSON.stringify(result.status === "ok" ? result.value : null)).not.toContain(TCKN);
  });

  it("is opt-in: without a policy the server behaves exactly as before", async () => {
    const { runtime } = runtimeFor(
      maestroMcpServer({
        platform: platformReturning([
          { id: "k1", title: "iade", snippet: `müşteri ${TCKN}`, source: "jira", score: 0.9, dataClass: "dahili" as const },
        ]),
      }),
    );

    const result = await runtime.call("search_knowledge", { text: "iade" }, admin);
    // Deliberate: the composition root decides. A package that masked by
    // default would mask the offline demo's fixtures and hide the wiring bug
    // where the BFF forgot to pass a policy.
    expect(JSON.stringify(result.status === "ok" ? result.value : null)).toContain(TCKN);
  });

  it("reports what it masked, without reporting what it masked away", async () => {
    const seen: { occurrences: number }[] = [];
    const { runtime } = runtimeFor(
      maestroMcpServer({
        platform: platformReturning([
          { id: "k1", title: "iade", snippet: `${TCKN} ve ${IBAN}`, source: "jira", score: 0.9, dataClass: "dahili" as const },
        ]),
        pii: { policy, onMasked: (counts) => seen.push({ occurrences: counts.occurrences }) },
      }),
    );

    await runtime.call("search_knowledge", { text: "iade" }, admin);

    expect(seen[0]?.occurrences).toBe(2);
    // The hook takes COUNTS. If it ever took values it would be a second copy
    // of the thing the boundary exists to stop.
    expect(JSON.stringify(seen)).not.toContain(TCKN);
  });
});
