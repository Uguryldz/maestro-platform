import type { AdoCiDriver, AdoScmDriver } from "@maestro/adapter-ado";
import type { RepoRef } from "@maestro/ports";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ADO_ORG,
  ADO_PR_VALIDATION_DEFINITION,
  ADO_PROJECT,
  ADO_REPO,
  ADO_WEBHOOK_USERNAME,
  DEMO_SECRETS,
  TICKET_KEY,
} from "../src/config.js";
import { createFakeAdo, type FakeAdo } from "../src/fake-ado.js";
import { close, listen } from "../src/http.js";
import { createDemoCiPort, createDemoScmPort, createDemoSecrets } from "../src/wiring.js";
import { startCapture, waitFor, type Capture } from "./helpers.js";

/**
 * Contract test: the fake Azure DevOps server against the REAL adapter, and
 * the Service Hook it publishes against the REAL CI driver — including the
 * provenance gate (basic auth + `reason: "pullRequest"` + allow-listed
 * definition), which a hand-written payload would otherwise sail past.
 */
describe("sahte ADO ↔ @maestro/adapter-ado", () => {
  let ado: FakeAdo;
  let scm: AdoScmDriver;
  let ci: AdoCiDriver;
  let capture: Capture;
  let repo: RepoRef;
  const branch = `feature/${TICKET_KEY}-demo`;

  const application = {
    appId: "ugurpay",
    displayName: "Ugur Payments",
    adoProject: ADO_PROJECT,
    adoRepo: ADO_REPO,
    platform: "linux-node" as const,
    jiraComponent: null,
    maestroYamlPresent: false,
    createdVia: "import" as const,
  };

  beforeAll(async () => {
    capture = await startCapture();
    ado = createFakeAdo({
      org: ADO_ORG,
      project: ADO_PROJECT,
      repo: ADO_REPO,
      pat: DEMO_SECRETS.adoPat,
      webhookUsername: ADO_WEBHOOK_USERNAME,
      webhookSecret: DEMO_SECRETS.adoWebhook,
      webhookUrl: () => capture.url,
      definitionId: ADO_PR_VALIDATION_DEFINITION,
      buildDelayMs: 10,
    });
    const port = await listen(ado.server, 0);
    const secrets = createDemoSecrets({ apiKey: "test", baseUrl: "http://127.0.0.1" });
    const base = `http://127.0.0.1:${port}`;
    scm = createDemoScmPort(secrets, base);
    ci = createDemoCiPort(secrets, base);
    repo = await scm.resolveRepo(application);
  });

  afterAll(async () => {
    await close(ado.server);
    await capture.close();
  });

  it("depo çözülür", () => {
    expect(repo).toEqual({ project: ADO_PROJECT, repo: ADO_REPO });
  });

  it("dal açılır; aynı dal ikinci kez açılmaya çalışılırsa reddedilir", async () => {
    await scm.createBranch(repo, branch, "refs/heads/main");
    expect(ado.branches()).toContain(`refs/heads/${branch}`);
    await expect(scm.createBranch(repo, branch, "refs/heads/main")).rejects.toThrow(/rejected/);
  });

  it("taslak PR açılır, aktifleşir ve durumu okunur", async () => {
    const { prId } = await scm.openPr(repo, {
      sourceBranch: branch,
      targetBranch: "main",
      title: `[AI] ${TICKET_KEY}`,
      description: "demo",
      draft: true,
    });
    expect(prId).toBeGreaterThan(0);

    const draftStatus = await scm.getPrStatus(repo, prId);
    expect(draftStatus.state).toBe("draft");
    expect(draftStatus.mergeSha).toBeNull();

    await scm.activatePr(repo, prId);
    expect((await scm.getPrStatus(repo, prId)).state).toBe("active");

    ado.completePullRequest(prId);
    const merged = await scm.getPrStatus(repo, prId);
    expect(merged.state).toBe("completed");
    expect(merged.mergeSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("PR yorum başlıkları listelenir", async () => {
    const pr = ado.pullRequests()[0];
    expect(pr).toBeDefined();
    await expect(scm.listPrThreads(repo, pr!.pullRequestId)).resolves.toEqual([]);
  });

  it("build.complete Service Hook gerçek doğrulamadan geçer ve CI sinyaline dönüşür", async () => {
    const { prId } = await scm.openPr(repo, {
      sourceBranch: branch,
      targetBranch: "main",
      title: `[AI] ${TICKET_KEY} ci`,
      description: "demo",
      draft: false,
    });
    // Earlier tests also queued deliveries, so match on the PR rather than
    // assuming the newest delivery is this one.
    const isThisPr = (raw: string): boolean => raw.includes(`"pr.number":"${prId}"`);
    await waitFor(
      () => capture.received.some((delivery) => isThisPr(delivery.raw)),
      5_000,
      "service hook teslimi",
    );

    const delivery = capture.received.find((candidate) => isThisPr(candidate.raw))!;
    const body: unknown = JSON.parse(delivery.raw);
    const signal = await ci.parseBuildEvent({
      headers: { authorization: delivery.headers["authorization"] ?? "" },
      body,
    });
    expect(signal).not.toBeNull();
    expect(signal?.ticketKey).toBe(TICKET_KEY);
    expect(signal?.prId).toBe(prId);
    expect(signal?.status).toBe("succeeded");
    expect(signal?.adoProject).toBe(ADO_PROJECT);

    // Same body, wrong shared secret → refused before the body is read.
    await expect(
      ci.parseBuildEvent({
        headers: { authorization: `Basic ${Buffer.from("maestro:yanlis").toString("base64")}` },
        body,
      }),
    ).rejects.toThrow();
  });
});
