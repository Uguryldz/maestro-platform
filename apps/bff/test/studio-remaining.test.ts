import { describe, expect, it } from "vitest";
import type {
  DecisionReader,
  PiiReader,
  StudioReadModels,
  VariantCatalog,
} from "../src/read-studio.js";
import { auth } from "./helpers.js";
import { adminToken, memberToken, studioHarness } from "./studio-fixtures.js";

/**
 * The last eight Studio endpoints.
 *
 * The property under test throughout is the one this project keeps
 * re-deriving: an endpoint with no data source REFUSES, and never answers an
 * empty list. So the assertions are mostly about which failure mode is
 * returned — 503 with a named capability rather than 200 with `[]` — and about
 * the two access rules that guard the auditor surfaces.
 */

const VARIANT = {
  variantId: "analyst-web",
  role: "analyst" as const,
  platform: "web",
  model: "claude-opus-5",
  activeVersion: 7,
  knowledgeFiles: 2,
  evalScore: 94,
};

function fakeVariants(): VariantCatalog {
  return {
    list: () => Promise.resolve([VARIANT, { ...VARIANT, variantId: "intake-default", evalScore: null }]),
    get: (variantId) =>
      Promise.resolve(
        variantId === "analyst-web"
          ? {
              variantId: VARIANT.variantId,
              role: VARIANT.role,
              platform: VARIANT.platform,
              model: VARIANT.model,
              activeVersion: VARIANT.activeVersion,
              persona: "persona metni saklanmıyor",
              knowledge: [
                { docId: "bddk-uyum.md", fileName: "bddk-uyum.md", category: "md", version: 7 },
              ],
              versions: [
                {
                  version: 7,
                  publishedAt: "2026-08-01T10:00:00.000Z",
                  publishedBy: "unrecorded",
                  note: "unrecorded",
                  evalScore: 94,
                },
              ],
            }
          : null,
      ),
  };
}

function fakePii(overrides: Record<string, unknown> = {}): PiiReader {
  return {
    stats: () =>
      Promise.resolve({
        summary: {
          maskedCalls: 3,
          totalCalls: 5,
          maskedFields: 9,
          exemptVariants: [],
          onPremCalls: 1,
          archiveMasked: true,
          ...overrides,
        },
        rules: [
          { ruleId: "pii.tckn", kind: "regex", matcher: "tckn", strategy: "hash", hits: 4 },
        ],
      }) as ReturnType<PiiReader["stats"]>,
  };
}

function fakeDecisions(chainVerified = true): DecisionReader {
  return {
    list: () =>
      Promise.resolve({
        items: [
          {
            decisionId: "audit-12",
            ref: "GATE_APPROVE",
            question: "UGURPAY-123",
            action: "GATE_APPROVE",
            actor: "ayse.kaya@bank",
            severity: "info",
            status: "approved",
            decidedAt: "2026-08-01T10:00:00.000Z",
            basis: { auditSeq: 12, chainVerified },
          },
        ],
        nextCursor: null,
      }),
  };
}

const wired = (studio: StudioReadModels) => studioHarness({ deps: { studio } });

describe("GET /variants", () => {
  it("refuses an unauthenticated caller", async () => {
    const h = await wired({ variants: fakeVariants() });
    expect((await h.app.inject({ method: "GET", url: "/variants" })).statusCode).toBe(401);
  });

  it("returns the catalogue to any session", async () => {
    const h = await wired({ variants: fakeVariants() });
    const token = await memberToken(h);

    const response = await h.app.inject({ method: "GET", url: "/variants", headers: auth(token) });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { variants: { variantId: string; evalScore: number | null }[] };
    expect(body.variants).toHaveLength(2);
    expect(body.variants[0]?.variantId).toBe("analyst-web");
  });

  it("keeps 'never evaluated' as null rather than collapsing it to zero", async () => {
    const h = await wired({ variants: fakeVariants() });
    const token = await memberToken(h);

    const response = await h.app.inject({ method: "GET", url: "/variants", headers: auth(token) });
    const body = response.json() as { variants: { evalScore: number | null }[] };

    // A variant nobody has scored is not a variant that scored zero, and the
    // screen renders the two differently.
    expect(body.variants[1]?.evalScore).toBeNull();
  });

  it("REFUSES with a named capability when no catalog is wired — never an empty list", async () => {
    const h = await wired({});
    const token = await memberToken(h);

    const response = await h.app.inject({ method: "GET", url: "/variants", headers: auth(token) });

    expect(response.statusCode).toBe(503);
    const body = response.json() as { error: string; details: { capability: string } };
    expect(body.error).toBe("capability_not_wired");
    expect(body.details.capability).toBe("variants");
    expect(response.body).not.toContain('"variants":[]');
  });

  it("404s an unknown variant and 400s a malformed id", async () => {
    const h = await wired({ variants: fakeVariants() });
    const token = await memberToken(h);

    const missing = await h.app.inject({
      method: "GET",
      url: "/variants/yok-boyle-bir-varyant",
      headers: auth(token),
    });
    expect(missing.statusCode).toBe(404);

    const malformed = await h.app.inject({
      method: "GET",
      url: "/variants/NOT_A_VARIANT_ID",
      headers: auth(token),
    });
    expect(malformed.statusCode).toBe(400);
  });

  it("returns the detail a variant screen needs", async () => {
    const h = await wired({ variants: fakeVariants() });
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/variants/analyst-web",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { versions: unknown[]; knowledge: unknown[] };
    expect(body.versions).toHaveLength(1);
    expect(body.knowledge).toHaveLength(1);
  });
});

