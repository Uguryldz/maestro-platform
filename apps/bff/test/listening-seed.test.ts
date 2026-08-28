import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import type { OnboardingOptionsRecord } from "../src/onboarding-models.js";
import { seedDefaultRules } from "../src/listening-seed.js";
import type { ListeningRuleRecord } from "../src/listening-store.js";
import { InMemoryListeningStore } from "../src/stores/listening-memory.js";
import { auth, harness, type Harness, type HarnessOptions } from "./helpers.js";

/**
 * The "works out of the box" seed: connecting a Jira project auto-creates the
 * default listening rules (one `issuetype` rule per non-subtask type; bug-like
 * types → duzeltme, everything else → analiz, NEVER gelistirme), idempotently.
 *
 * Three surfaces under test: the pure seed (mapping + idempotency), the manual
 * endpoint (Jira read, store write, pilot mirror, honest fallbacks), and the
 * onboarding approve hook (seed runs automatically, and its failure can never
 * break an approval).
 */

const BOT = "712020:bot";

// ── seedDefaultRules (unit) ───────────────────────────────────────────────────

describe("seedDefaultRules", () => {
  it("maps bug-like types to duzeltme(50) and everything else to analiz(100) — never gelistirme", async () => {
    const store = new InMemoryListeningStore();
    const result = await seedDefaultRules(store, "OPS", BOT, [
      { name: "Bug" },
      { name: "HATA" },
      { name: "defect" },
      { name: "Arıza" },
      { name: "Görev" },
      { name: "Hikaye" },
    ]);

    expect(result.created).toBe(6);
    expect(result.skipped).toBe(0);
    const rules = await store.list();
    const byValue = new Map(rules.map((rule) => [rule.matchValue, rule]));
    for (const bugLike of ["Bug", "HATA", "defect", "Arıza"]) {
      expect(byValue.get(bugLike)?.flowType).toBe("duzeltme");
      expect(byValue.get(bugLike)?.priority).toBe(50);
    }
    for (const other of ["Görev", "Hikaye"]) {
      expect(byValue.get(other)?.flowType).toBe("analiz");
      expect(byValue.get(other)?.priority).toBe(100);
    }
    // gelistirme is a human decision, never a seeded default.
    expect(rules.some((rule) => rule.flowType === "gelistirme")).toBe(false);
    // Every seeded rule is enabled, issuetype-matched, bot-assigned, default-agent.
    for (const rule of rules) {
      expect(rule.enabled).toBe(true);
      expect(rule.matchKind).toBe("issuetype");
      expect(rule.assigneeAccountId).toBe(BOT);
      expect(rule.analystVariantId).toBeNull();
      expect(rule.engineerVariantId).toBeNull();
    }
  });

  it("excludes subtask types", async () => {
    const store = new InMemoryListeningStore();
    const result = await seedDefaultRules(store, "OPS", BOT, [
      { name: "Görev", subtask: false },
      { name: "Alt görev", subtask: true },
    ]);
    expect(result.created).toBe(1);
    expect((await store.list()).map((rule) => rule.matchValue)).toEqual(["Görev"]);
  });

  it("is idempotent: an existing trigger is skipped and a hand-edited flow type survives", async () => {
    // The admin changed the seeded "Hata" rule to gelistirme on purpose.
    const edited: ListeningRuleRecord = {
      ruleId: "lr_edited",
      projectKey: "OPS",
      assigneeAccountId: BOT,
      matchKind: "issuetype",
      matchValue: "Hata",
      flowType: "gelistirme",
      priority: 10,
      enabled: true,
    };
    const store = new InMemoryListeningStore([edited]);

    const result = await seedDefaultRules(store, "OPS", BOT, [{ name: "Hata" }, { name: "Görev" }]);
    expect(result).toMatchObject({ created: 1, skipped: 1 });
    expect(result.rules.map((rule) => rule.matchValue)).toEqual(["Görev"]);

    // The edit is untouched.
    expect((await store.get("lr_edited"))?.flowType).toBe("gelistirme");

    // A full re-run creates nothing more.
    const again = await seedDefaultRules(store, "OPS", BOT, [{ name: "Hata" }, { name: "Görev" }]);
    expect(again).toMatchObject({ created: 0, skipped: 2 });
  });
});

// ── the endpoint ──────────────────────────────────────────────────────────────

