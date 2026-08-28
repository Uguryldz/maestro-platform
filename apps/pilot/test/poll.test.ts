import { JiraCloudConfig, JiraCloudWorkPort, doc, paragraph } from "@maestro/adapter-jira";
import { describe, expect, it } from "vitest";
import { discoverTickets, markExistingCommentsSeen, pollForCommandOnce } from "../src/poll.js";
import { discoveryJql } from "../src/config.js";
import { cloudFixture, stubFetch, type FetchStub } from "./helpers.js";

/**
 * The poll loop, exercised entirely offline against the recorded Cloud
 * fixtures and injected stub fetches. No network, no live Jira.
 */

const ACCOUNT_ID = "712020:7ee7a2ab-23e7-47aa-a61e-38b79b7eb4d1";

const config = JiraCloudConfig.parse({
  baseUrl: "https://uyildiz.atlassian.net",
  email: "pilot@bank.example",
  apiTokenRef: "kv/jira-cloud/token#value",
});

function port(stub: FetchStub): JiraCloudWorkPort {
  return new JiraCloudWorkPort({ config, token: () => "api-token-123", fetchImpl: stub.fetchImpl });
}

describe("discoverTickets", () => {
  it("returns the bot-assigned OPS tickets from the recorded search page", async () => {
    const stub = stubFetch([{ body: cloudFixture("search-jql") }]);
    const rows = await discoverTickets(port(stub));

    expect(rows.length).toBe(6);
    expect(rows[0]!.key).toBe("OPS-6");
    expect(rows[0]!.summary).toContain("Ödeme Onayı");
    expect(rows[0]!.status).toBe("Yapılacaklar");
    // The default discovery JQL is bounded (project = OPS …) and assignment-based.
    const jql = new URL(stub.calls[0]!.url).searchParams.get("jql")!;
    expect(stub.calls[0]!.url).toContain("/rest/api/3/search/jql");
    expect(jql).toContain("project = OPS");
    expect(jql).toContain("assignee =");
    expect(jql).not.toContain("labels = maestro");
  });

  it("passes the injected assignment JQL through to the endpoint verbatim", async () => {
    const stub = stubFetch([{ body: cloudFixture("search-jql") }]);
    const injected = discoveryJql("712020:b836c135-c9d3-499a-a665-aed43d362cfd");
    await discoverTickets(port(stub), injected);

    const jql = new URL(stub.calls[0]!.url).searchParams.get("jql");
    expect(jql).toBe(injected);
    expect(jql).toContain('assignee = "712020:b836c135-c9d3-499a-a665-aed43d362cfd"');
  });
});

describe("pollForCommandOnce", () => {
  const seen = () => new Set<string>();

  function commentWith(body: unknown, id = "10000", edited = false) {
    return {
      id,
      author: { accountId: ACCOUNT_ID },
      body,
      created: "2026-08-10T15:00:00.000+0300",
      updated: edited ? "2026-08-10T15:05:00.000+0300" : "2026-08-10T15:00:00.000+0300",
    };
  }

  it("markExistingCommentsSeen: gate baseline makes a PRE-EXISTING /approve stale (OPS-15 bug)", async () => {
    // Two polls against the same comment list: the first (baseline) marks the
    // old /approve seen; the actual poll must then find NOTHING — an approval
    // that predates the gate never resolves it.
    const stale = commentWith(doc(paragraph("/approve")), "9001");
    const stub = stubFetch([
      { body: { comments: [stale] } }, // baseline listing
      { body: { comments: [stale] } }, // gate poll
    ]);
    const work = port(stub);
    const gateSeen = seen();
    const added = await markExistingCommentsSeen(work, "OPS-15", gateSeen);
    expect(added).toBe(1);
    const hit = await pollForCommandOnce({
      work,
      ticketKey: "OPS-15",
      seen: gateSeen,
      accept: ["approve", "reject"],
    });
    expect(hit).toBeNull(); // stale approval ignored — only NEW comments count
  });

  it("returns the first accepted /approve command", async () => {
    const stub = stubFetch([{ body: { comments: [commentWith(doc(paragraph("/approve")))] } }]);
    const hit = await pollForCommandOnce({
      work: port(stub),
      ticketKey: "OPS-6",
      seen: seen(),
      accept: ["approve", "reject"],
    });
    expect(hit?.envelope.command).toEqual({ name: "approve" });
    expect(hit?.commentId).toBe("10000");
  });

  it("de-dupes a command already acted on (marks it seen)", async () => {
    const already = new Set<string>(["10000"]);
    const stub = stubFetch([{ body: { comments: [commentWith(doc(paragraph("/approve")))] } }]);
    const hit = await pollForCommandOnce({
      work: port(stub),
      ticketKey: "OPS-6",
      seen: already,
      accept: ["approve"],
    });
    expect(hit).toBeNull();
  });

  it("ignores a command not in the accept list but still marks it seen", async () => {
    const s = seen();
    const stub = stubFetch([{ body: { comments: [commentWith(doc(paragraph("/status")))] } }]);
    const ignored: string[] = [];
    const hit = await pollForCommandOnce({
      work: port(stub),
      ticketKey: "OPS-6",
      seen: s,
      accept: ["approve", "reject"],
      onIgnored: (e) => ignored.push(e.command.name),
    });
    expect(hit).toBeNull();
    expect(ignored).toEqual(["status"]);
    expect(s.has("10000")).toBe(true);
  });

  it("does not honour an EDITED comment (M105) — updated != created", async () => {
    const stub = stubFetch([{ body: { comments: [commentWith(doc(paragraph("/approve")), "10000", true)] } }]);
    const hit = await pollForCommandOnce({
      work: port(stub),
      ticketKey: "OPS-6",
      seen: seen(),
      accept: ["approve"],
    });
    expect(hit).toBeNull();
  });

  it("returns a /reject with its reason", async () => {
    const stub = stubFetch([{ body: { comments: [commentWith(doc(paragraph("/reject kapsam belirsiz")))] } }]);
    const hit = await pollForCommandOnce({
      work: port(stub),
      ticketKey: "OPS-6",
      seen: seen(),
      accept: ["approve", "reject"],
    });
    expect(hit?.envelope.command).toEqual({ name: "reject", reason: "kapsam belirsiz" });
  });

  it("reports an invalid command and marks it seen, not a gate hit", async () => {
    const invalids: string[] = [];
    const stub = stubFetch([{ body: { comments: [commentWith(doc(paragraph("/reject")))] } }]);
    const hit = await pollForCommandOnce({
      work: port(stub),
      ticketKey: "OPS-6",
      seen: seen(),
      accept: ["approve", "reject"],
      onInvalid: (_key, cmd) => invalids.push(cmd),
    });
    expect(hit).toBeNull();
    expect(invalids).toEqual(["reject"]); // /reject with no reason is malformed
  });
});
