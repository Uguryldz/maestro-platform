import { TicketSnapshot } from "@maestro/contracts";
import { CapabilityNotSupportedError } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import {
  doc,
  heading,
  JiraArgumentError,
  JiraDcConfig,
  JiraDcWorkPort,
  JiraLinkFailedError,
  JiraMembershipUnresolvedError,
  JiraResponseError,
  paragraph,
  signWebhookBody,
} from "../src/index.js";
import { fixture, stubFetch, type FetchStub } from "./helpers.js";

const SECRET = "webhook-shared-secret";

const config = JiraDcConfig.parse({
  baseUrl: "https://jira.internal.bank",
  tokenRef: "kv/jira/pat",
  webhookSecretRef: "kv/jira/webhook",
});

function port(stub: FetchStub): JiraDcWorkPort {
  return new JiraDcWorkPort({
    config,
    token: () => "pat-123",
    webhookSecret: () => SECRET,
    fetchImpl: stub.fetchImpl,
    sleep: stub.sleep,
  });
}

describe("JiraDcWorkPort", () => {
  it("reads a ticket and returns a contract-valid snapshot", async () => {
    const stub = stubFetch([{ body: fixture("issue-get") }]);
    const snapshot = await port(stub).getTicket("UGURPAY-501");

    expect(TicketSnapshot.parse(snapshot).key).toBe("UGURPAY-501");
    expect(stub.calls[0]!.url).toContain("/rest/api/2/issue/UGURPAY-501?fields=");
    expect(stub.calls[0]!.method).toBe("GET");
  });

  it("rejects a malformed issue key before touching the network", async () => {
    const stub = stubFetch([]);
    await expect(port(stub).getTicket("not-a-key")).rejects.toBeInstanceOf(JiraArgumentError);
    expect(stub.calls).toHaveLength(0);
  });

  it("posts a plain string comment as wiki markup", async () => {
    const stub = stubFetch([{ body: fixture("comment-created-response") }]);
    const res = await port(stub).addComment("UGURPAY-501", "durum: analiz hazır");

    expect(res.commentId).toBe("45230");
    expect(stub.calls[0]!.url).toBe("https://jira.internal.bank/rest/api/2/issue/UGURPAY-501/comment");
    expect(stub.calls[0]!.body).toEqual({ body: "durum: analiz hazır" });
  });

  it("renders an ADF document for the DC v2 comment API", async () => {
    const stub = stubFetch([{ body: fixture("comment-created-response") }]);
    await port(stub).addComment("UGURPAY-501", doc(heading(2, "Analiz hazır"), paragraph("Kapsam uygun.")));

    expect(stub.calls[0]!.body).toEqual({ body: "h2. Analiz hazır\n\nKapsam uygun." });
  });

  it("edits the progress comment in place (M75)", async () => {
    const stub = stubFetch([{ body: fixture("comment-created-response") }]);
    await port(stub).updateComment("UGURPAY-501", "45230", "▶ Maestro durum: adım 6a");

    expect(stub.calls[0]!.method).toBe("PUT");
    expect(stub.calls[0]!.url).toBe("https://jira.internal.bank/rest/api/2/issue/UGURPAY-501/comment/45230");
  });

  it("fails loudly when Jira answers a comment write without an id", async () => {
    const stub = stubFetch([{ body: { self: "https://jira.internal.bank/x" } }]);
    await expect(port(stub).addComment("UGURPAY-501", "x")).rejects.toBeInstanceOf(JiraResponseError);
  });

  it("sets labels with a single Edit Issue call (M102 permission set)", async () => {
    const stub = stubFetch([{ status: 204 }]);
    await port(stub).setLabels("UGURPAY-501", [" maestro ", "risk-orta"]);

    expect(stub.calls[0]!.method).toBe("PUT");
    expect(stub.calls[0]!.url).toBe("https://jira.internal.bank/rest/api/2/issue/UGURPAY-501");
    expect(stub.calls[0]!.body).toEqual({ fields: { labels: ["maestro", "risk-orta"] } });
  });

  it("refuses labels Jira would reject", async () => {
    const stub = stubFetch([]);
    await expect(port(stub).setLabels("UGURPAY-501", ["iki kelime"])).rejects.toThrow(/whitespace/);
    await expect(port(stub).setLabels("UGURPAY-501", [" "])).rejects.toBeInstanceOf(JiraArgumentError);
    expect(stub.calls).toHaveLength(0);
  });

  it("assigns and unassigns via the DC username field", async () => {
    const stub = stubFetch([{ status: 204 }, { status: 204 }]);
    const jira = port(stub);
    await jira.assign("UGURPAY-501", "mert.demir");
    await jira.assign("UGURPAY-501", null);

    expect(stub.calls[0]!.url).toBe("https://jira.internal.bank/rest/api/2/issue/UGURPAY-501/assignee");
    expect(stub.calls[0]!.body).toEqual({ name: "mert.demir" });
    expect(stub.calls[1]!.body).toEqual({ name: null });
  });

  it("creates a fan-out child and links it to the parent", async () => {
    const stub = stubFetch([{ status: 201, body: fixture("issue-created-response") }, { status: 201, body: {} }]);
    const res = await port(stub).createLinkedIssue("UGURPAY-501", {
      summary: "iOS tarafı",
      description: "child of UGURPAY-501",
      labels: ["maestro"],
    });

    expect(res.key).toBe("UGURPAY-612");
    expect(stub.calls[0]!.body).toEqual({
      fields: {
        project: { key: "UGURPAY" },
        summary: "iOS tarafı",
        description: "child of UGURPAY-501",
        issuetype: { name: "Task" },
        labels: ["maestro"],
      },
    });
    expect(stub.calls[1]!.url).toBe("https://jira.internal.bank/rest/api/2/issueLink");
    expect(stub.calls[1]!.body).toEqual({
      type: { name: "Relates" },
      inwardIssue: { key: "UGURPAY-612" },
      outwardIssue: { key: "UGURPAY-501" },
    });
  });

  it("surfaces the orphan child key when linking fails", async () => {
    const stub = stubFetch([{ status: 201, body: fixture("issue-created-response") }, { status: 403, body: {} }]);
    const error = await port(stub)
      .createLinkedIssue("UGURPAY-501", { summary: "s", description: "d" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(JiraLinkFailedError);
    expect((error as JiraLinkFailedError).childKey).toBe("UGURPAY-612");
  });

  it("confirms group membership from the member API", async () => {
    const stub = stubFetch([{ body: fixture("group-members") }]);
    await expect(port(stub).verifyMembership("Mert.Demir", "tech-leads")).resolves.toBe(true);

    const url = stub.calls[0]!.url;
    expect(url).toContain("groupname=tech-leads");
    expect(url).toContain("includeInactiveUsers=false");
  });

  it("denies a user who is not in the group", async () => {
    const stub = stubFetch([{ body: fixture("group-members") }]);
    await expect(port(stub).verifyMembership("ayse.kaya", "tech-leads")).resolves.toBe(false);
  });

  it("matches on the stable user key and e-mail as well", async () => {
    const byKey = stubFetch([{ body: fixture("group-members") }]);
    await expect(port(byKey).verifyMembership("JIRAUSER10344", "tech-leads")).resolves.toBe(true);
    const byMail = stubFetch([{ body: fixture("group-members") }]);
    await expect(port(byMail).verifyMembership("can.ozturk@bank.example", "tech-leads")).resolves.toBe(true);
  });

  /**
   * Found live on OPS-36. A Jira CLOUD member carries no `name`, no `key` and —
   * without user-management scope — no `emailAddress`: the only identifier is
   * `accountId`. Every approval on a Cloud site was therefore refused as
   * "üyelik doğrulanamadı" by a person who was in the group all along.
   */
  describe("a Jira Cloud member, whose only identifier is the account id", () => {
    // `isLast` included on purpose: a page bean without it is refused rather
    // than read as "the end", which is the behaviour the pagination tests below
    // pin down.
    const cloudGroup = {
      isLast: true,
      values: [{ accountId: "712020:b836c135-c9d3-499a-a665-aed43d362cfd", active: true }],
    };

    it("matches on the account id", async () => {
      const stub = stubFetch([{ body: cloudGroup }]);
      await expect(
        port(stub).verifyMembership("712020:b836c135-c9d3-499a-a665-aed43d362cfd", "po"),
      ).resolves.toBe(true);
    });

    it("matches the audit actor the account id becomes", async () => {
      // `HUMAN_ACTOR` allows no colon, so the BFF writes the id as
      // `712020.b836c135-…@banka.local` and it is that string which comes back
      // on the decision (`apps/bff/src/actor.ts`).
      const stub = stubFetch([{ body: cloudGroup }]);
      await expect(
        port(stub).verifyMembership("712020.b836c135-c9d3-499a-a665-aed43d362cfd@banka.local", "po"),
      ).resolves.toBe(true);
    });

    it("still denies an account id that is not in the group", async () => {
      const stub = stubFetch([{ body: cloudGroup }]);
      await expect(port(stub).verifyMembership("712020.deadbeef@banka.local", "po")).resolves.toBe(
        false,
      );
    });
  });

  it("walks all member pages before denying", async () => {
    const firstPage = {
      maxResults: 2,
      startAt: 0,
      total: 3,
      isLast: false,
      values: [{ name: "a.user", key: "JIRAUSER1" }, { name: "b.user", key: "JIRAUSER2" }],
    };
    const secondPage = { maxResults: 2, startAt: 2, total: 3, isLast: true, values: [{ name: "selin.arslan" }] };
    const stub = stubFetch([{ body: firstPage }, { body: secondPage }]);

    await expect(port(stub).verifyMembership("selin.arslan", "tech-leads")).resolves.toBe(true);
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[1]!.url).toContain("startAt=2");
  });

  // O-1: displayName comes from LDAP, is not unique and changes. Matching on
  // it would hand gate authority to a namesake.
  it("never matches a member on the display name", async () => {
    const page = {
      isLast: true,
      total: 1,
      values: [{ name: "selin.arslan", key: "JIRAUSER10344", displayName: "Mert Demir" }],
    };
    const stub = stubFetch([{ body: page }]);
    await expect(port(stub).verifyMembership("mert demir", "tech-leads")).resolves.toBe(false);
  });

  // O-2: the server is asked to exclude inactive users, but the gate must not
  // depend on it — an off-boarded approver stays out either way (M32).
  it("skips members the payload marks inactive", async () => {
    const page = {
      isLast: true,
      total: 1,
      values: [{ name: "ayrilmis.calisan", key: "JIRAUSER10500", active: false }],
    };
    const stub = stubFetch([{ body: page }]);
    await expect(port(stub).verifyMembership("ayrilmis.calisan", "tech-leads")).resolves.toBe(false);
  });

  // O-6: a silent `false` here reads exactly like "not a member", so a real
  // approver would be turned away with nothing to debug.
  it("raises instead of denying when a page bean cannot be reasoned about", async () => {
    const stub = stubFetch([{ body: { values: [{ name: "a.user" }] } }]);
    const error = await port(stub)
      .verifyMembership("selin.arslan", "tech-leads")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(JiraMembershipUnresolvedError);
    expect((error as JiraMembershipUnresolvedError).reason).toBe("incomplete_page_bean");
  });

  it("raises instead of denying when the group outgrows the page budget", async () => {
    const page = { isLast: false, total: 100_000, values: [{ name: "a.user" }] };
    const stub = stubFetch(Array.from({ length: 40 }, () => ({ body: page })));
    const error = await port(stub)
      .verifyMembership("selin.arslan", "tech-leads")
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(JiraMembershipUnresolvedError);
    expect((error as JiraMembershipUnresolvedError).reason).toBe("too_many_pages");
    expect(stub.calls).toHaveLength(40);
  });

  it("verifies webhook signatures with the injected secret", async () => {
    const raw = JSON.stringify(fixture("webhook-comment-created"));
    const jira = port(stubFetch([]));

    const headers = (secret: string) => ({ "X-Hub-Signature": signWebhookBody(raw, secret) });
    await expect(jira.verifyWebhook(raw, headers(SECRET))).resolves.toBeUndefined();
    await expect(jira.verifyWebhook(raw, headers("wrong"))).rejects.toThrow(/verification failed/);
    // header lookup is case-insensitive, and a missing header is fail-closed
    await expect(
      jira.verifyWebhook(raw, { "x-hub-signature": signWebhookBody(raw, SECRET) }),
    ).resolves.toBeUndefined();
    await expect(jira.verifyWebhook(raw, {})).rejects.toThrow();
  });

  it("parses commands out of verified payloads and never throws on unknown ones", async () => {
    const jira = port(stubFetch([]));
    const envelope = await jira.parseCommand(fixture("webhook-comment-created"));
    expect(envelope).toMatchObject({ ticketKey: "UGURPAY-501", command: { name: "approve" } });

    const payload = fixture("webhook-comment-created") as { comment: { body: string } };
    payload.comment.body = "/deploy-prod hemen";
    await expect(jira.parseCommand(payload)).resolves.toBeNull();
    expect(jira.parseCommandDetailed(payload).invalid).toMatchObject({ messageKey: "command.unknown" });
    await expect(jira.parseCommand(fixture("webhook-issue-created"))).resolves.toBeNull();
  });

  it("refuses an approval smuggled behind extra text or an edit", async () => {
    const jira = port(stubFetch([]));

    const negated = fixture("webhook-comment-created") as { comment: { body: string } };
    negated.comment.body = "/approve etmiyorum, reddediyorum";
    await expect(jira.parseCommand(negated)).resolves.toBeNull();
    expect(jira.parseCommandDetailed(negated).invalid).toMatchObject({
      messageKey: "command.takes_no_argument",
    });

    const edited = fixture("webhook-comment-created") as {
      webhookEvent: string;
      comment: { updateAuthor: { name: string }; updated: string };
    };
    edited.webhookEvent = "comment_updated";
    edited.comment.updateAuthor = { name: "kotu.niyetli" };
    edited.comment.updated = "2026-08-08T14:40:00.000+0300";
    await expect(jira.parseCommand(edited)).resolves.toBeNull();
  });

  it("does not implement workflow transitions (M102)", async () => {
    await expect(port(stubFetch([])).transition("UGURPAY-501", "31")).rejects.toBeInstanceOf(
      CapabilityNotSupportedError,
    );
  });
});
