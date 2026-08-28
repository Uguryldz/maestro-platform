import { TicketSnapshot } from "@maestro/contracts";
import { CapabilityNotSupportedError } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import {
  doc,
  type FetchLike,
  heading,
  JiraArgumentError,
  JiraCloudConfig,
  JiraCloudWorkPort,
  JiraConfigError,
  JiraLinkFailedError,
  JiraMembershipUnresolvedError,
  JiraResponseError,
  JiraWebhookVerificationError,
  paragraph,
  sanitizeAttachmentFilename,
  signWebhookBody,
} from "../../src/index.js";
import { fixture, stubFetch, type FetchStub } from "../helpers.js";

const ACCOUNT_ID = "712020:7ee7a2ab-23e7-47aa-a61e-38b79b7eb4d1";

const config = JiraCloudConfig.parse({
  baseUrl: "https://uyildiz.atlassian.net",
  email: "pilot@bank.example",
  apiTokenRef: "kv/jira-cloud/token",
});

function port(stub: FetchStub): JiraCloudWorkPort {
  return new JiraCloudWorkPort({ config, token: () => "api-token-123", fetchImpl: stub.fetchImpl });
}

describe("JiraCloudWorkPort", () => {
  it("reads a ticket over REST v3 and returns a contract-valid snapshot", async () => {
    const stub = stubFetch([{ body: fixture("cloud/issue-get") }]);
    const snapshot = await port(stub).getTicket("OPS-6");

    expect(TicketSnapshot.parse(snapshot).key).toBe("OPS-6");
    expect(snapshot.description).toContain("makbuz gönderen");
    expect(stub.calls[0]!.url).toContain("/rest/api/3/issue/OPS-6?fields=");
    expect(stub.calls[0]!.headers["authorization"]).toMatch(/^Basic /);
  });

  it("rejects a malformed issue key before touching the network", async () => {
    const stub = stubFetch([]);
    await expect(port(stub).getTicket("not-a-key")).rejects.toBeInstanceOf(JiraArgumentError);
    expect(stub.calls).toHaveLength(0);
  });

  it("posts a plain string comment wrapped in ADF (v3 speaks ADF natively)", async () => {
    const stub = stubFetch([{ status: 201, body: fixture("cloud/comment-created-response") }]);
    const res = await port(stub).addComment("OPS-6", "durum: analiz hazır");

    expect(res.commentId).toBe("10000");
    expect(stub.calls[0]!.url).toBe("https://uyildiz.atlassian.net/rest/api/3/issue/OPS-6/comment");
    expect(stub.calls[0]!.body).toEqual({
      body: { type: "doc", version: 1, content: [{ type: "paragraph", content: [{ type: "text", text: "durum: analiz hazır" }] }] },
    });
  });

  it("posts an ADF document verbatim — no wiki-markup rendering", async () => {
    const stub = stubFetch([{ status: 201, body: fixture("cloud/comment-created-response") }]);
    const document = doc(heading(2, "Analiz hazır"), paragraph("Kapsam uygun."));
    await port(stub).addComment("OPS-6", document);

    expect(stub.calls[0]!.body).toEqual({ body: document });
  });

  it("edits the progress comment in place with an ADF body (M75)", async () => {
    const stub = stubFetch([{ body: fixture("cloud/comment-created-response") }]);
    await port(stub).updateComment("OPS-6", "10000", "▶ Maestro durum: adım 6a");

    expect(stub.calls[0]!.method).toBe("PUT");
    expect(stub.calls[0]!.url).toBe("https://uyildiz.atlassian.net/rest/api/3/issue/OPS-6/comment/10000");
  });

  it("fails loudly when a comment write answers without an id", async () => {
    const stub = stubFetch([{ status: 201, body: { self: "https://x" } }]);
    await expect(port(stub).addComment("OPS-6", "x")).rejects.toBeInstanceOf(JiraResponseError);
  });

  it("edits labels as a diff — only the add/remove delta goes out", async () => {
    const stub = stubFetch([{ body: { fields: { labels: ["maestro", "eski"] } } }, { status: 204 }]);
    await port(stub).setLabels("OPS-6", ["maestro", "yeni"]);

    expect(stub.calls[0]!.method).toBe("GET");
    expect(stub.calls[0]!.url).toContain("/rest/api/3/issue/OPS-6?fields=labels");
    expect(stub.calls[1]!.method).toBe("PUT");
    expect(stub.calls[1]!.url).toBe("https://uyildiz.atlassian.net/rest/api/3/issue/OPS-6");
    expect(stub.calls[1]!.body).toEqual({ update: { labels: [{ add: "yeni" }, { remove: "eski" }] } });
  });

  it("skips the write entirely when the labels already match", async () => {
    const stub = stubFetch([{ body: { fields: { labels: ["maestro"] } } }]);
    await port(stub).setLabels("OPS-6", ["maestro"]);
    expect(stub.calls).toHaveLength(1); // just the read
  });

  it("refuses labels Jira would reject, before any request", async () => {
    const stub = stubFetch([]);
    await expect(port(stub).setLabels("OPS-6", ["iki kelime"])).rejects.toThrow(/whitespace/);
    await expect(port(stub).setLabels("OPS-6", [" "])).rejects.toBeInstanceOf(JiraArgumentError);
    expect(stub.calls).toHaveLength(0);
  });

  it("assigns and unassigns via accountId — Cloud has no usernames", async () => {
    const stub = stubFetch([{ status: 204 }, { status: 204 }]);
    const jira = port(stub);
    await jira.assign("OPS-6", ACCOUNT_ID);
    await jira.assign("OPS-6", null);

    expect(stub.calls[0]!.url).toBe("https://uyildiz.atlassian.net/rest/api/3/issue/OPS-6/assignee");
    expect(stub.calls[0]!.body).toEqual({ accountId: ACCOUNT_ID });
    expect(stub.calls[1]!.body).toEqual({ accountId: null });
  });

  it("creates a fan-out child with an ADF description and links it back", async () => {
    const stub = stubFetch([{ status: 201, body: { id: "10020", key: "OPS-9" } }, { status: 201, body: {} }]);
    const res = await port(stub).createLinkedIssue("OPS-6", {
      summary: "iOS tarafı",
      description: "OPS-6 fan-out çocuğu",
      labels: ["maestro"],
    });

    expect(res.key).toBe("OPS-9");
    expect(stub.calls[0]!.url).toBe("https://uyildiz.atlassian.net/rest/api/3/issue");
    expect(stub.calls[0]!.body).toEqual({
      fields: {
        project: { key: "OPS" },
        summary: "iOS tarafı",
        description: {
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: "OPS-6 fan-out çocuğu" }] }],
        },
        issuetype: { name: "Task" },
        labels: ["maestro"],
      },
    });
    expect(stub.calls[1]!.url).toBe("https://uyildiz.atlassian.net/rest/api/3/issueLink");
    expect(stub.calls[1]!.body).toEqual({
      type: { name: "Relates" },
      inwardIssue: { key: "OPS-9" },
      outwardIssue: { key: "OPS-6" },
    });
  });

  it("creates a child issue ASSIGNED to the bot when assigneeAccountId is given", async () => {
    const stub = stubFetch([{ status: 201, body: { id: "10021", key: "OPS-10" } }]);
    const res = await port(stub).createChildIssue({
      projectKey: "OPS",
      parentKey: "OPS-6",
      summary: "[mobil] fan-out",
      description: "OPS-6 analizinden türetildi.",
      assigneeAccountId: ACCOUNT_ID,
    });

    expect(res.key).toBe("OPS-10");
    const fields = (stub.calls[0]!.body as { fields: Record<string, unknown> }).fields;
    // Cloud's create-issue API addresses the assignee as `{ id }` (v3).
    expect(fields["assignee"]).toEqual({ id: ACCOUNT_ID });
    expect(fields["parent"]).toEqual({ key: "OPS-6" });
  });

  it("omits the assignee entirely when assigneeAccountId is absent or blank", async () => {
    const stub = stubFetch([
      { status: 201, body: { id: "10022", key: "OPS-11" } },
      { status: 201, body: { id: "10023", key: "OPS-12" } },
    ]);
    const jira = port(stub);
    await jira.createChildIssue({ projectKey: "OPS", parentKey: "OPS-6", summary: "çocuk" });
    await jira.createChildIssue({
      projectKey: "OPS",
      parentKey: "OPS-6",
      summary: "çocuk",
      assigneeAccountId: "   ",
    });

    for (const call of stub.calls) {
      const fields = (call.body as { fields: Record<string, unknown> }).fields;
      expect(fields).not.toHaveProperty("assignee");
    }
  });

  it("refuses fan-out labels Jira would reject, before any request", async () => {
    const stub = stubFetch([]);
    await expect(
      port(stub).createLinkedIssue("OPS-6", { summary: "x", description: "y", labels: ["iki kelime"] }),
    ).rejects.toThrow(/whitespace/);
    await expect(
      port(stub).createLinkedIssue("OPS-6", { summary: "x", description: "y", labels: [" "] }),
    ).rejects.toBeInstanceOf(JiraArgumentError);
    expect(stub.calls).toHaveLength(0); // no half-created, unlabeled child
  });

  it("keeps the orphan key when linking the child fails", async () => {
    const stub = stubFetch([{ status: 201, body: { id: "10020", key: "OPS-9" } }, { status: 404, body: {} }]);
    const error = await port(stub)
      .createLinkedIssue("OPS-6", { summary: "x", description: "y" })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(JiraLinkFailedError);
    expect((error as JiraLinkFailedError).childKey).toBe("OPS-9");
  });

  it("verifies membership by accountId or e-mail, never displayName", async () => {
    const page = {
      isLast: true,
      values: [
        { accountId: "712020:other", emailAddress: "other@bank.example", displayName: "Uğur Yıldız", active: true },
        { accountId: ACCOUNT_ID, displayName: "Approver", active: true },
      ],
    };
    const stub = stubFetch([{ body: page }, { body: page }, { body: page }]);
    const jira = port(stub);

    await expect(jira.verifyMembership(ACCOUNT_ID, "gate-approvers")).resolves.toBe(true);
    await expect(jira.verifyMembership("other@bank.example", "gate-approvers")).resolves.toBe(true);
    await expect(jira.verifyMembership("Uğur Yıldız", "gate-approvers")).resolves.toBe(false);
    expect(stub.calls[0]!.url).toContain("/rest/api/3/group/member?groupname=gate-approvers");
  });

  it("parses membership against the recorded live group/member shape", async () => {
    // Real 200 from uyildiz.atlassian.net (groupname param — groupId returns 404
    // on Cloud). Pins the parser to the shape the site actually returns rather
    // than a hand-written stub: {self,maxResults,startAt,total,isLast,values[]}.
    const real = fixture("cloud/group-member-by-name") as {
      values: Array<{ accountId: string }>;
    };
    const present = real.values[0]!.accountId;

    const hit = stubFetch([{ body: real }]);
    await expect(port(hit).verifyMembership(present, "jira-users-uyildiz")).resolves.toBe(true);
    expect(hit.calls[0]!.url).toContain("groupname=jira-users-uyildiz");

    const miss = stubFetch([{ body: real }]);
    await expect(
      port(miss).verifyMembership("712020:nobody-here", "jira-users-uyildiz"),
    ).resolves.toBe(false);
  });

  /**
   * Found live on OPS-36, against this same group.
   *
   * A gate decision does not carry a Jira identifier — it carries an AUDIT
   * actor. `HUMAN_ACTOR` allows no colon, so the BFF rewrites `712020:b836…`
   * as `712020.b836…@<domain>` before the trail will accept it
   * (`apps/bff/src/actor.ts`), and that string is what comes back. Matched
   * against a raw `accountId` it never equals — so an approver who was in the
   * group all along was refused as "üyelik doğrulanamadı", twice, with the
   * gate left open.
   */
  it("matches the audit actor an accountId becomes", async () => {
    const real = fixture("cloud/group-member-by-name") as {
      values: Array<{ accountId: string }>;
    };
    const accountId = real.values[0]!.accountId;
    const asActor = `${accountId.replace(/:/gu, ".")}@banka.local`;

    const hit = stubFetch([{ body: real }]);
    await expect(port(hit).verifyMembership(asActor, "jira-users-uyildiz")).resolves.toBe(true);

    // The rewrite must not become a way in for someone who is not a member.
    const miss = stubFetch([{ body: real }]);
    await expect(
      port(miss).verifyMembership("712020.nobody-here@banka.local", "jira-users-uyildiz"),
    ).resolves.toBe(false);
  });

  it("skips inactive members and pages until isLast", async () => {
    const inactive = { accountId: ACCOUNT_ID, active: false };
    const stub = stubFetch([
      { body: { isLast: false, values: [inactive] } },
      { body: { isLast: true, values: [{ accountId: ACCOUNT_ID, active: true }] } },
    ]);

    await expect(port(stub).verifyMembership(ACCOUNT_ID, "gate-approvers")).resolves.toBe(true);
    expect(stub.calls).toHaveLength(2);
    expect(new URL(stub.calls[1]!.url).searchParams.get("startAt")).toBe("1");
  });

  it("raises instead of silently denying on an undecidable member page", async () => {
    const stub = stubFetch([{ body: { values: [{ accountId: "712020:other" }] } }]);
    await expect(port(stub).verifyMembership(ACCOUNT_ID, "gate-approvers")).rejects.toBeInstanceOf(
      JiraMembershipUnresolvedError,
    );
  });

  it("raises on a page that claims more members but carries none — no silent deny", async () => {
    const contradictory = stubFetch([{ body: { isLast: false, values: [] } }]);
    const error = await port(contradictory)
      .verifyMembership(ACCOUNT_ID, "gate-approvers")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JiraMembershipUnresolvedError);
    expect((error as JiraMembershipUnresolvedError).reason).toBe("contradictory_page");

    // …while a legitimately empty last page still answers false, not an error.
    const emptyGroup = stubFetch([{ body: { isLast: true, values: [] } }]);
    await expect(port(emptyGroup).verifyMembership(ACCOUNT_ID, "gate-approvers")).resolves.toBe(false);
  });

  it("lists an issue's comments from the recorded page shape", async () => {
    const stub = stubFetch([{ body: fixture("cloud/comments-list") }]);
    const comments = await port(stub).listComments("OPS-6");

    expect(comments).toHaveLength(1);
    expect(stub.calls[0]!.url).toContain("/rest/api/3/issue/OPS-6/comment");
  });

  it("lists assignee changes from the changelog (iş atama usulü onayı)", async () => {
    const stub = stubFetch([
      {
        body: {
          values: [
            {
              id: "500",
              created: "2026-08-15T01:00:00.000+0300",
              author: { accountId: "712020:manager" },
              items: [
                { field: "status", from: "1", to: "2" },
                { field: "assignee", from: "712020:manager", to: "712020:bot" },
              ],
            },
            {
              id: "501",
              created: "2026-08-15T01:05:00.000+0300",
              author: { accountId: "712020:someone" },
              items: [{ field: "assignee", from: "712020:bot", to: null }],
            },
            {
              id: "502",
              created: "2026-08-15T01:10:00.000+0300",
              author: { accountId: "712020:other" },
              items: [{ field: "summary", fromString: "a", toString: "b" }], // atama değil → düşer
            },
          ],
        },
      },
    ]);
    const changes = await port(stub).listAssigneeChanges("OPS-6");

    expect(stub.calls[0]!.url).toContain("/rest/api/3/issue/OPS-6/changelog");
    expect(changes).toEqual([
      { id: "500", actorAccountId: "712020:manager", toAccountId: "712020:bot", at: "2026-08-15T01:00:00.000+0300" },
      { id: "501", actorAccountId: "712020:someone", toAccountId: null, at: "2026-08-15T01:05:00.000+0300" },
    ]);
  });

  it("parses a command from a polled comment through the port", async () => {
    const stub = stubFetch([]);
    const comment = {
      author: { accountId: ACCOUNT_ID },
      body: doc(paragraph("/approve")),
      created: "2026-08-10T15:00:00.000+0300",
      updated: "2026-08-10T15:00:00.000+0300",
    };

    const envelope = await port(stub).parseCommand({ ticketKey: "OPS-6", comment });
    expect(envelope?.command).toEqual({ name: "approve" });
    expect(envelope?.author).toBe(ACCOUNT_ID);
  });

  it("delegates searchIssues with the bounded-JQL guard intact", async () => {
    const stub = stubFetch([{ body: fixture("cloud/search-jql") }]);
    const jira = port(stub);

    await expect(jira.searchIssues({ jql: "order by created" })).rejects.toBeInstanceOf(JiraArgumentError);
    const page = await jira.searchIssues({ jql: "project = OPS" });
    expect(page.issues).toHaveLength(6);
  });

  // ------------------------------------------------------- webhook signatures
  //
  // Jira Cloud signs a registered webhook with HMAC-SHA256 over the RAW body
  // and sends `X-Hub-Signature: sha256=<hex>`. Every case below is offline —
  // the fixture is signed here, no network call is made.

  const WEBHOOK_SECRET = "G8j4166a5OkXRD4WbqV3";

  /** A driver that HAS a webhook secret, i.e. a site with a registered hook. */
  function signedPort(secret: string = WEBHOOK_SECRET): JiraCloudWorkPort {
    return new JiraCloudWorkPort({
      config,
      token: () => "api-token-123",
      webhookSecret: () => secret,
      fetchImpl: stubFetch([]).fetchImpl,
    });
  }

  /** A live-shaped `jira:issue_created` delivery — the body Jira signs. */
  const CREATED_BODY = JSON.stringify({
    webhookEvent: "jira:issue_created",
    issue: { key: "OPS-42", fields: { labels: ["maestro"], status: { name: "Görev" } } },
  });

  it("accepts a delivery signed with the registered secret", async () => {
    const signature = signWebhookBody(CREATED_BODY, WEBHOOK_SECRET);

    await expect(
      signedPort().verifyWebhook(CREATED_BODY, { "X-Hub-Signature": signature }),
    ).resolves.toBeUndefined();
  });

  it("reads the signature header case-insensitively, as Node lower-cases it", async () => {
    const signature = signWebhookBody(CREATED_BODY, WEBHOOK_SECRET);

    await expect(
      signedPort().verifyWebhook(CREATED_BODY, { "x-hub-signature": signature }),
    ).resolves.toBeUndefined();
  });

  it("verifies over the RAW bytes — a re-serialised body no longer matches", async () => {
    const signature = signWebhookBody(CREATED_BODY, WEBHOOK_SECRET);
    const reserialised = JSON.stringify(JSON.parse(CREATED_BODY), null, 2);

    await expect(
      signedPort().verifyWebhook(reserialised, { "x-hub-signature": signature }),
    ).rejects.toBeInstanceOf(JiraWebhookVerificationError);
  });

  it("refuses a forged, altered or absent signature — fail-closed on every path", async () => {
    const signature = signWebhookBody(CREATED_BODY, WEBHOOK_SECRET);
    const cases: Array<[string, Record<string, string>, string]> = [
      ["signed with another secret", { "x-hub-signature": signWebhookBody(CREATED_BODY, "attacker") }, "mismatch"],
      ["no signature header at all", {}, "missing_signature"],
      ["a blank header", { "x-hub-signature": "   " }, "missing_signature"],
      ["a non-hex digest", { "x-hub-signature": "sha256=not-hex" }, "malformed_signature"],
    ];

    for (const [why, headers, reason] of cases) {
      const error = await signedPort()
        .verifyWebhook(CREATED_BODY, headers)
        .then(() => null, (e: unknown) => e);
      expect(error, why).toBeInstanceOf(JiraWebhookVerificationError);
      expect((error as Error).message, why).toContain(reason);
    }

    // A body tampered with after signing must not verify either.
    await expect(
      signedPort().verifyWebhook(`${CREATED_BODY} `, { "x-hub-signature": signature }),
    ).rejects.toBeInstanceOf(JiraWebhookVerificationError);
  });

  it("REFUSES when no webhook secret is configured — absent never means 'skip the check'", async () => {
    const stub = stubFetch([]);
    const error = await port(stub)
      .verifyWebhook(CREATED_BODY, { "x-hub-signature": signWebhookBody(CREATED_BODY, WEBHOOK_SECRET) })
      .then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(JiraWebhookVerificationError);
    expect((error as Error).message).toContain("missing_secret");
    // Specifically NOT the old capability refusal: the BFF maps that to a
    // different failure, and an unconfigured platform is not a missing feature.
    expect(error).not.toBeInstanceOf(CapabilityNotSupportedError);
  });

  it("refuses when the secret resolves to an empty string", async () => {
    const error = await signedPort("")
      .verifyWebhook(CREATED_BODY, { "x-hub-signature": signWebhookBody(CREATED_BODY, "") })
      .then(() => null, (e: unknown) => e);

    expect(error).toBeInstanceOf(JiraWebhookVerificationError);
    expect((error as Error).message).toContain("missing_secret");
  });

  it("moves the issue by transition id through the port's own transition()", async () => {
    const stub = stubFetch([{ status: 204 }]);
    await port(stub).transition("OPS-6", "31");

    expect(stub.calls[0]!.method).toBe("POST");
    expect(stub.calls[0]!.url).toBe("https://uyildiz.atlassian.net/rest/api/3/issue/OPS-6/transitions");
    expect(stub.calls[0]!.body).toEqual({ transition: { id: "31" } });
  });

  // ------------------------------------------------- return-to-reporter (İADE)

  /** A live-shaped GET /issue/{key}/transitions body — id, name, destination + category. */
  function transitionsBody(): unknown {
    return {
      transitions: [
        { id: "21", name: "İncelemeye al", to: { id: "10001", name: "İNCELEMEDE", statusCategory: { key: "indeterminate", name: "In Progress" } } },
        { id: "11", name: "Geri al", to: { id: "10000", name: "Yapılacaklar", statusCategory: { key: "new", name: "To Do" } } },
        { id: "31", name: "Bitir", to: { id: "10002", name: "Tamam", statusCategory: { key: "done", name: "Done" } } },
      ],
    };
  }

  it("reads available transitions with each destination's status category", async () => {
    const stub = stubFetch([{ body: transitionsBody() }]);
    const rows = await port(stub).readAvailableTransitions("OPS-6");

    expect(stub.calls[0]!.method).toBe("GET");
    expect(stub.calls[0]!.url).toBe("https://uyildiz.atlassian.net/rest/api/3/issue/OPS-6/transitions");
    const todo = rows.find((r) => r.toCategoryKey === "new");
    expect(todo).toMatchObject({ id: "11", toStatusName: "Yapılacaklar", toCategoryName: "To Do" });
  });

  it("applies a transition by id via POST /transitions (204)", async () => {
    const stub = stubFetch([{ status: 204 }]);
    await port(stub).applyTransition("OPS-6", "11");

    expect(stub.calls[0]!.method).toBe("POST");
    expect(stub.calls[0]!.url).toBe("https://uyildiz.atlassian.net/rest/api/3/issue/OPS-6/transitions");
    expect(stub.calls[0]!.body).toEqual({ transition: { id: "11" } });
  });

  it("rejects an empty transition id before the network", async () => {
    const stub = stubFetch([]);
    await expect(port(stub).applyTransition("OPS-6", "  ")).rejects.toBeInstanceOf(JiraArgumentError);
    expect(stub.calls).toHaveLength(0);
  });

  it("returns a ticket to its reporter: reassign, then the To-Do transition (chosen by category, not name)", async () => {
    // (1) assign 204, (2) GET transitions, (3) POST the chosen To-Do transition 204.
    const stub = stubFetch([{ status: 204 }, { body: transitionsBody() }, { status: 204 }]);
    const result = await port(stub).returnToReporter("OPS-6", ACCOUNT_ID);

    expect(result).toEqual({
      assigned: true,
      transitioned: true,
      transition: {
        id: "11",
        name: "Geri al",
        toStatusId: "10000",
        toStatusName: "Yapılacaklar",
        toCategoryKey: "new",
        toCategoryName: "To Do",
      },
    });
    // reassign to the reporter's accountId
    expect(stub.calls[0]!.url).toBe("https://uyildiz.atlassian.net/rest/api/3/issue/OPS-6/assignee");
    expect(stub.calls[0]!.body).toEqual({ accountId: ACCOUNT_ID });
    // the applied transition is the To-Do one (id 11), NOT "İncelemeye al" (21)
    expect(stub.calls[2]!.body).toEqual({ transition: { id: "11" } });
  });

  it("returns cleanly with transitioned:false when no To-Do transition is offered (already in backlog)", async () => {
    const onlyForward = {
      transitions: [
        { id: "21", name: "İncelemeye al", to: { id: "10001", name: "İNCELEMEDE", statusCategory: { key: "indeterminate", name: "In Progress" } } },
      ],
    };
    // assign 204, GET transitions — no POST, since nothing To-Do to apply.
    const stub = stubFetch([{ status: 204 }, { body: onlyForward }]);
    const result = await port(stub).returnToReporter("OPS-6", ACCOUNT_ID);

    expect(result).toEqual({ assigned: true, transitioned: false, transition: null });
    expect(stub.calls).toHaveLength(2); // no transition POST
  });

  // ------------------------------------------------- send-to-review (onay devri)

  it("sends a ticket to review: reassign to the manager, then the İNCELEMEDE transition (name-first)", async () => {
    // (1) assign 204, (2) GET transitions, (3) POST the chosen review transition 204.
    const stub = stubFetch([{ status: 204 }, { body: transitionsBody() }, { status: 204 }]);
    const result = await port(stub).sendToReview("OPS-6", ACCOUNT_ID);

    expect(result).toEqual({
      assigned: true,
      transitioned: true,
      transition: {
        id: "21",
        name: "İncelemeye al",
        toStatusId: "10001",
        toStatusName: "İNCELEMEDE",
        toCategoryKey: "indeterminate",
        toCategoryName: "In Progress",
      },
    });
    // reassign to the manager's accountId
    expect(stub.calls[0]!.url).toBe("https://uyildiz.atlassian.net/rest/api/3/issue/OPS-6/assignee");
    expect(stub.calls[0]!.body).toEqual({ accountId: ACCOUNT_ID });
    // the applied transition is the İNCELEMEDE one (id 21), matched by NAME even
    // though a category-blind pick would also see "Devam Ediyor"-style edges.
    expect(stub.calls[2]!.body).toEqual({ transition: { id: "21" } });
  });

  it("falls back to the In-Progress category when the review status name is not matched", async () => {
    // A workflow whose review column was renamed away from "İNCELEMEDE": only an
    // In-Progress edge under a different name is offered. Selection must still find
    // it by CATEGORY (indeterminate), and NOT pick the To-Do edge.
    const renamed = {
      transitions: [
        { id: "11", name: "Geri al", to: { id: "10000", name: "Yapılacaklar", statusCategory: { key: "new", name: "To Do" } } },
        { id: "25", name: "İncele", to: { id: "10005", name: "Gözden Geçir", statusCategory: { key: "indeterminate", name: "In Progress" } } },
      ],
    };
    const stub = stubFetch([{ status: 204 }, { body: renamed }, { status: 204 }]);
    const result = await port(stub).sendToReview("OPS-6", ACCOUNT_ID);

    expect(result.transitioned).toBe(true);
    expect(result.transition?.toStatusName).toBe("Gözden Geçir");
    expect(stub.calls[2]!.body).toEqual({ transition: { id: "25" } });
  });

  it("sends to review with transitioned:false when no In-Progress transition is offered", async () => {
    const onlyDone = {
      transitions: [
        { id: "31", name: "Bitir", to: { id: "10002", name: "Tamam", statusCategory: { key: "done", name: "Done" } } },
      ],
    };
    // assign 204, GET transitions — no POST, since nothing In-Progress to apply.
    const stub = stubFetch([{ status: 204 }, { body: onlyDone }]);
    const result = await port(stub).sendToReview("OPS-6", ACCOUNT_ID);

    expect(result).toEqual({ assigned: true, transitioned: false, transition: null });
    expect(stub.calls).toHaveLength(2); // no transition POST
  });

  it("rejects an empty manager accountId before the network", async () => {
    const stub = stubFetch([]);
    await expect(port(stub).sendToReview("OPS-6", "   ")).rejects.toBeInstanceOf(JiraArgumentError);
    expect(stub.calls).toHaveLength(0); // no assign, no half-done handover
  });

  // -------------------------------------------------- transitionToStatus (by name)

  /** A `fields=status` read — what the "already there?" short-circuit reads. */
  function statusBody(name: string): unknown {
    return { fields: { status: { id: "10004", name, statusCategory: { key: "new", name: "Yapılacaklar" } } } };
  }

  /**
   * The LIVE OPS shape: the transition's own name and its destination status name
   * genuinely differ (id 31 is "In Review" but lands on "İNCELEMEDE"), which is
   * precisely why a caller must not hard-code ids or assume the two names agree.
   */
  function liveTransitionsBody(): unknown {
    return {
      transitions: [
        { id: "11", name: "Yapılacaklar", to: { id: "10004", name: "Yapılacaklar", statusCategory: { key: "new", name: "To Do" } } },
        { id: "21", name: "Devam Ediyor", to: { id: "10005", name: "Devam Ediyor", statusCategory: { key: "indeterminate", name: "In Progress" } } },
        { id: "31", name: "In Review", to: { id: "10001", name: "İNCELEMEDE", statusCategory: { key: "indeterminate", name: "In Progress" } } },
        { id: "41", name: "Tamam", to: { id: "10002", name: "Tamam", statusCategory: { key: "done", name: "Done" } } },
      ],
    };
  }

  it("moves to a status matched on the DESTINATION status name, not the transition name", async () => {
    // status read → transitions read → POST. The destination "İNCELEMEDE" is
    // reached by transition 31, whose own name ("In Review") is something else.
    const stub = stubFetch([{ body: statusBody("Yapılacaklar") }, { body: liveTransitionsBody() }, { status: 204 }]);
    const result = await port(stub).transitionToStatus("OPS-6", "İNCELEMEDE");

    expect(result).toEqual({ moved: true });
    expect(stub.calls[0]!.url).toContain("/rest/api/3/issue/OPS-6?fields=status");
    expect(stub.calls[2]!.method).toBe("POST");
    expect(stub.calls[2]!.body).toEqual({ transition: { id: "31" } });
  });

  it("falls back to the TRANSITION name when no destination status matches", async () => {
    // "In Review" names no destination status here — only transition 31 — so the
    // second pass must find it rather than reporting no_transition.
    const stub = stubFetch([{ body: statusBody("Yapılacaklar") }, { body: liveTransitionsBody() }, { status: 204 }]);
    const result = await port(stub).transitionToStatus("OPS-6", "In Review");

    expect(result).toEqual({ moved: true });
    expect(stub.calls[2]!.body).toEqual({ transition: { id: "31" } });
  });

  it("matches the Turkish dotted İ against every casing a caller might write", async () => {
    // The trap: plain toLowerCase() leaves "İ" as i+combining-dot and
    // toLocaleLowerCase("tr") maps "I" onto "ı" — either alone fails one of these.
    for (const spelling of ["İNCELEMEDE", "İncelemede", "incelemede", "InCeLeMeDe", "ıncelemede"]) {
      const stub = stubFetch([{ body: statusBody("Yapılacaklar") }, { body: liveTransitionsBody() }, { status: 204 }]);
      const result = await port(stub).transitionToStatus("OPS-6", spelling);

      expect(result, `spelling: ${spelling}`).toEqual({ moved: true });
      expect(stub.calls[2]!.body).toEqual({ transition: { id: "31" } });
    }
  });

  it("is idempotent: an issue already in the status is not POSTed again", async () => {
    // Only the status read happens — no transitions read, no write. A retried
    // workflow step must not re-POST a move Jira already made.
    const stub = stubFetch([{ body: statusBody("İNCELEMEDE") }]);
    const result = await port(stub).transitionToStatus("OPS-6", "İncelemede");

    expect(result).toEqual({ moved: false, reason: "already" });
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("reports no_transition instead of throwing when the workflow offers no such move", async () => {
    const stub = stubFetch([{ body: statusBody("Yapılacaklar") }, { body: liveTransitionsBody() }]);
    const result = await port(stub).transitionToStatus("OPS-6", "Buzdolabında");

    expect(result).toEqual({ moved: false, reason: "no_transition" });
    expect(stub.calls).toHaveLength(2); // read, read — no write
  });

  it("reports forbidden instead of throwing when Jira answers 403 on the move", async () => {
    // The service account may browse the issue but lacks "Transition Issues".
    const stub = stubFetch([
      { body: statusBody("Yapılacaklar") },
      { body: liveTransitionsBody() },
      { status: 403, body: { errorMessages: ["You do not have permission"] } },
    ]);
    const result = await port(stub).transitionToStatus("OPS-6", "İNCELEMEDE");

    expect(result).toEqual({ moved: false, reason: "forbidden" });
  });

  it("never throws on any other failure — a 5xx becomes a reason, not an exception", async () => {
    const failed = stubFetch([
      { body: statusBody("Yapılacaklar") },
      { body: liveTransitionsBody() },
      { status: 500, body: { errorMessages: ["boom"] } },
    ]);
    await expect(port(failed).transitionToStatus("OPS-6", "İNCELEMEDE")).resolves.toEqual({
      moved: false,
      reason: "transition_failed",
    });

    // A failing READ is reported separately, so the log says whether we never
    // learned the options or could not apply the one we picked.
    const unread = stubFetch([{ status: 404, body: { errorMessages: ["no issue"] } }]);
    await expect(port(unread).transitionToStatus("OPS-6", "İNCELEMEDE")).resolves.toEqual({
      moved: false,
      reason: "read_failed",
    });

    // Even a malformed key is a reason, never a throw — the caller's policy is
    // "warn and continue", and an argument guard that raised would break it.
    const untouched = stubFetch([]);
    await expect(port(untouched).transitionToStatus("not-a-key", "İNCELEMEDE")).resolves.toEqual({
      moved: false,
      reason: "bad_key",
    });
    await expect(port(untouched).transitionToStatus("OPS-6", "  ")).resolves.toEqual({
      moved: false,
      reason: "bad_status_name",
    });
    expect(untouched.calls).toHaveLength(0);
  });

  // ---------------------------------------------------------- addAttachment

  it("posts a multipart attachment to the right URL with the no-check header and Basic token", async () => {
    const cap = captureFetch(fixture("cloud/attachments-created"));
    const jira = new JiraCloudWorkPort({ config, token: () => "api-token-123", fetchImpl: cap.fetchImpl });

    const bytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04]); // "PK.." — a docx/zip magic
    const res = await jira.addAttachment("OPS-6", "OPS-6-analiz.docx", bytes, "application/vnd.x");

    expect(res.ids).toEqual(["10050"]);
    const call = cap.calls[0]!;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://uyildiz.atlassian.net/rest/api/3/issue/OPS-6/attachments");
    // XSRF opt-out required by the Jira Cloud attachment endpoint.
    expect(call.headers["x-atlassian-token"]).toBe("no-check");
    expect(call.headers["authorization"]).toMatch(/^Basic /);
    // We must NOT hand-set content-type: fetch derives the multipart boundary.
    expect(call.headers["content-type"]).toBeUndefined();
    // The body is native FormData carrying a `file` part with the sanitized name.
    expect(call.body).toBeInstanceOf(FormData);
    const file = (call.body as FormData).get("file");
    expect(file).toBeInstanceOf(Blob);
    expect((file as File).name).toBe("OPS-6-analiz.docx");
    expect(await (file as Blob).arrayBuffer()).toEqual(bytes.buffer);
  });

  it("sanitizes a path-traversal / CRLF filename before it reaches the part name", async () => {
    const cap = captureFetch(fixture("cloud/attachments-created"));
    const jira = new JiraCloudWorkPort({ config, token: () => "api-token-123", fetchImpl: cap.fetchImpl });

    await jira.addAttachment("OPS-6", "../../etc/pa\r\nsswd.pdf", new Uint8Array([1]), "application/pdf");

    const file = (cap.calls[0]!.body as FormData).get("file") as File;
    // No directory segments, no CR/LF survive.
    expect(file.name).toBe("passwd.pdf");
    expect(file.name).not.toContain("/");
    expect(file.name).not.toMatch(/[\r\n]/);
  });

  it("cleans the direct helper — traversal, CRLF, and empties fall back to a bare name", () => {
    expect(sanitizeAttachmentFilename("../evil.docx")).toBe("evil.docx");
    expect(sanitizeAttachmentFilename("a\r\nb.pdf")).toBe("ab.pdf");
    expect(sanitizeAttachmentFilename("..")).toBe("attachment");
    expect(sanitizeAttachmentFilename("   ")).toBe("attachment");
    expect(sanitizeAttachmentFilename("C:\\\\Users\\\\x\\\\report.pdf")).toBe("report.pdf");
  });

  it("refuses to upload with an empty resolved token — no silent anonymous POST", async () => {
    const cap = captureFetch(fixture("cloud/attachments-created"));
    const jira = new JiraCloudWorkPort({ config, token: () => "   ", fetchImpl: cap.fetchImpl });
    await expect(jira.addAttachment("OPS-6", "x.pdf", new Uint8Array([1]), "application/pdf")).rejects.toBeInstanceOf(
      JiraConfigError,
    );
    expect(cap.calls).toHaveLength(0);
  });

  it("fails loudly when the upload answers 2xx without an attachment id", async () => {
    const cap = captureFetch([]); // 200 with an empty array
    const jira = new JiraCloudWorkPort({ config, token: () => "api-token-123", fetchImpl: cap.fetchImpl });
    await expect(jira.addAttachment("OPS-6", "x.pdf", new Uint8Array([1]), "application/pdf")).rejects.toBeInstanceOf(
      JiraResponseError,
    );
  });
});

/**
 * A fetch double that records the FormData body verbatim (the shared `stubFetch`
 * only captures string/JSON bodies), so the multipart assertions can reach into
 * the `file` part.
 */
function captureFetch(responseBody: unknown): {
  fetchImpl: FetchLike;
  calls: Array<{ method: string; url: string; headers: Record<string, string>; body: unknown }>;
} {
  const calls: Array<{ method: string; url: string; headers: Record<string, string>; body: unknown }> = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({
      method: init?.method ?? "GET",
      url,
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body: init?.body,
    });
    return Promise.resolve(
      new Response(JSON.stringify(responseBody), { status: 200, headers: { "content-type": "application/json" } }),
    );
  };
  return { fetchImpl, calls };
}
