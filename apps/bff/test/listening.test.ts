import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { auth, harness, type Harness } from "./helpers.js";

/**
 * The listening-rules surface: which tickets Maestro picks up and how it runs
 * them (status/issuetype → flow type), made admin-editable.
 *
 * The behaviours under test are the ones a rule editor must get right: writes
 * are admin-only, reads are admin + tech-lead, the closed domains
 * (matchKind/flowType) are enforced as 400s not 500s, a duplicate trigger is a
 * clean rejection, and every write is audited.
 */

async function admin(h: Harness): Promise<string> {
  await h.addUser({ username: "ayse.kaya", roles: ["admin"] });
  return h.login("ayse.kaya");
}
async function techLead(h: Harness): Promise<string> {
  await h.addUser({ username: "mehmet.demir", roles: ["tech-lead"] });
  return h.login("mehmet.demir");
}
async function viewer(h: Harness): Promise<string> {
  await h.addUser({ username: "can.yilmaz", roles: ["developer"] });
  return h.login("can.yilmaz");
}

function get(h: Harness, url: string, token: string): Promise<LightMyRequestResponse> {
  return h.app.inject({ method: "GET", url, headers: auth(token) });
}
function post(h: Harness, url: string, token: string, payload?: object): Promise<LightMyRequestResponse> {
  return h.app.inject({ method: "POST", url, headers: auth(token), ...(payload ? { payload } : {}) });
}
function put(h: Harness, url: string, token: string, payload: object): Promise<LightMyRequestResponse> {
  return h.app.inject({ method: "PUT", url, headers: auth(token), payload });
}
function del(h: Harness, url: string, token: string): Promise<LightMyRequestResponse> {
  return h.app.inject({ method: "DELETE", url, headers: auth(token) });
}

const RULE = {
  projectKey: "OPS",
  assigneeAccountId: "712020:bot",
  matchKind: "issuetype",
  matchValue: "Hata",
  flowType: "duzeltme",
  priority: 100,
  enabled: true,
} as const;

