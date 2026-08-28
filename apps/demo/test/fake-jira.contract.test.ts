import type { JiraDcWorkPort } from "@maestro/adapter-jira";
import { doc, paragraph } from "@maestro/adapter-jira";
import type { TicketKey } from "@maestro/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { APPROVER_GROUP, DEMO_SECRETS, PROJECT_KEY, REPORTER, TICKET_KEY } from "../src/config.js";
import { createFakeJira, type FakeJira } from "../src/fake-jira.js";
import { close, listen } from "../src/http.js";
import { createDemoSecrets, createDemoWorkPort } from "../src/wiring.js";
import { startCapture, waitFor, type Capture } from "./helpers.js";

/**
 * Contract test: the fake Jira server really speaks to the REAL adapter.
 *
 * Everything runs on loopback with ephemeral ports — no network, no fixtures
 * replayed by hand. If the prop drifts from what `@maestro/adapter-jira`
 * expects, these fail rather than the morning demo.
 */
describe("sahte Jira ↔ @maestro/adapter-jira", () => {
  let jira: FakeJira;
  let work: JiraDcWorkPort;
  let capture: Capture;
  const key = TICKET_KEY as TicketKey;

  beforeAll(async () => {
    capture = await startCapture();
    jira = createFakeJira({
      pat: DEMO_SECRETS.jiraPat,
      webhookSecret: DEMO_SECRETS.jiraWebhook,
      webhookUrl: () => capture.url,
      issue: {
        key: TICKET_KEY,
        projectKey: PROJECT_KEY,
        summary: "Şifre sıfırlama akışına e-posta doğrulama adımı",
        description: "Kod 10 dakika geçerli olmalı.",
        issueType: "Story",
        reporter: REPORTER,
        assignee: null,
        components: ["auth-service"],
        labels: ["guvenlik"],
      },
    });
    const port = await listen(jira.server, 0);
    const secrets = createDemoSecrets({ apiKey: "test", baseUrl: "http://127.0.0.1" });
    work = createDemoWorkPort(secrets, `http://127.0.0.1:${port}`);
  });

  afterAll(async () => {
    await close(jira.server);
    await capture.close();
  });

  it("issue okuması TicketSnapshot sözleşmesine dönüşür", async () => {
    const ticket = await work.getTicket(key);
    expect(ticket.key).toBe(TICKET_KEY);
    expect(ticket.projectKey).toBe(PROJECT_KEY);
    expect(ticket.reporter).toBe(REPORTER);
    expect(ticket.components).toEqual(["auth-service"]);
    expect(ticket.labels).toEqual(["guvenlik"]);
  });

  it("yorum eklenir ve aynı yorum düzenlenerek güncellenir (M75)", async () => {
    const created = await work.addComment(key, doc(paragraph("▶ Maestro durum: analiz hazırlanıyor")));
    expect(created.commentId).toMatch(/^\d+$/);
    await work.updateComment(key, created.commentId, doc(paragraph("▶ Maestro durum: analiz hazır")));
    const stored = jira.state().comments.find((comment) => comment.id === created.commentId);
    expect(stored?.body).toContain("analiz hazır");
  });

  it("etiket ve atama yazılır", async () => {
    await work.setLabels(key, ["guvenlik", "maestro"]);
    await work.assign(key, "mert.demir");
    expect(jira.state().issue.labels).toEqual(["guvenlik", "maestro"]);
    expect(jira.state().issue.assignee).toBe("mert.demir");
  });

  it("bağlı alt ticket açılır ve ana ticket'a bağlanır", async () => {
    const child = await work.createLinkedIssue(key, {
      summary: "Alt iş: e-posta şablonu",
      description: "Fan-out çocuğu",
    });
    expect(child.key).toMatch(/^UGURPAY-\d+$/);
  });

  it("grup üyeliği sayfalanan yanıttan doğrulanır", async () => {
    await expect(work.verifyMembership("mert.demir", APPROVER_GROUP)).resolves.toBe(true);
    await expect(work.verifyMembership("ayse.kaya", APPROVER_GROUP)).resolves.toBe(false);
  });

  it("yanlış PAT ile çağrı reddedilir", async () => {
    const secrets = createDemoSecrets({ apiKey: "test", baseUrl: "http://127.0.0.1" });
    const port = (jira.server.address() as { port: number }).port;
    const wrong = createDemoWorkPort(
      { get: () => Promise.resolve("yanlis-pat"), issueShortLived: () => Promise.reject(new Error("no")), set: () => Promise.reject(new Error("no")) },
      `http://127.0.0.1:${port}`,
    );
    await expect(wrong.getTicket(key)).rejects.toThrow();
    // the correctly-wired port still works
    await expect(createDemoWorkPort(secrets, `http://127.0.0.1:${port}`).getTicket(key)).resolves.toBeDefined();
  });

  it("insan yorumu HMAC imzalı webhook üretir ve /approve komutu ayrıştırılır", async () => {
    const before = capture.received.length;
    await jira.addHumanComment("mert.demir", "/approve");
    await waitFor(() => capture.received.length > before, 5_000, "webhook teslimi");

    const delivery = capture.received.at(-1);
    expect(delivery).toBeDefined();
    // Real verification, over the RAW body — a wrong signature must throw.
    await work.verifyWebhook(delivery!.raw, delivery!.headers);
    await expect(
      work.verifyWebhook(delivery!.raw, { "x-hub-signature": `sha256=${"0".repeat(64)}` }),
    ).rejects.toThrow();

    const envelope = await work.parseCommand(JSON.parse(delivery!.raw));
    expect(envelope?.command.name).toBe("approve");
    expect(envelope?.author).toBe("mert.demir");
    expect(envelope?.ticketKey).toBe(TICKET_KEY);
  });
});