/** A tested Jira connection: it knows the bot account and holds a token ref. */
const JIRA_CONN = {
  id: "jira",
  kind: "jira_cloud" as const,
  displayName: "Jira Cloud",
  baseUrl: "https://ugurbank.atlassian.net",
  authKind: "basic" as const,
  config: { email: "bot@ugurbank.local", botAccountId: BOT },
  secretRef: "connector:jira:1",
  secretMask: "z789",
  enabled: true,
  createdAt: "2026-08-13T00:00:00.000Z",
  updatedAt: "2026-08-13T00:00:00.000Z",
  lastTestedAt: null,
  lastTestOk: null,
  lastTestNote: null,
  onPrem: false,
  isDefault: false,
};

/** GET /project/{key}/statuses — issue-type groups with the `subtask` flag. */
const STATUSES_PAYLOAD = [
  { id: "1", name: "Görev", subtask: false, statuses: [] },
  { id: "2", name: "Hata", subtask: false, statuses: [] },
  { id: "3", name: "Alt görev", subtask: true, statuses: [] },
  { id: "4", name: "Hikaye", subtask: false, statuses: [] },
];

/** Harness with a seedable Jira read. */
async function seedHarness(options: HarnessOptions = {}): Promise<{ h: Harness }> {
  const h = await harness({
    managedConnections: [JIRA_CONN],
    connectorFetch: () => Promise.resolve(Response.json(STATUSES_PAYLOAD)),
    ...options,
  });
  await h.connectorSecrets.set("connector:jira:1", "jira_stored_token");
  return { h };
}

async function adminToken(h: Harness): Promise<string> {
  await h.addUser({ username: "ayse.kaya", roles: ["admin"], groups: ["maestro-admins"] });
  return h.login("ayse.kaya");
}

function seed(h: Harness, token: string, projectKey = "OPS"): Promise<LightMyRequestResponse> {
  return h.app.inject({
    method: "POST",
    url: "/studio/listening-rules/seed-defaults",
    headers: auth(token),
    payload: { projectKey },
  });
}

describe("POST /studio/listening-rules/seed-defaults", () => {
  it("seeds one rule per non-subtask issue type", async () => {
    const { h } = await seedHarness();
    const token = await adminToken(h);

    const res = await seed(h, token);
    expect(res.statusCode).toBe(200);
    const body = res.json() as { created: number; skipped: number; rules: ListeningRuleRecord[] };
    expect(body.created).toBe(3); // Alt görev (subtask) excluded
    expect(body.skipped).toBe(0);
    expect(body.rules.map((rule) => rule.matchValue).sort()).toEqual(["Görev", "Hata", "Hikaye"]);

    const stored = await h.listening.list();
    expect(stored).toHaveLength(3);
    expect(stored.find((rule) => rule.matchValue === "Hata")?.flowType).toBe("duzeltme");
    expect(stored.every((rule) => rule.assigneeAccountId === BOT)).toBe(true);

    // The seed is an audited write.
    const events = await h.auditStore.read();
    expect(events.some((event) => event.subject === "listening-rule:seed:OPS")).toBe(true);
  });

  it("is idempotent: a second call creates nothing and skips everything", async () => {
    const { h } = await seedHarness();
    const token = await adminToken(h);
    expect((await seed(h, token)).statusCode).toBe(200);

    const again = await seed(h, token);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ created: 0, skipped: 3 });
    expect(await h.listening.list()).toHaveLength(3);
  });

  it("falls back honestly when Jira's type list cannot be read: no rules, no invented names", async () => {
    const { h } = await seedHarness({
      connectorFetch: () => Promise.reject(new Error("boom")),
    });
    const token = await adminToken(h);

    const res = await seed(h, token);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      created: 0,
      skipped: 0,
      rules: [],
      reason: "issue_types_unavailable",
    });
    expect(await h.listening.list()).toHaveLength(0);
  });

  it("409s by name when no enabled Jira connection exists", async () => {
    const { h } = await seedHarness({ managedConnections: [] });
    const token = await adminToken(h);
    const res = await seed(h, token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("no_jira_connection");
  });

  it("409s by name when the connection knows no bot account (never a made-up assignee)", async () => {
    const { h } = await seedHarness({
      managedConnections: [{ ...JIRA_CONN, config: { email: "bot@ugurbank.local" } }],
    });
    const token = await adminToken(h);
    const res = await seed(h, token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("bot_account_unknown");
    expect(await h.listening.list()).toHaveLength(0);
  });

  it("refuses a developer", async () => {
    const { h } = await seedHarness();
    await h.addUser({ username: "dev", roles: ["developer"] });
    const token = await h.login("dev");
    expect((await seed(h, token)).statusCode).toBe(403);
  });

  it("refuses by name (503) when no ListeningStore is wired", async () => {
    const { h } = await seedHarness({ deps: { listening: undefined } });
    const token = await adminToken(h);
    expect((await seed(h, token)).statusCode).toBe(503);
  });
});