describe("POST /studio/listening-rules", () => {
  it("creates a rule and assigns it an id", async () => {
    const h = await harness();
    const token = await admin(h);

    const res = await post(h, "/studio/listening-rules", token, RULE);
    expect(res.statusCode).toBe(201);
    const { rule } = res.json() as { rule: { ruleId: string; flowType: string } };
    expect(rule.ruleId).toMatch(/^lr_/);
    expect(rule.flowType).toBe("duzeltme");

    // It really landed in the store.
    const stored = await h.listening.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.matchValue).toBe("Hata");
  });

  it("rejects an unknown flowType as a 400 (closed domain), never a 500", async () => {
    const h = await harness();
    const token = await admin(h);
    const res = await post(h, "/studio/listening-rules", token, { ...RULE, flowType: "silme" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an unknown matchKind as a 400", async () => {
    const h = await harness();
    const token = await admin(h);
    const res = await post(h, "/studio/listening-rules", token, { ...RULE, matchKind: "component" });
    expect(res.statusCode).toBe(400);
  });

  it("rejects a duplicate trigger with a 400 (unique index → clean rejection)", async () => {
    const h = await harness();
    const token = await admin(h);
    expect((await post(h, "/studio/listening-rules", token, RULE)).statusCode).toBe(201);
    // Same (project, assignee, matchKind, matchValue) — a second rule for one trigger.
    const dup = await post(h, "/studio/listening-rules", token, { ...RULE, flowType: "analiz" });
    expect(dup.statusCode).toBe(400);
    expect(await h.listening.list()).toHaveLength(1);
  });

  it("round-trips the agent-variant choice: create with variants → GET returns them", async () => {
    const h = await harness();
    const token = await admin(h);

    const res = await post(h, "/studio/listening-rules", token, {
      ...RULE,
      analystVariantId: "analyst-node-v2",
      engineerVariantId: "engineer-dotnet-v1",
    });
    expect(res.statusCode).toBe(201);
    const { rule } = res.json() as { rule: { analystVariantId: string | null; engineerVariantId: string | null } };
    expect(rule.analystVariantId).toBe("analyst-node-v2");
    expect(rule.engineerVariantId).toBe("engineer-dotnet-v1");

    const listed = await get(h, "/studio/listening-rules", token);
    const { rules } = listed.json() as {
      rules: { analystVariantId: string | null; engineerVariantId: string | null }[];
    };
    expect(rules[0]!.analystVariantId).toBe("analyst-node-v2");
    expect(rules[0]!.engineerVariantId).toBe("engineer-dotnet-v1");
  });

  it("normalises an absent or empty agent choice to null (default agent)", async () => {
    const h = await harness();
    const token = await admin(h);

    // Absent fields → null.
    const bare = await post(h, "/studio/listening-rules", token, RULE);
    expect(bare.statusCode).toBe(201);
    const created = (bare.json() as { rule: { analystVariantId: string | null; engineerVariantId: string | null } }).rule;
    expect(created.analystVariantId).toBeNull();
    expect(created.engineerVariantId).toBeNull();

    // Empty strings (a Select's "default" option) → null too, never "".
    const empty = await post(h, "/studio/listening-rules", token, {
      ...RULE,
      matchValue: "Hikaye",
      analystVariantId: "",
      engineerVariantId: "",
    });
    expect(empty.statusCode).toBe(201);
    const rule2 = (empty.json() as { rule: { analystVariantId: string | null; engineerVariantId: string | null } }).rule;
    expect(rule2.analystVariantId).toBeNull();
    expect(rule2.engineerVariantId).toBeNull();
  });

  it("is admin-only — a tech-lead cannot create a rule", async () => {
    const h = await harness();
    const token = await techLead(h);
    const res = await post(h, "/studio/listening-rules", token, RULE);
    expect(res.statusCode).toBe(403);
  });

  it("records an audit row on create", async () => {
    const h = await harness();
    const token = await admin(h);
    await post(h, "/studio/listening-rules", token, RULE);
    const events = await h.auditStore.read();
    expect(events.some((e) => e.subject.startsWith("listening-rule:"))).toBe(true);
  });
});

describe("the Jira status map on a listening rule", () => {
  /**
   * The optional durum eşlemesi. The whole design rests on presence: NO map is
   * comment-only mode (Maestro narrates and never touches the board — what every
   * rule did before this landed), a map opts that ONE rule into moving tickets.
   * These tests hold both halves of that, plus the reason the schema is strict.
   */
  const FULL_MAP = {
    onStart: "Devam Ediyor",
    onNeedInfo: "Yapılacaklar",
    onReview: "İNCELEMEDE",
    onRejected: "Devam Ediyor",
    onDone: "Tamam",
    reassignOnNeedInfo: true,
  } as const;

  it("creates a rule carrying the full map and reads it back", async () => {
    const h = await harness();
    const token = await admin(h);

    const res = await post(h, "/studio/listening-rules", token, { ...RULE, statusMap: FULL_MAP });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { rule: { statusMap: unknown } }).rule.statusMap).toEqual(FULL_MAP);
    expect((await h.listening.get((res.json() as { rule: { ruleId: string } }).rule.ruleId))?.statusMap).toEqual(FULL_MAP);
  });

  it("accepts a PARTIAL map — an operator maps only the points they care about", async () => {
    const h = await harness();
    const token = await admin(h);
    const res = await post(h, "/studio/listening-rules", token, {
      ...RULE,
      statusMap: { onDone: "Tamam" },
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as { rule: { statusMap: unknown } }).rule.statusMap).toEqual({ onDone: "Tamam" });
  });

  it("an absent or empty map is null — comment-only mode stays the default", async () => {
    const h = await harness();
    const token = await admin(h);

    const bare = await post(h, "/studio/listening-rules", token, RULE);
    expect(bare.statusCode).toBe(201);
    expect((bare.json() as { rule: { statusMap: unknown } }).rule.statusMap).toBeNull();

    // An editor that submits an untouched form must not look like a configured
    // map: `{}` moves nothing, so it stores as the same NULL as "no map".
    const empty = await post(h, "/studio/listening-rules", token, {
      ...RULE,
      matchValue: "Hikaye",
      statusMap: {},
    });
    expect(empty.statusCode).toBe(201);
    expect((empty.json() as { rule: { statusMap: unknown } }).rule.statusMap).toBeNull();
  });

  it("rejects a malformed map with a 400, never a 500 or a silent drop", async () => {
    const h = await harness();
    const token = await admin(h);
    const malformed = [
      // A misspelt key. Dropping it silently is the worst outcome: the operator
      // watches tickets never reach 'Tamam' with nothing on screen to explain it.
      { onDoneX: "Tamam" },
      { onDone: 42 }, // a non-string value
      { onStart: "" }, // an empty status name names no status
      { reassignOnNeedInfo: "evet" }, // a string where the flag belongs
      { onDone: ["Tamam"] },
      "Tamam", // not an object at all
    ];
    for (const statusMap of malformed) {
      const res = await post(h, "/studio/listening-rules", token, { ...RULE, statusMap });
      expect(res.statusCode, JSON.stringify(statusMap)).toBe(400);
    }
    expect(await h.listening.list()).toHaveLength(0);
  });

  it("a PUT replaces the map along with the rest of the rule, and can clear it", async () => {
    const h = await harness({ listeningRules: [{ ruleId: "lr_seed", ...RULE }] });
    const token = await admin(h);

    const set = await put(h, "/studio/listening-rules/lr_seed", token, { ...RULE, statusMap: FULL_MAP });
    expect(set.statusCode).toBe(200);
    expect((await h.listening.get("lr_seed"))?.statusMap).toEqual(FULL_MAP);

    // Back to comment-only: dropping the field is how an operator turns board
    // driving OFF again, and it must actually clear the stored map.
    const cleared = await put(h, "/studio/listening-rules/lr_seed", token, RULE);
    expect(cleared.statusCode).toBe(200);
    expect((await h.listening.get("lr_seed"))?.statusMap).toBeNull();
  });

  it("a malformed map on PUT leaves the stored rule untouched", async () => {
    const h = await harness({ listeningRules: [{ ruleId: "lr_seed", ...RULE, statusMap: { onDone: "Tamam" } }] });
    const token = await admin(h);
    const res = await put(h, "/studio/listening-rules/lr_seed", token, {
      ...RULE,
      statusMap: { onDone: "Tamam", onWhatever: "Bir Şey" },
    });
    expect(res.statusCode).toBe(400);
    expect((await h.listening.get("lr_seed"))?.statusMap).toEqual({ onDone: "Tamam" });
  });
});

