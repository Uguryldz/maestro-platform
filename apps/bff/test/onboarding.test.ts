import { describe, expect, it } from "vitest";
import type { OnboardingOptionsRecord, OnboardingSampleTicket } from "../src/onboarding-models.js";
import { ONBOARDING_PROPOSAL_PREFIX } from "../src/routes/onboarding.js";
import { harness, TEST_PASSWORD, type Harness } from "./helpers.js";

/**
 * The onboarding wizard (M93/M102).
 *
 * The three endpoints exist to make ONE decision safe: binding a Jira project
 * to a repository decides where an agent will be allowed to push code. So the
 * tests below are mostly about refusals — an unknown repo, a project somebody
 * already owns, a platform that does not match, a stopped platform — and about
 * the one positive property that matters, that submitting produces a PROPOSAL
 * and changes nothing.
 */

const OPTIONS: OnboardingOptionsRecord = {
  projects: [
    { projectKey: "UGURPAY", state: "active" },
    { projectKey: "NEWPROJ", state: null },
    { projectKey: "DRAFTED", state: "draft" },
    { projectKey: "REHEARSE", state: "dry_run" },
  ],
  repos: [
    { appId: "ugurpay", repo: "Odeme/_git/ugurpay", platform: "linux-node" },
    { appId: "cards", repo: "Kart/_git/cards", platform: "linux-java" },
  ],
  platforms: ["linux-java", "linux-node"],
};

/**
 * A project's real run history, as `WorkflowRun` rows would supply it. Each
 * `match` is a genuine `MatchResult` — the dry run reads these rather than
 * re-deciding, so the fixture is where the three tiers actually come from.
 */
const SAMPLES = new Map<string, readonly OnboardingSampleTicket[]>([
  [
    "NEWPROJ",
    [
      { ticketKey: "NEWPROJ-1", appId: "cards", match: { via: "rule", ruleId: "r-1", appId: "cards" } },
      { ticketKey: "NEWPROJ-2", appId: "cards", match: { via: "rule", ruleId: "r-1", appId: "cards" } },
      {
        ticketKey: "NEWPROJ-3",
        appId: "cards",
        match: { via: "ai_suggestion", appId: "cards", confidence: 0.8, validatedAtGate: true },
      },
      {
        ticketKey: "NEWPROJ-4",
        appId: "cards",
        match: { via: "human", appId: "cards", assignedBy: "ayse", channel: "studio" },
      },
      // No recorded match at all: the run started before matching resolved.
      { ticketKey: "NEWPROJ-5", appId: null, match: null },
      // A corrupt column. Fail-closed: it must land in `unresolved`.
      { ticketKey: "NEWPROJ-6", appId: null, match: { via: "rule" } },
      // The same ticket twice — a retry. It is ONE ticket in the answer.
      { ticketKey: "NEWPROJ-1", appId: "cards", match: { via: "rule", ruleId: "r-9", appId: "cards" } },
    ],
  ],
]);

async function wizard(): Promise<Harness> {
  return harness({ onboarding: OPTIONS, samples: SAMPLES });
}

/**
 * The wizard WITHOUT the M100 app-registry writer — the geriye-uyum path where
 * the repo must already be in the options and the submit files a proposal only.
 * The `refuse` cases below (platform mismatch, second proposer) belong here:
 * they assert the OLDER `assertBindable`-gated behaviour against `cards`, a repo
 * already in the fixture. The writer-on path registers whatever repo the draft
 * names, so a mismatch cannot arise there.
 */
async function wizardLegacy(): Promise<Harness> {
  return harness({ onboarding: OPTIONS, samples: SAMPLES, withAppRegistry: false });
}

async function adminToken(app: Harness): Promise<string> {
  await app.addUser({ username: "ayse.kaya", roles: ["admin"], groups: ["maestro-admins"] });
  return app.login("ayse.kaya");
}