// ── onboarding approve → automatic seed ───────────────────────────────────────

const OPTIONS: OnboardingOptionsRecord = {
  projects: [{ projectKey: "NEWPROJ", state: null }],
  repos: [],
  platforms: ["linux-node"],
};

const DRAFT = {
  jiraProject: "NEWPROJ",
  adoRepo: "Uguryldz/maestro-pilot",
  platform: "linux-node",
  triggerMode: "opt_in",
  gateSet: "risk_tiered",
  mergeMode: "human",
} as const;

async function submitAndApprove(h: Harness): Promise<LightMyRequestResponse> {
  const token = await adminToken(h); // maestro-admins → master solo approval
  const submitted = await h.app.inject({
    method: "POST",
    url: "/onboarding",
    headers: auth(token),
    payload: DRAFT,
  });
  expect(submitted.statusCode).toBe(202);
  return h.app.inject({
    method: "POST",
    url: "/onboarding/approve",
    headers: auth(token),
    payload: { projectKey: "NEWPROJ" },
  });
}

describe("onboarding approve seeds the default listening rules", () => {
  it("a freshly approved project gets its rules automatically", async () => {
    const { h } = await seedHarness({ onboarding: OPTIONS });

    const res = await submitAndApprove(h);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "bound",
      projectKey: "NEWPROJ",
      listeningSeed: { created: 3, skipped: 0 },
    });

    const rules = await h.listening.list();
    expect(rules).toHaveLength(3);
    expect(rules.every((rule) => rule.projectKey === "NEWPROJ")).toBe(true);
    expect(rules.find((rule) => rule.matchValue === "Hata")?.flowType).toBe("duzeltme");
  });

  it("FAIL-SOFT: a seed that cannot run never breaks the approval", async () => {
    // Jira unreachable during the seed — the approve must still bind.
    const { h } = await seedHarness({
      onboarding: OPTIONS,
      connectorFetch: () => Promise.reject(new Error("jira down")),
    });

    const res = await submitAndApprove(h);
    expect(res.statusCode).toBe(200);
    // `listeningSeed: null` alone was the silent half-setup: "bound" looked
    // green while no ticket was listened to. The response now NAMES why the
    // seed did not run, so the screen can warn instead of celebrating.
    expect(res.json()).toMatchObject({
      status: "bound",
      projectKey: "NEWPROJ",
      listeningSeed: null,
      seedSkipped: { reason: "issue_types_unavailable" },
    });
    expect(await h.bindings.resolve("NEWPROJ")).not.toBeNull();
    expect(await h.listening.list()).toHaveLength(0);
  });

  it("FAIL-SOFT: no Jira connection at all — approve still succeeds, and says why nothing was seeded", async () => {
    const { h } = await seedHarness({ onboarding: OPTIONS, managedConnections: [] });

    const res = await submitAndApprove(h);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "bound",
      listeningSeed: null,
      seedSkipped: { reason: "no_jira_connection" },
    });
    expect(await h.bindings.resolve("NEWPROJ")).not.toBeNull();
  });

  it("FAIL-SOFT: an unexpected throw mid-seed still binds, reported as seed_error", async () => {
    // The store's write blows up — not one of the named "cannot seed" states,
    // so it reaches the approve route's catch. The binding must survive and the
    // response must still carry a reason rather than a bare null.
    const { h } = await seedHarness({ onboarding: OPTIONS });
    h.listening.put = () => Promise.reject(new Error("db down"));

    const res = await submitAndApprove(h);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "bound",
      listeningSeed: null,
      seedSkipped: { reason: "seed_error" },
    });
    expect(await h.bindings.resolve("NEWPROJ")).not.toBeNull();
  });

  it("omits seedSkipped entirely when the seed ran", async () => {
    const { h } = await seedHarness({ onboarding: OPTIONS });
    const res = await submitAndApprove(h);
    expect(res.statusCode).toBe(200);
    expect(res.json()).not.toHaveProperty("seedSkipped");
  });
});