describe("GET /studio/listening-rules", () => {
  it("lists rules for admin and tech-lead", async () => {
    const h = await harness({
      listeningRules: [{ ruleId: "lr_seed", ...RULE }],
    });
    for (const token of [await admin(h), await techLead(h)]) {
      const res = await get(h, "/studio/listening-rules", token);
      expect(res.statusCode).toBe(200);
      expect((res.json() as { rules: unknown[] }).rules).toHaveLength(1);
    }
  });

  it("refuses a viewer", async () => {
    const h = await harness();
    const token = await viewer(h);
    expect((await get(h, "/studio/listening-rules", token)).statusCode).toBe(403);
  });
});

describe("PUT/DELETE /studio/listening-rules/:ruleId", () => {
  it("replaces a rule", async () => {
    const h = await harness({ listeningRules: [{ ruleId: "lr_seed", ...RULE }] });
    const token = await admin(h);
    const res = await put(h, "/studio/listening-rules/lr_seed", token, {
      ...RULE,
      matchValue: "Hikaye",
      flowType: "gelistirme",
      engineerVariantId: "engineer-node-v3",
    });
    expect(res.statusCode).toBe(200);
    const stored = await h.listening.get("lr_seed");
    expect(stored?.flowType).toBe("gelistirme");
    expect(stored?.matchValue).toBe("Hikaye");
    // The agent choice replaces along with the rest of the rule.
    expect(stored?.engineerVariantId).toBe("engineer-node-v3");
    expect(stored?.analystVariantId).toBeNull();
  });

  it("404s a PUT to an unknown rule", async () => {
    const h = await harness();
    const token = await admin(h);
    expect((await put(h, "/studio/listening-rules/lr_missing", token, RULE)).statusCode).toBe(404);
  });

  it("deletes a rule", async () => {
    const h = await harness({ listeningRules: [{ ruleId: "lr_seed", ...RULE }] });
    const token = await admin(h);
    expect((await del(h, "/studio/listening-rules/lr_seed", token)).statusCode).toBe(204);
    expect(await h.listening.list()).toHaveLength(0);
  });

  it("404s a DELETE of an unknown rule", async () => {
    const h = await harness();
    const token = await admin(h);
    expect((await del(h, "/studio/listening-rules/lr_missing", token)).statusCode).toBe(404);
  });
});