describe("GET /pii", () => {
  it("is refused to a session without an audit role", async () => {
    const h = await wired({ pii: fakePii() });
    const token = await memberToken(h);

    const response = await h.app.inject({ method: "GET", url: "/pii", headers: auth(token) });

    expect(response.statusCode).toBe(403);
  });

  it("returns counts and rules to an admin", async () => {
    const h = await wired({ pii: fakePii() });
    const token = await adminToken(h);

    const response = await h.app.inject({ method: "GET", url: "/pii", headers: auth(token) });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { summary: { maskedCalls: number }; rules: unknown[] };
    expect(body.summary.maskedCalls).toBe(3);
    expect(body.rules).toHaveLength(1);
  });

  it("NEVER emits a masked value: an extra field from the store is refused, not forwarded", async () => {
    // The v1 audit finding was an unmasked "second copy" kept for display. A
    // store that starts returning one must break this endpoint rather than
    // pass it through, so the output schema is strict at every level.
    const leaky: PiiReader = {
      stats: () =>
        Promise.resolve({
          summary: {
            maskedCalls: 1,
            totalCalls: 1,
            maskedFields: 1,
            exemptVariants: [],
            onPremCalls: 0,
            archiveMasked: true,
            sampleValue: "12345678901",
          },
          rules: [],
        }) as ReturnType<PiiReader["stats"]>,
    };
    const h = await wired({ pii: leaky });
    const token = await adminToken(h);

    const response = await h.app.inject({ method: "GET", url: "/pii", headers: auth(token) });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("12345678901");
  });

  it("refuses by name when no reader is wired", async () => {
    const h = await wired({});
    const token = await adminToken(h);

    const response = await h.app.inject({ method: "GET", url: "/pii", headers: auth(token) });

    expect(response.statusCode).toBe(503);
    expect((response.json() as { details: { capability: string } }).details.capability).toBe("pii");
  });
});

describe("GET /decisions", () => {
  it("is refused to a session without an audit role", async () => {
    const h = await wired({ decisions: fakeDecisions() });
    const token = await memberToken(h);

    expect(
      (await h.app.inject({ method: "GET", url: "/decisions", headers: auth(token) })).statusCode,
    ).toBe(403);
  });

  it("shows what each row is based on rather than asserting it was verified", async () => {
    const h = await wired({ decisions: fakeDecisions() });
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/decisions",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      decisions: { basis: { auditSeq: number; chainVerified: boolean } }[];
      chainVerified: boolean;
    };
    // The seq is what an auditor re-reads the chain with; without it
    // "verified" would be a claim rather than evidence.
    expect(body.decisions[0]?.basis.auditSeq).toBe(12);
    expect(body.chainVerified).toBe(true);
  });

  it("does not claim a verified chain when the rows say otherwise", async () => {
    const h = await wired({ decisions: fakeDecisions(false) });
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/decisions",
      headers: auth(token),
    });

    expect((response.json() as { chainVerified: boolean }).chainVerified).toBe(false);
  });

  it("bounds the page size", async () => {
    const h = await wired({ decisions: fakeDecisions() });
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/decisions?limit=9999",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("the endpoints that refuse when their store is not wired", () => {
  it.each([
    // `/eval` refuses when ITS store is absent (it is now wireable — see
    // studio-eval.test.ts for the wired path). `/greenfield` and `/cache` have
    // no producer at all.
    ["/eval", "eval"],
    ["/greenfield?ticket=UGURPAY-123", "greenfield"],
    ["/cache", "cache"],
  ])("%s refuses by name instead of answering an empty page", async (url, capability) => {
    const h = await wired({});
    const token = await adminToken(h);

    const response = await h.app.inject({ method: "GET", url, headers: auth(token) });

    expect(response.statusCode).toBe(503);
    const body = response.json() as { error: string; details: { capability: string; missing: string } };
    expect(body.error).toBe("capability_not_wired");
    expect(body.details.capability).toBe(capability);
    // The refusal has to say what is missing, because the operator's next
    // question is "what do I install to fix this".
    expect(body.details.missing.length).toBeGreaterThan(40);
  });

  it("keeps /eval refused when the OTHER studio stores are wired but eval is not", async () => {
    const h = await wired({ variants: fakeVariants(), pii: fakePii(), decisions: fakeDecisions() });
    const token = await adminToken(h);

    // eval is wired independently of variants/pii/decisions — wiring those does
    // not turn it on.
    expect((await h.app.inject({ method: "GET", url: "/eval", headers: auth(token) })).statusCode).toBe(503);
  });

  it("400s a malformed greenfield ticket rather than hiding a client bug behind a 503", async () => {
    const h = await wired({});
    const token = await adminToken(h);

    const response = await h.app.inject({ method: "GET", url: "/greenfield", headers: auth(token) });

    expect(response.statusCode).toBe(400);
  });

  it("requires a session", async () => {
    const h = await wired({});
    expect((await h.app.inject({ method: "GET", url: "/eval" })).statusCode).toBe(401);
  });
});

