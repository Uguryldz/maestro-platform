import { describe, expect, it } from "vitest";
import {
  assertBoundedJql,
  JiraArgumentError,
  JiraCloudClient,
  JiraResponseError,
  searchIssues,
} from "../../src/index.js";
import { fixture, stubFetch, type FetchStub } from "../helpers.js";

function client(stub: FetchStub): JiraCloudClient {
  return new JiraCloudClient({
    baseUrl: "https://uyildiz.atlassian.net",
    email: "pilot@bank.example",
    token: () => "api-token-123",
    fetchImpl: stub.fetchImpl,
  });
}

describe("searchIssues", () => {
  it("parses the recorded /search/jql page", async () => {
    const stub = stubFetch([{ body: fixture("cloud/search-jql") }]);
    const page = await searchIssues(client(stub), { jql: "project = OPS", maxResults: 50 });

    expect(page.issues).toHaveLength(6);
    expect(page.isLast).toBe(true);
    expect(page.nextPageToken).toBeNull();
    const keys = page.issues.map((issue) => (issue as { key: string }).key);
    expect(keys).toEqual(["OPS-6", "OPS-5", "OPS-4", "OPS-3", "OPS-2", "OPS-1"]);
  });

  it("calls the new endpoint — never the removed /rest/api/3/search", async () => {
    const stub = stubFetch([{ body: fixture("cloud/search-jql") }]);
    await searchIssues(client(stub), { jql: "project = OPS", fields: ["summary", "labels"] });

    const url = new URL(stub.calls[0]!.url);
    expect(url.pathname).toBe("/rest/api/3/search/jql");
    expect(url.searchParams.get("jql")).toBe("project = OPS");
    expect(url.searchParams.get("fields")).toBe("summary,labels");
    expect(stub.calls[0]!.method).toBe("GET");
  });

  it("refuses unbounded JQL before it leaves the process", async () => {
    const stub = stubFetch([]);
    for (const jql of ["", "   ", "ORDER BY created DESC", "order by\tcreated"]) {
      await expect(searchIssues(client(stub), { jql })).rejects.toBeInstanceOf(JiraArgumentError);
    }
    expect(stub.calls).toHaveLength(0);
  });

  it("accepts bounded JQL that merely ends in an order by", () => {
    expect(assertBoundedJql(" project = OPS order by created ")).toBe("project = OPS order by created");
    // "ordering = broken" starts with the word "order…" but is a real clause.
    expect(assertBoundedJql("ordering = broken")).toBe("ordering = broken");
  });

  it("passes the page token through and surfaces the next one", async () => {
    const stub = stubFetch([{ body: { issues: [], isLast: false, nextPageToken: "tok-2" } }]);
    const page = await searchIssues(client(stub), { jql: "project = OPS", pageToken: "tok-1" });

    expect(new URL(stub.calls[0]!.url).searchParams.get("nextPageToken")).toBe("tok-1");
    expect(page.isLast).toBe(false);
    expect(page.nextPageToken).toBe("tok-2");
  });

  it("fails loudly on a response without issues or without isLast", async () => {
    const noIssues = stubFetch([{ body: { isLast: true } }]);
    await expect(searchIssues(client(noIssues), { jql: "project = OPS" })).rejects.toBeInstanceOf(JiraResponseError);

    const noIsLast = stubFetch([{ body: { issues: [] } }]);
    await expect(searchIssues(client(noIsLast), { jql: "project = OPS" })).rejects.toBeInstanceOf(JiraResponseError);
  });
});