/**
 * "Bota atanan her ticket" — `matchKind: "assigned"` (migration 0020).
 *
 * The route's half of the round trip. `matchValue` is still required by the
 * schema (the column is NOT NULL) but is meaningless for this kind, so the
 * server PINS it: whatever a client sends, the row stores one literal. That is
 * not tidiness — it is what makes "at most one catch-all per (project, bot)" a
 * database guarantee via the unique trigger index, enforced against a
 * hand-rolled curl and not just against the Studio form.
 */
describe("a rule on the assignment alone", () => {
  const ANY = { ...RULE, matchKind: "assigned", matchValue: "*" } as const;

  it("accepts the third kind and stores it", async () => {
    const h = await harness();
    const token = await admin(h);

    const res = await post(h, "/studio/listening-rules", token, ANY);
    expect(res.statusCode).toBe(201);

    const stored = await h.listening.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.matchKind).toBe("assigned");
    expect(stored[0]!.matchValue).toBe("*");
  });

  it("pins matchValue whatever the client sent, so the unique index can bite", async () => {
    const h = await harness();
    const token = await admin(h);

    // Two clients, two different meaningless values for the SAME catch-all.
    expect((await post(h, "/studio/listening-rules", token, { ...ANY, matchValue: "her sey" })).statusCode).toBe(201);
    const second = await post(h, "/studio/listening-rules", token, { ...ANY, matchValue: "anything" });

    // Without the pin these would be two distinct triggers in the index and the
    // project would quietly hold two catch-alls, both matching every ticket.
    expect(second.statusCode).toBe(400);
    expect(second.json().error).toBe("duplicate_listening_rule");
    const stored = await h.listening.list();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.matchValue).toBe("*");
  });

  it("pins it on replace too, not only on create", async () => {
    const h = await harness();
    const token = await admin(h);
    const created = await post(h, "/studio/listening-rules", token, ANY);
    const ruleId = created.json().rule.ruleId as string;

    const res = await put(h, `/studio/listening-rules/${ruleId}`, token, {
      ...ANY,
      matchValue: "bir sey",
      flowType: "analiz",
    });
    expect(res.statusCode).toBe(200);

    const stored = await h.listening.list();
    expect(stored[0]!.matchValue).toBe("*");
    expect(stored[0]!.flowType).toBe("analiz");
  });

  it("leaves the conditioned kinds' values exactly as sent", async () => {
    const h = await harness();
    const token = await admin(h);
    // The one thing the pin must never touch. `Görev` is what OPS-66 carries;
    // a server that "helpfully" rewrote a matchValue would recreate today's bug.
    await post(h, "/studio/listening-rules", token, { ...RULE, matchValue: "Görev" });
    expect((await h.listening.list())[0]!.matchValue).toBe("Görev");
  });
});

describe("listening surface unwired", () => {
  it("refuses by name (503) when no ListeningStore is wired", async () => {
    const h = await harness({ deps: { listening: undefined } });
    const token = await admin(h);
    const res = await get(h, "/studio/listening-rules", token);
    expect(res.statusCode).toBe(503);
  });
});