describe("GET /commands", () => {
  it("lists every command the parser accepts, and no other", async () => {
    const h = await wired({});
    const token = await memberToken(h);

    const response = await h.app.inject({ method: "GET", url: "/commands", headers: auth(token) });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { commands: { name: string; takesArgument: boolean }[] };
    const names = body.commands.map((command) => command.name);
    // The contract enum is the source; a screen listing a command the parser
    // would refuse is documentation of something that does not exist.
    expect(names).toEqual([
      "/approve",
      "/reject",
      "/status",
      "/ai-explain",
      "/ai-start",
      "/ai-assign",
      "/mode-change",
      "/ai-takeover",
    ]);
  });

  it("marks exactly the commands whose parser takes an argument", async () => {
    const h = await wired({});
    const token = await memberToken(h);

    const response = await h.app.inject({ method: "GET", url: "/commands", headers: auth(token) });
    const body = response.json() as { commands: { name: string; takesArgument: boolean }[] };
    const withArgument = body.commands.filter((c) => c.takesArgument).map((c) => c.name);

    // For a no-argument command the whole comment must BE the command, or
    // "/approve etmiyorum" would read as consent. Getting this list wrong on
    // screen would document that rule backwards.
    expect(withArgument.sort()).toEqual(["/ai-assign", "/mode-change", "/reject"]);
  });

  it("sends catalog keys, never prose", async () => {
    const h = await wired({});
    const token = await memberToken(h);

    const response = await h.app.inject({ method: "GET", url: "/commands", headers: auth(token) });
    const body = response.json() as { commands: { whenKey: string; effectKey: string }[] };

    for (const command of body.commands) {
      expect(command.whenKey).toMatch(/^commands\.when\./);
      expect(command.effectKey).toMatch(/^commands\.effect\./);
    }
  });
});

describe("GET /mcp/manifest", () => {
  it("is derived from the real server definition", async () => {
    const h = await wired({});
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/mcp/manifest",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      tools: { name: string; scope: string; descriptionKey: string }[];
      forbiddenTools: string[];
    };
    const names = body.tools.map((tool) => tool.name);
    expect(names).toContain("list_pending_gates");
    expect(names).toContain("propose_param_change");
  });

  it("shows the gate-decision boundary as ABSENT tools rather than implying one", async () => {
    const h = await wired({});
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/mcp/manifest",
      headers: auth(token),
    });
    const body = response.json() as { tools: { name: string }[]; forbiddenTools: string[] };

    // An operator who cannot see the boundary assumes there isn't one (M32).
    expect(body.forbiddenTools).toEqual(["approve_gate", "reject_gate", "merge_pr"]);
    for (const forbidden of body.forbiddenTools) {
      expect(body.tools.map((tool) => tool.name)).not.toContain(forbidden);
    }
  });

  it("carries a scope for every tool, and only the three that exist", async () => {
    const h = await wired({});
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/mcp/manifest",
      headers: auth(token),
    });
    const body = response.json() as { tools: { scope: string }[] };

    // The effective permission is the caller's RBAC ∩ the tool's scope, so a
    // tool without one would be a tool nobody can reason about.
    expect(body.tools.length).toBeGreaterThan(0);
    for (const tool of body.tools) {
      expect(["read", "operate", "admin-proposal"]).toContain(tool.scope);
    }
  });

  it("requires a session", async () => {
    const h = await wired({});
    expect((await h.app.inject({ method: "GET", url: "/mcp/manifest" })).statusCode).toBe(401);
  });
});