describe("GET /onboarding/options", () => {
  it("returns the three flat lists the wizard's selects are built from", async () => {
    const app = await wizard();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "GET",
      url: "/onboarding/options",
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    const options = response.json();
    expect(options.jiraProjects).toEqual(["UGURPAY", "NEWPROJ", "DRAFTED", "REHEARSE"]);
    expect(options.adoRepos).toEqual(["ugurpay", "cards"]);
    // The four contract platform PROFILES are always offered (a fresh install
    // has no bindings to derive them from), plus any already seen in the store.
    expect(options.platforms).toEqual(
      expect.arrayContaining(["linux-node", "linux-android", "macos-xcode", "windows-dotnet"]),
    );
    expect(options.platforms).toContain("linux-java"); // the extra one the store seeded
  });

  it("refuses an anonymous caller", async () => {
    const app = await wizard();
    const response = await app.app.inject({ method: "GET", url: "/onboarding/options" });
    expect(response.statusCode).toBe(401);
  });

  it("refuses a developer: onboarding is an admin surface (M86)", async () => {
    const app = await wizard();
    await app.addUser({ username: "dev", roles: ["developer"] });
    const token = await app.login("dev");

    const response = await app.app.inject({
      method: "GET",
      url: "/onboarding/options",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("role_required");
  });

  it("caps the page size rather than accepting an unbounded read", async () => {
    const app = await wizard();
    const token = await adminToken(app);
    const response = await app.app.inject({
      method: "GET",
      url: "/onboarding/options?limit=5000",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_page");
  });
});

describe("POST /onboarding/dry-run", () => {
  it("sorts a project's real history into the three M99 tiers", async () => {
    const app = await wizard();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "POST",
      url: "/onboarding/dry-run",
      headers: { authorization: `Bearer ${token}` },
      payload: { jiraProject: "NEWPROJ", adoRepo: "cards" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    // Tier 1: matched by an explicit rule. NEWPROJ-1 appears once despite two runs.
    expect(body.byRule).toEqual(["NEWPROJ-1", "NEWPROJ-2"]);
    // Tier 2: the AI guessed, or a human assigned by hand.
    expect(body.bySuggestion).toEqual(["NEWPROJ-3", "NEWPROJ-4"]);
    // Tier 3: no match, and a corrupt match — both need a person.
    expect(body.unresolved).toEqual(["NEWPROJ-5", "NEWPROJ-6"]);
    expect(body.sampled).toBe(6);
  });

  /**
   * An analysis-only install owns no repository and needs none — the analysis
   * is produced from the ticket text and a repo only ENRICHES the impact
   * section. The rehearsal replays a PROJECT's tickets against the routing
   * rules; it never touches a repository and only echoes the name back.
   *
   * Requiring `adoRepo` therefore made the wizard's MANDATORY check impossible
   * for exactly the deployment this product is sold for: the operator could
   * not rehearse, so they could not submit, so they could not finish setup.
   */
  it("rehearses a project with no repository at all", async () => {
    const app = await wizard();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "POST",
      url: "/onboarding/dry-run",
      headers: { authorization: `Bearer ${token}` },
      payload: { jiraProject: "NEWPROJ" },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    // The routing verdicts are the real answer, and they are unchanged.
    expect(body.byRule).toEqual(["NEWPROJ-1", "NEWPROJ-2"]);
    expect(body.sampled).toBe(6);
    // Nothing was invented to stand in for the repository.
    expect(body.appId).toBe("");
  });

  it("reports an empty history as nothing proved, not as a clean run", async () => {
    const app = await wizard();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "POST",
      url: "/onboarding/dry-run",
      headers: { authorization: `Bearer ${token}` },
      payload: { jiraProject: "DRAFTED", adoRepo: "cards" },
    });

    expect(response.statusCode).toBe(200);
    // `sampled: 0` is the field that distinguishes "nothing to replay" from
    // "everything resolved". Three empty buckets alone would read as success.
    expect(response.json()).toMatchObject({
      byRule: [],
      bySuggestion: [],
      unresolved: [],
      sampled: 0,
    });
  });

  it("rehearses a repo that is not yet in the registry (the new-onboarding case)", async () => {
    const app = await wizard();
    const token = await adminToken(app);

    // A repo picked LIVE off SCM is not in the registry until submit writes it.
    // The dry run replays the PROJECT's history and does not need the repo to
    // exist, so it must succeed and echo the repo back as the appId.
    const response = await app.app.inject({
      method: "POST",
      url: "/onboarding/dry-run",
      headers: { authorization: `Bearer ${token}` },
      payload: { jiraProject: "NEWPROJ", adoRepo: "Uguryldz/brand-new" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().appId).toBe("Uguryldz/brand-new");
  });

  it("refuses a project that is already live rather than warning about it", async () => {
    const app = await wizard();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "POST",
      url: "/onboarding/dry-run",
      headers: { authorization: `Bearer ${token}` },
      payload: { jiraProject: "UGURPAY", adoRepo: "cards" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("project_already_bound");
  });

  it("treats a rehearsal in progress as taken", async () => {
    const app = await wizard();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "POST",
      url: "/onboarding/dry-run",
      headers: { authorization: `Bearer ${token}` },
      payload: { jiraProject: "REHEARSE", adoRepo: "cards" },
    });
    expect(response.statusCode).toBe(409);
  });

  it("refuses an unknown field rather than silently dropping it", async () => {
    const app = await wizard();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "POST",
      url: "/onboarding/dry-run",
      headers: { authorization: `Bearer ${token}` },
      payload: { jiraProject: "NEWPROJ", adoRepo: "cards", sampelSize: 5 },
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("POST /onboarding", () => {
  const DRAFT = {
    jiraProject: "NEWPROJ",
    adoRepo: "cards",
    platform: "linux-java",
    triggerMode: "opt_in",
    gateSet: "risk_tiered",
    mergeMode: "human",
  } as const;

  it("files a proposal and binds nothing", async () => {
    // Legacy path: no writer, so the repo must already be in the options.
    const app = await wizardLegacy();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "POST",
      url: "/onboarding",
      headers: { authorization: `Bearer ${token}` },
      payload: DRAFT,
    });

    // 202, not 201: nothing was created. A second human has to confirm.
    expect(response.statusCode).toBe(202);
    const body = response.json();
    expect(body.status).toBe("pending_four_eyes");
    expect(body.approverGroup).toBe("maestro-admins");
    expect(typeof body.proposalId).toBe("string");

    // The binding itself is untouched: the project is still unbound.
    const pending = await app.params.pending();
    const proposal = pending.find((entry) => entry.key === ONBOARDING_PROPOSAL_PREFIX);
    expect(proposal).toBeDefined();
    expect(proposal?.scopeRef).toBe("NEWPROJ");
    expect(proposal?.value).toMatchObject({ appId: "cards", triggerMode: "opt_in" });
  });

  it("writes an audit record naming the project and the app", async () => {
    const app = await wizardLegacy();
    const token = await adminToken(app);

    await app.app.inject({
      method: "POST",
      url: "/onboarding",
      headers: { authorization: `Bearer ${token}` },
      payload: DRAFT,
    });

    const events = await app.auditStore.read();
    const entry = events.find((event) => event.subject === "onboarding:NEWPROJ");
    expect(entry).toBeDefined();
    expect(entry?.meta).toMatchObject({ appId: "cards", projectKey: "NEWPROJ" });
  });

  it("refuses when the kill switch is on (M58)", async () => {
    const app = await wizard();
    const token = await adminToken(app);
    await app.killSwitch.set({
      level: "all",
      actor: "ops@corp",
      reason: "incident",
      at: "2026-08-09T09:00:00.000Z",
    });

    const response = await app.app.inject({
      method: "POST",
      url: "/onboarding",
      headers: { authorization: `Bearer ${token}` },
      payload: DRAFT,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("kill_switch");
    expect(await app.params.pending()).toEqual([]);
  });

  it("refuses a platform that is not the repository's own", async () => {
    // Legacy path only: with the writer on, the repo is registered with the
    // draft's own platform, so it always matches — the mismatch is a property
    // of binding to a repo somebody ELSE onboarded with a fixed profile.
    const app = await wizardLegacy();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "POST",
      url: "/onboarding",
      headers: { authorization: `Bearer ${token}` },
      // `cards` is linux-java; the draft carries a stale linux-node from step 2.
      payload: { ...DRAFT, platform: "linux-node" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("platform_mismatch");
  });

  it("refuses a second person's proposal for the same project", async () => {
    const app = await wizardLegacy();
    const first = await adminToken(app);
    await app.app.inject({
      method: "POST",
      url: "/onboarding",
      headers: { authorization: `Bearer ${first}` },
      payload: DRAFT,
    });

    await app.addUser({ username: "mert.demir", roles: ["tech-lead"] });
    const second = await app.login("mert.demir");
    const response = await app.app.inject({
      method: "POST",
      url: "/onboarding",
      headers: { authorization: `Bearer ${second}` },
      payload: DRAFT,
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("proposal_open");
  });

  it("refuses a developer", async () => {
    const app = await wizard();
    await app.addUser({ username: "dev2", roles: ["developer"] });
    const token = await app.login("dev2", TEST_PASSWORD);

    const response = await app.app.inject({
      method: "POST",
      url: "/onboarding",
      headers: { authorization: `Bearer ${token}` },
      payload: DRAFT,
    });
    expect(response.statusCode).toBe(403);
  });

  it("refuses a draft missing a required choice", async () => {
    const app = await wizard();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "POST",
      url: "/onboarding",
      headers: { authorization: `Bearer ${token}` },
      payload: { ...DRAFT, platform: "" },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_onboarding_body");
  });

  it("names the violated fields in the 400, so the operator sees WHICH field was refused", async () => {
    const app = await wizard();
    const token = await adminToken(app);

    // Two violations at once: a required enum is missing and an unknown key is
    // sent (the `.strict()` refusal). Both must come back BY NAME — the bare
    // code left the operator diffing an eight-field payload against the source.
    const { triggerMode: _dropped, ...rest } = DRAFT;
    const response = await app.app.inject({
      method: "POST",
      url: "/onboarding",
      headers: { authorization: `Bearer ${token}` },
      payload: { ...rest, mergeModeX: "auto" },
    });
    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: string; details?: { issues?: string[] } };
    expect(body.error).toBe("invalid_onboarding_body");
    const issues = body.details?.issues ?? [];
    expect(issues.some((issue) => issue.includes("triggerMode"))).toBe(true);
    expect(issues.some((issue) => issue.includes("mergeModeX"))).toBe(true);
    // Field names and schema prose only — never an echo of a secret-bearing value.
    expect(JSON.stringify(issues)).not.toContain("Bearer");
  });

  // ── M100: registering the app directly, then proposing the binding ──────────

  /** A draft naming a repo the fixture does NOT contain, as `owner/repo`. */
  const NEW_DRAFT = {
    jiraProject: "NEWPROJ",
    adoRepo: "Uguryldz/maestro-pilot",
    platform: "linux-node",
    triggerMode: "opt_in",
    gateSet: "risk_tiered",
    mergeMode: "human",
  } as const;

  it("registers a repo that was never onboarded, then proposes the binding", async () => {
    const app = await wizard();
    const token = await adminToken(app);

    // The repo is absent from the options at the start — the older wall would
    // have refused it with `unknown_app`.
    const before = await app.read.onboarding.options({ limit: 200, cursor: null });
    expect(before.repos.some((repo) => repo.appId === "Uguryldz/maestro-pilot")).toBe(false);

    const response = await app.app.inject({
      method: "POST",
      url: "/onboarding",
      headers: { authorization: `Bearer ${token}` },
      payload: NEW_DRAFT,
    });

    // The submit still ends in a four-eyes proposal, not a live binding.
    expect(response.statusCode).toBe(202);
    expect(response.json().status).toBe("pending_four_eyes");

    // But the app now exists in the inventory: appId is the full name verbatim,
    // split into owner/repo, carrying the draft's platform.
    const after = await app.read.onboarding.options({ limit: 200, cursor: null });
    const registered = after.repos.find((repo) => repo.appId === "Uguryldz/maestro-pilot");
    expect(registered).toBeDefined();
    expect(registered).toMatchObject({
      appId: "Uguryldz/maestro-pilot",
      repo: "Uguryldz/_git/maestro-pilot",
      platform: "linux-node",
    });

    // And both facts are on the trail: the registration AND the proposal.
    const events = await app.auditStore.read();
    const reg = events.find((event) => event.subject === "application:Uguryldz/maestro-pilot");
    expect(reg?.meta).toMatchObject({
      registered: "application",
      appId: "Uguryldz/maestro-pilot",
      adoProject: "Uguryldz",
      adoRepo: "maestro-pilot",
      createdVia: "onboarding",
    });
    const proposal = events.find((event) => event.subject === "onboarding:NEWPROJ");
    expect(proposal).toBeDefined();
  });

  it("refuses a repo name that is not owner/repo", async () => {
    const app = await wizard();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "POST",
      url: "/onboarding",
      headers: { authorization: `Bearer ${token}` },
      // No slash: not a repository this platform can split into two columns.
      payload: { ...NEW_DRAFT, adoRepo: "just-a-name" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error).toBe("invalid_repo_name");
    // Nothing was written: no app row, no proposal.
    const after = await app.read.onboarding.options({ limit: 200, cursor: null });
    expect(after.repos.some((repo) => repo.appId === "just-a-name")).toBe(false);
    expect(await app.params.pending()).toEqual([]);
  });

  it("registers a repo for a brand-new project the binding table has never seen", async () => {
    const app = await wizard();
    const token = await adminToken(app);

    // FRESHPROJ is in neither the binding table nor the fixture's projects — a
    // project picked LIVE off Jira that nobody has onboarded yet. That is not an
    // error: it is exactly what the wizard exists to do, so the submit proceeds.
    const response = await app.app.inject({
      method: "POST",
      url: "/onboarding",
      headers: { authorization: `Bearer ${token}` },
      payload: { ...NEW_DRAFT, jiraProject: "FRESHPROJ" },
    });

    expect(response.statusCode).toBe(202);
    const after = await app.read.onboarding.options({ limit: 200, cursor: null });
    expect(after.repos.some((repo) => repo.appId === "Uguryldz/maestro-pilot")).toBe(true);
  });

  it("does not register a repo when the project is already bound (no stranded app row)", async () => {
    const app = await wizard();
    const token = await adminToken(app);

    // UGURPAY is `active` in the fixture — already somebody's. The project check
    // must fail BEFORE the repo is written, leaving no orphan row.
    const response = await app.app.inject({
      method: "POST",
      url: "/onboarding",
      headers: { authorization: `Bearer ${token}` },
      payload: { ...NEW_DRAFT, jiraProject: "UGURPAY" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().error).toBe("project_already_bound");
    const after = await app.read.onboarding.options({ limit: 200, cursor: null });
    expect(after.repos.some((repo) => repo.appId === "Uguryldz/maestro-pilot")).toBe(false);
  });

  it("without a writer, an un-onboarded repo is still refused (geriye-uyum)", async () => {
    const app = await wizardLegacy();
    const token = await adminToken(app);

    const response = await app.app.inject({
      method: "POST",
      url: "/onboarding",
      headers: { authorization: `Bearer ${token}` },
      payload: NEW_DRAFT,
    });

    // No writer means the older `assertBindable` wall stands: the repo was
    // never onboarded, so the wizard cannot bind it.
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("unknown_app");
  });
});

describe("onboarding approval chain (M93)", () => {
  const NEW_DRAFT = {
    jiraProject: "NEWPROJ",
    adoRepo: "Uguryldz/maestro-pilot",
    platform: "linux-node",
    triggerMode: "opt_in",
    gateSet: "risk_tiered",
    mergeMode: "human",
  } as const;

  /** Submit a package as ayse (admin), returning the ready harness + her token. */
  async function submitted(): Promise<Harness> {
    const app = await harness({ onboarding: OPTIONS, samples: SAMPLES });
    const token = await adminToken(app); // ayse.kaya, admin
    const res = await app.app.inject({
      method: "POST",
      url: "/onboarding",
      headers: { authorization: `Bearer ${token}` },
      payload: NEW_DRAFT,
    });
    expect(res.statusCode).toBe(202);
    return app;
  }

  it("lists the submitted package in the pending queue", async () => {
    const app = await submitted();
    const token = await app.login("ayse.kaya");
    const res = await app.app.inject({
      method: "GET",
      url: "/onboarding/pending",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const items = res.json().items as { projectKey: string; appId: string; proposedBy: string }[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      projectKey: "NEWPROJ",
      appId: "Uguryldz/maestro-pilot",
      proposedBy: "ayse.kaya@ugurbank.local",
    });
  });

  it("refuses a NON-master proposer approving their own package (four-eyes)", async () => {
    // A tech-lead (not maestro-admins) proposes, then tries to approve their own
    // package: the strict four-eyes rule still applies to everyone but a master
    // admin, so this must be refused.
    const app = await harness({ onboarding: OPTIONS, samples: SAMPLES });
    await app.addUser({ username: "baran.tunc", roles: ["tech-lead"], groups: ["tech-leads"] });
    const proposer = await app.login("baran.tunc");
    const submit = await app.app.inject({
      method: "POST",
      url: "/onboarding",
      headers: { authorization: `Bearer ${proposer}` },
      payload: NEW_DRAFT,
    });
    expect(submit.statusCode).toBe(202);

    const res = await app.app.inject({
      method: "POST",
      url: "/onboarding/approve",
      headers: { authorization: `Bearer ${proposer}` },
      payload: { projectKey: "NEWPROJ" },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("self_approval");
    // The proposal is untouched; the project is still unbound.
    expect(await app.bindings.resolve("NEWPROJ")).toBeNull();
  });

  it("lets a MASTER ADMIN approve their own package (single-admin exemption)", async () => {
    // ayse.kaya is in maestro-admins; a one-admin install must not deadlock, so
    // she may approve the package she proposed. The binding goes live and the
    // pending clears, exactly as a second approver would produce.
    const app = await submitted(); // proposed by ayse.kaya (maestro-admins)
    const token = await app.login("ayse.kaya");
    const res = await app.app.inject({
      method: "POST",
      url: "/onboarding/approve",
      headers: { authorization: `Bearer ${token}` },
      payload: { projectKey: "NEWPROJ" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "bound", projectKey: "NEWPROJ" });
    // The binding is live and the pending queue is empty.
    expect(await app.bindings.resolve("NEWPROJ")).not.toBeNull();
    const pending = await app.app.inject({
      method: "GET",
      url: "/onboarding/pending",
      headers: { authorization: `Bearer ${token}` },
    });
    expect((pending.json().items as unknown[]).length).toBe(0);
  });

  it("binds the project when a SECOND admin approves, and clears the pending", async () => {
    const app = await submitted();
    await app.addUser({ username: "mert.demir", roles: ["admin"], groups: ["maestro-admins"] });
    const second = await app.login("mert.demir");

    const res = await app.app.inject({
      method: "POST",
      url: "/onboarding/approve",
      headers: { authorization: `Bearer ${second}` },
      payload: { projectKey: "NEWPROJ" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: "bound", projectKey: "NEWPROJ", nextStep: "listening_rule" });

    // The binding is now live and resolves for the intake path.
    const binding = await app.bindings.resolve("NEWPROJ");
    expect(binding).toMatchObject({
      projectKey: "NEWPROJ",
      active: true,
      triggerMode: "opt_in", // opt_in → label → opt_in
      appId: "Uguryldz/maestro-pilot",
      // NEW_DRAFT sends no `dataClass`, and a missing field is still not
      // evidence that the tickets are safe for a cloud model — so the FALLBACK
      // stands, unchanged. This is the backward-compatibility guarantee for
      // every proposal filed before the wizard started asking.
      dataClass: "gizli",
    });
    // The pending queue is empty — the proposal was consumed.
    const pending = await app.params.pending();
    expect(pending.filter((p) => p.key === "onboarding.binding")).toHaveLength(0);
  });

  /**
   * The data class the proposer ANSWERED (M18).
   *
   * The measured defect: the wizard never asked, `DraftBody` had no field for
   * it, and `bindingFromProposal` hard-coded `gizli`. Every binding the wizard
   * ever filed came out confidential, and `packages/llm-gateway/src/policy.ts`
   * then correctly refused to send that content to a cloud model — on-prem
   * only, no exceptions. On a deployment with no on-prem model that silently
   * turned the analysis off: SAM1-12 stalled and told the operator "modeli
   * kullanamadım, elle tamamlayın" with nothing naming the cause. Setting SAM1
   * to `dahili` let SAM1-13 run analysis normally.
   *
   * So the field is now accepted, carried through the four-eyes queue, shown to
   * the approver, recorded in the chain, and written to the binding.
   */
  describe("the data class the proposer chose", () => {
    async function submittedWith(dataClass: string): Promise<Harness> {
      const app = await harness({ onboarding: OPTIONS, samples: SAMPLES });
      const token = await adminToken(app);
      const res = await app.app.inject({
        method: "POST",
        url: "/onboarding",
        headers: { authorization: `Bearer ${token}` },
        payload: { ...NEW_DRAFT, dataClass },
      });
      expect(res.statusCode).toBe(202);
      return app;
    }

    it("writes the chosen class into the binding, not the hard-coded gizli", async () => {
      const app = await submittedWith("dahili");
      await app.addUser({ username: "mert.demir", roles: ["admin"], groups: ["maestro-admins"] });
      const second = await app.login("mert.demir");

      const res = await app.app.inject({
        method: "POST",
        url: "/onboarding/approve",
        headers: { authorization: `Bearer ${second}` },
        payload: { projectKey: "NEWPROJ" },
      });
      expect(res.statusCode).toBe(200);
      // The whole point: this binding CAN reach a cloud model, because a human
      // said its tickets carry no customer data.
      expect(await app.bindings.resolve("NEWPROJ")).toMatchObject({ dataClass: "dahili" });
    });

    it("shows the approver which class they are approving", async () => {
      const app = await submittedWith("acik");
      const token = await app.login("ayse.kaya");
      const res = await app.app.inject({
        method: "GET",
        url: "/onboarding/pending",
        headers: { authorization: `Bearer ${token}` },
      });
      // Four eyes only works if the second human can see what they confirm.
      expect(res.json().items[0]).toMatchObject({ projectKey: "NEWPROJ", dataClass: "acik" });
    });

    it("resolves an ABSENT class to gizli in the queue, matching what approval would write", async () => {
      const app = await submitted(); // NEW_DRAFT, no dataClass
      const token = await app.login("ayse.kaya");
      const res = await app.app.inject({
        method: "GET",
        url: "/onboarding/pending",
        headers: { authorization: `Bearer ${token}` },
      });
      // Never "the field is missing" — that is not something an approver can
      // act on, and it must agree with `bindingFromProposal` exactly.
      expect(res.json().items[0]).toMatchObject({ dataClass: "gizli" });
    });

    it("records the choice in the audit chain, not just in the pending value", async () => {
      const app = await submittedWith("dahili");
      const entries = await app.auditStore.read();
      const proposal = entries.find(
        (e) => (e.meta as Record<string, unknown> | undefined)?.["proposal"] === "onboarding_binding",
      );
      // "Who asked for this class on a bank system, and when" is a question the
      // chain has to answer months later.
      expect(proposal?.meta).toMatchObject({ dataClass: "dahili" });
    });

    it("refuses a class outside the enum rather than storing free text", async () => {
      const app = await harness({ onboarding: OPTIONS, samples: SAMPLES });
      const token = await adminToken(app);
      const res = await app.app.inject({
        method: "POST",
        url: "/onboarding",
        headers: { authorization: `Bearer ${token}` },
        payload: { ...NEW_DRAFT, dataClass: "cok_gizli" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid_onboarding_body");
    });
  });

  it("reject clears the pending without binding anything", async () => {
    const app = await submitted();
    await app.addUser({ username: "mert.demir", roles: ["admin"], groups: ["maestro-admins"] });
    const second = await app.login("mert.demir");

    const res = await app.app.inject({
      method: "POST",
      url: "/onboarding/reject",
      headers: { authorization: `Bearer ${second}` },
      payload: { projectKey: "NEWPROJ", reason: "wrong repo" },
    });
    expect(res.statusCode).toBe(200);
    expect(await app.bindings.resolve("NEWPROJ")).toBeNull();
    const pending = await app.params.pending();
    expect(pending.filter((p) => p.key === "onboarding.binding")).toHaveLength(0);
  });

  it("approve 404s when there is no pending package for the project", async () => {
    const app = await harness({ onboarding: OPTIONS });
    const token = await adminToken(app);
    const res = await app.app.inject({
      method: "POST",
      url: "/onboarding/approve",
      headers: { authorization: `Bearer ${token}` },
      payload: { projectKey: "NOPE" },
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("no_pending_binding");
  });

  it("refuses a developer at the approve surface", async () => {
    const app = await submitted();
    await app.addUser({ username: "dev3", roles: ["developer"] });
    const token = await app.login("dev3", TEST_PASSWORD);
    const res = await app.app.inject({
      method: "POST",
      url: "/onboarding/approve",
      headers: { authorization: `Bearer ${token}` },
      payload: { projectKey: "NEWPROJ" },
    });
    expect(res.statusCode).toBe(403);
  });
});

/** A managed SCM connection fixture for the picker endpoints. */
const GH_CONN = {
  id: "github",
  kind: "github" as const,
  displayName: "GitHub (maestro-pilot)",
  baseUrl: "https://api.github.com",
  authKind: "bearer" as const,
  config: {},
  secretRef: "connector:github:1",
  secretMask: "fOgX",
  enabled: true,
  createdAt: "2026-08-13T00:00:00.000Z",
  updatedAt: "2026-08-13T00:00:00.000Z",
  lastTestedAt: null,
  lastTestOk: null,
  lastTestNote: null,
  onPrem: false,
  isDefault: false,
};

describe("GET /onboarding/scm-connections", () => {
  it("lists only enabled github/ado connections, never a secret", async () => {
    const app = await harness({
      onboarding: OPTIONS,
      managedConnections: [
        GH_CONN,
        { ...GH_CONN, id: "jira", kind: "jira_cloud", displayName: "Jira" },
        { ...GH_CONN, id: "gh-off", enabled: false },
      ],
    });
    const token = await adminToken(app);

    const res = await app.app.inject({
      method: "GET",
      url: "/onboarding/scm-connections",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { connections: { id: string; kind: string }[] };
    // Only the enabled github connection — not jira, not the disabled one.
    expect(body.connections).toEqual([{ id: "github", kind: "github", displayName: "GitHub (maestro-pilot)" }]);
    expect(JSON.stringify(body)).not.toContain("secretRef");
  });

  it("refuses a developer", async () => {
    const app = await harness({ managedConnections: [GH_CONN] });
    await app.addUser({ username: "dev", roles: ["developer"] });
    const token = await app.login("dev");
    const res = await app.app.inject({
      method: "GET",
      url: "/onboarding/scm-connections",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses by name (503) when connections are not wired", async () => {
    const app = await harness({ deps: { connections: undefined } });
    const token = await adminToken(app);
    const res = await app.app.inject({
      method: "GET",
      url: "/onboarding/scm-connections",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(503);
  });
});

describe("GET /onboarding/scm-repos", () => {
  it("lists a connection's repos LIVE, with the stored token, never leaking it", async () => {
    const TOKEN = "ghp_stored_secret_9999";
    let sawAuth: string | null = null;
    const app = await harness({
      managedConnections: [GH_CONN],
      connectorFetch: async (_url, init) => {
        sawAuth = (init?.headers as Record<string, string>)?.authorization ?? null;
        return Response.json([{ id: 1, full_name: "Uguryldz/maestro-pilot" }]);
      },
    });
    // Seed the stored token behind the connection's secretRef.
    await app.connectorSecrets.set("connector:github:1", TOKEN);
    const token = await adminToken(app);

    const res = await app.app.inject({
      method: "GET",
      url: "/onboarding/scm-repos?connectionId=github",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; repos?: { fullName: string }[] };
    expect(body.ok).toBe(true);
    expect(body.repos?.[0]?.fullName).toBe("Uguryldz/maestro-pilot");
    // The stored token was used, and it never appears in the response.
    expect(sawAuth).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it("400s an unknown connection id", async () => {
    const app = await harness({ managedConnections: [GH_CONN] });
    const token = await adminToken(app);
    const res = await app.app.inject({
      method: "GET",
      url: "/onboarding/scm-repos?connectionId=nope",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

/** A managed Jira connection fixture for the project-picker endpoints. */
const JIRA_CONN = {
  id: "jira",
  kind: "jira_cloud" as const,
  displayName: "Jira Cloud",
  baseUrl: "https://ugurbank.atlassian.net",
  authKind: "basic" as const,
  config: { email: "bot@ugurbank.local" },
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

describe("GET /onboarding/jira-connections", () => {
  it("lists only enabled jira connections, never a secret", async () => {
    const app = await harness({
      managedConnections: [
        JIRA_CONN,
        { ...JIRA_CONN, id: "gh", kind: "github", displayName: "GitHub" },
        { ...JIRA_CONN, id: "jira-off", enabled: false },
      ],
    });
    const token = await adminToken(app);

    const res = await app.app.inject({
      method: "GET",
      url: "/onboarding/jira-connections",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { connections: { id: string; kind: string }[] };
    // Only the enabled jira connection — not github, not the disabled one.
    // `botAccountId` is null until the connection has been tested once.
    expect(body.connections).toEqual([
      { id: "jira", kind: "jira_cloud", displayName: "Jira Cloud", botAccountId: null },
    ]);
    expect(JSON.stringify(body)).not.toContain("secretRef");
  });

  it("refuses a developer", async () => {
    const app = await harness({ managedConnections: [JIRA_CONN] });
    await app.addUser({ username: "dev", roles: ["developer"] });
    const token = await app.login("dev");
    const res = await app.app.inject({
      method: "GET",
      url: "/onboarding/jira-connections",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it("refuses by name (503) when connections are not wired", async () => {
    const app = await harness({ deps: { connections: undefined } });
    const token = await adminToken(app);
    const res = await app.app.inject({
      method: "GET",
      url: "/onboarding/jira-connections",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(503);
  });

  /**
   * This endpoint is what the setup wizard pre-fills a listening rule's
   * assignee from, so it is the last gate before a doomed id is written into a
   * rule. It cannot re-probe `/myself` — it is a pure store read with no token
   * — but it can compare the id already learned against the engine's account,
   * which catches the case that matters: a connection tested successfully as
   * somebody who is not the engine.
   */
  const ENGINE = "712020:b836c135-c9d3-499a-a665-aed43d362cfd";
  const HUMAN = "712020:7ee7a2ab-23e7-47aa-a61e-38b79b7eb4d1";

  it("flags a learned botAccountId that is not the engine's account", async () => {
    const app = await harness({
      managedConnections: [{ ...JIRA_CONN, config: { ...JIRA_CONN.config, botAccountId: HUMAN } }],
      deps: { config: { actorDomain: "ugurbank.local", engineBotAccountId: ENGINE } },
    });
    const token = await adminToken(app);
    const res = await app.app.inject({
      method: "GET",
      url: "/onboarding/jira-connections",
      headers: { authorization: `Bearer ${token}` },
    });

    const body = res.json() as {
      connections: { botAccountId: string | null; engineMismatch?: { connection: string; engine: string } }[];
    };
    // The value is still SERVED, not blanked: a wizard with no pre-fill sends
    // the operator to hand-copy the same wrong GUID with nothing to warn them.
    expect(body.connections[0]?.botAccountId).toBe(HUMAN);
    // ...but it is served with the reason to doubt it attached.
    expect(body.connections[0]?.engineMismatch).toEqual({ connection: HUMAN, engine: ENGINE });
  });

  it("carries no flag when the connection IS the engine's account", async () => {
    const app = await harness({
      managedConnections: [{ ...JIRA_CONN, config: { ...JIRA_CONN.config, botAccountId: ENGINE } }],
      deps: { config: { actorDomain: "ugurbank.local", engineBotAccountId: ENGINE } },
    });
    const token = await adminToken(app);
    const res = await app.app.inject({
      method: "GET",
      url: "/onboarding/jira-connections",
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json() as { connections: { botAccountId: string | null; engineMismatch?: unknown }[] };
    expect(body.connections[0]?.botAccountId).toBe(ENGINE);
    expect(body.connections[0]?.engineMismatch).toBeUndefined();
  });

  it("carries no flag when the deployment names no engine account", async () => {
    // Nothing to disagree with; an unconfigured engine is not a mismatch.
    const app = await harness({
      managedConnections: [{ ...JIRA_CONN, config: { ...JIRA_CONN.config, botAccountId: HUMAN } }],
    });
    const token = await adminToken(app);
    const res = await app.app.inject({
      method: "GET",
      url: "/onboarding/jira-connections",
      headers: { authorization: `Bearer ${token}` },
    });
    const body = res.json() as { connections: { engineMismatch?: unknown }[] };
    expect(body.connections[0]?.engineMismatch).toBeUndefined();
  });
});

describe("GET /onboarding/jira-projects", () => {
  it("lists a connection's projects LIVE, with the stored token, never leaking it", async () => {
    const TOKEN = "jira_stored_secret_9999";
    let sawAuth: string | null = null;
    const app = await harness({
      managedConnections: [JIRA_CONN],
      connectorFetch: async (_url, init) => {
        sawAuth = (init?.headers as Record<string, string>)?.authorization ?? null;
        return Response.json({ values: [{ key: "UGURPAY", name: "Ugur Payments" }] });
      },
    });
    await app.connectorSecrets.set("connector:jira:1", TOKEN);
    const token = await adminToken(app);

    const res = await app.app.inject({
      method: "GET",
      url: "/onboarding/jira-projects?connectionId=jira",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; projects?: { key: string; name: string }[] };
    expect(body.ok).toBe(true);
    expect(body.projects?.[0]).toEqual({ key: "UGURPAY", name: "Ugur Payments" });
    // The stored token was used under Basic, and never appears in the response.
    expect(sawAuth).toMatch(/^Basic /);
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  it("400s an unknown connection id", async () => {
    const app = await harness({ managedConnections: [JIRA_CONN] });
    const token = await adminToken(app);
    const res = await app.app.inject({
      method: "GET",
      url: "/onboarding/jira-projects?connectionId=nope",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(400);
  });
});

/**
 * The analysis-only binding (repo optional for the `analiz` flow).
 *
 * The measured defect this closes: the wizard demanded an SCM connection, a
 * repository and a platform for EVERY flow, and intake refused any binding
 * without an application — so an analysis team, the actual first-pilot
 * audience, was forced to bind a code repository it does not own to get a
 * document produced from ticket text. The draft may now omit the repo pair;
 * the proposal then carries `appId: null`, approval writes that null into the
 * binding, and intake accepts only the `analiz` flow on it.
 */
describe("the analysis-only onboarding draft — no repository", () => {
  const ANALYSIS_DRAFT = {
    jiraProject: "NEWPROJ",
    triggerMode: "opt_in",
    gateSet: "risk_tiered",
    mergeMode: "human",
    dataClass: "dahili",
  } as const;

  async function submitAnalysisOnly(app: Harness): Promise<string> {
    const token = await adminToken(app);
    const res = await app.app.inject({
      method: "POST",
      url: "/onboarding",
      headers: { authorization: `Bearer ${token}` },
      payload: ANALYSIS_DRAFT,
    });
    expect(res.statusCode).toBe(202);
    return token;
  }

  it("files a proposal whose appId is null, and registers nothing", async () => {
    const app = await wizard();
    await submitAnalysisOnly(app);

    const pending = await app.params.pending();
    const proposal = pending.find((entry) => entry.key === ONBOARDING_PROPOSAL_PREFIX);
    expect(proposal?.value).toMatchObject({ jiraProject: "NEWPROJ", appId: null });
    // No repo means no inventory write — there is no application to register.
    expect((proposal?.value as { adoRepo?: string }).adoRepo).toBeUndefined();
  });

  it("shows the approver an explicit null, not a dropped field", async () => {
    const app = await wizard();
    const token = await submitAnalysisOnly(app);

    const res = await app.app.inject({
      method: "GET",
      url: "/onboarding/pending",
      headers: { authorization: `Bearer ${token}` },
    });
    const items = res.json().items as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    // Explicit nulls: the approver's screen must be able to render "depo yok"
    // from a value it can see.
    expect(items[0]).toMatchObject({ projectKey: "NEWPROJ", appId: null, adoRepo: null, platform: null });
  });

  it("approves into a live binding with NO application — the shape intake reads as analiz-only", async () => {
    const app = await wizard();
    await submitAnalysisOnly(app);
    await app.addUser({ username: "mert.demir", roles: ["admin"], groups: ["maestro-admins"] });
    const second = await app.login("mert.demir");

    const res = await app.app.inject({
      method: "POST",
      url: "/onboarding/approve",
      headers: { authorization: `Bearer ${second}` },
      payload: { projectKey: "NEWPROJ" },
    });
    expect(res.statusCode).toBe(200);

    const binding = await app.bindings.resolve("NEWPROJ");
    expect(binding).toMatchObject({
      projectKey: "NEWPROJ",
      active: true,
      appId: null,
      dataClass: "dahili",
    });
  });

  it("records the audit fact in words, not as a lost field", async () => {
    const app = await wizard();
    await submitAnalysisOnly(app);

    const events = await app.auditStore.read();
    const entry = events.find((event) => event.subject === "onboarding:NEWPROJ");
    expect(entry?.meta).toMatchObject({ appId: "yok (yalnızca analiz)", projectKey: "NEWPROJ" });
  });

  it("refuses half a repository: adoRepo without platform is a 400", async () => {
    const app = await wizard();
    const token = await adminToken(app);
    const res = await app.app.inject({
      method: "POST",
      url: "/onboarding",
      headers: { authorization: `Bearer ${token}` },
      payload: { ...ANALYSIS_DRAFT, adoRepo: "Uguryldz/maestro-pilot" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_onboarding_body");
  });

  it("refuses the other half too: platform without adoRepo is a 400", async () => {
    const app = await wizard();
    const token = await adminToken(app);
    const res = await app.app.inject({
      method: "POST",
      url: "/onboarding",
      headers: { authorization: `Bearer ${token}` },
      payload: { ...ANALYSIS_DRAFT, platform: "linux-node" },
    });
    expect(res.statusCode).toBe(400);
  });
});