/**
 * "Şimdi tara" — the button behind the rules screen.
 *
 * Asked for after a sweep that was configured, healthy and taking nothing:
 * "tarama ok ama yine de panele gelmiyor, daha test butonu yok mu?". Writing a
 * rule and waiting out the interval is not a test, and reading the container
 * log needs a shell the rule author may not have. These pin the two things
 * that make the button trustworthy: it STARTS runs (so it is admin-only), and
 * it says honestly when there is no sweep to run.
 */
describe("POST /studio/listening-sweep", () => {
  it("runs one sweep and answers with what it took", async () => {
    const h = await harness({
      deps: { discoveryRun: () => Promise.resolve(["OPS-42", "OPS-43"]) },
    });
    const token = await admin(h);

    const res = await h.app.inject({
      method: "POST",
      url: "/studio/listening-sweep",
      headers: auth(token),
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ started: string[] }>().started).toEqual(["OPS-42", "OPS-43"]);
  });

  it("says an empty round is empty rather than reporting a failure", async () => {
    const h = await harness({ deps: { discoveryRun: () => Promise.resolve([]) } });
    const token = await admin(h);

    const res = await h.app.inject({
      method: "POST",
      url: "/studio/listening-sweep",
      headers: auth(token),
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ started: string[] }>().started).toEqual([]);
  });

  /**
   * A sweep that throws is an answer the operator needs to READ — the usual
   * cause is Jira refusing the search — not a 500 with a stack trace.
   */
  it("reports a failed sweep as a readable reason, not a 500", async () => {
    const h = await harness({
      deps: { discoveryRun: () => Promise.reject(new Error("jira 403")) },
    });
    const token = await admin(h);

    const res = await h.app.inject({
      method: "POST",
      url: "/studio/listening-sweep",
      headers: auth(token),
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.json<{ error?: string }>().error).toContain("jira 403");
  });

  /**
   * A webhook-only install runs no sweep at all. "Nothing happened" and "there
   * is nothing to run" need different answers, and the second one has to say
   * WHICH setting is missing — that is the whole reason this button exists.
   */
  it("answers 503 with the missing setting when no sweep is configured", async () => {
    const h = await harness();
    const token = await admin(h);

    const res = await h.app.inject({
      method: "POST",
      url: "/studio/listening-sweep",
      headers: auth(token),
      payload: {},
    });

    expect(res.statusCode).toBe(503);
    expect(res.json<{ message: string }>().message).toContain("JIRA_DISCOVER_MS");
  });

  /**
   * "Not asked for" and "this driver cannot search" send a person to two
   * different places: the `.env` file, or the connection screen. One generic
   * message sends them to the wrong one half the time — and the customer hit
   * exactly this, on an install where the work driver had no search at all.
   */
  it("says WHICH absence it is when the driver cannot search", async () => {
    const h = await harness({
      deps: {
        sweepUnavailableReason: () =>
          "Bu kurulumun iş sürücüsü ticket araması sunmuyor, bu yüzden tarama çalışamaz.",
      },
    });
    const token = await admin(h);

    const res = await h.app.inject({
      method: "POST",
      url: "/studio/listening-sweep",
      headers: auth(token),
      payload: {},
    });

    expect(res.statusCode).toBe(503);
    const message = res.json<{ message: string }>().message;
    expect(message).toContain("arama");
    // NOT the "go and set JIRA_DISCOVER_MS" advice, which would be wrong here.
    expect(message).not.toContain("JIRA_DISCOVER_MS");
  });

  /** It starts runs, so it is a WRITE: same gate as creating a rule. */
  it("refuses a tech-lead, who may read rules but not write them", async () => {
    const h = await harness({ deps: { discoveryRun: () => Promise.resolve([]) } });
    const token = await techLead(h);

    const res = await h.app.inject({
      method: "POST",
      url: "/studio/listening-sweep",
      headers: auth(token),
      payload: {},
    });

    expect(res.statusCode).toBe(403);
  });

  it("refuses an unauthenticated caller", async () => {
    const h = await harness({ deps: { discoveryRun: () => Promise.resolve([]) } });

    const res = await h.app.inject({
      method: "POST",
      url: "/studio/listening-sweep",
      payload: {},
    });

    expect(res.statusCode).toBe(401);
  });
});
