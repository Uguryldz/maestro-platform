import { describe, expect, it } from "vitest";
import {
  listJiraMatchValues,
  parseCreateMetaIssueTypes,
} from "../src/jira-match-values-service.js";
import { fetchSeedIssueTypes } from "../src/listening-seed.js";
import type { ConnectionRecord } from "../src/connection-store.js";
import type { ConnectorFetch } from "../src/connection-service.js";

/**
 * The values a listening rule can match on — and the localisation trap under
 * them.
 *
 * Measured live on project OPS: `/project/OPS/statuses` names its issue types
 * "Task/Bug/Story/Epic" while `/issue/createmeta/OPS/issuetypes` and the issue
 * resource itself both say "Görev/Hata/Hikaye/Epik". `flow-decision.ts` compares
 * a rule's `matchValue` to `fields.issuetype.name`, so a rule built from the
 * first list matches NOTHING. These tests pin the issue-type branch to the
 * createmeta source, pin the STATUS branch to the statuses payload (it was
 * always right and the shipped status-map feature depends on it), and prove the
 * degradation path never hands back an empty dropdown.
 */

const TOKEN = "jira_secrettoken_xyz789";

/** The live OPS payload, trimmed: English at the top, Turkish in the nest. */
const STATUSES_BODY = [
  {
    name: "Task",
    subtask: false,
    statuses: [
      { id: "10000", name: "Yapılacaklar", statusCategory: { key: "new", name: "Yapılacak" } },
      { id: "10001", name: "Devam Ediyor", statusCategory: { key: "indeterminate", name: "Sürüyor" } },
      { id: "10002", name: "Tamam", statusCategory: { key: "done", name: "Bitti" } },
    ],
  },
  {
    name: "Bug",
    subtask: false,
    statuses: [
      { id: "10000", name: "Yapılacaklar", statusCategory: { key: "new", name: "Yapılacak" } },
      { id: "10003", name: "İNCELEMEDE", statusCategory: { key: "indeterminate", name: "Sürüyor" } },
    ],
  },
  { name: "Story", subtask: false, statuses: [] },
  { name: "Subtask", subtask: true, statuses: [] },
];

/** What `/issue/createmeta/OPS/issuetypes` actually returned on the live site. */
const CREATEMETA_BODY = {
  startAt: 0,
  maxResults: 50,
  total: 4,
  issueTypes: [
    { id: "10001", name: "Görev", subtask: false },
    { id: "10004", name: "Hata", subtask: false },
    { id: "10002", name: "Hikaye", subtask: false },
    { id: "10005", name: "Subtask", subtask: true },
  ],
};

function conn(over: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return {
    id: "jira",
    kind: "jira_cloud",
    displayName: "Jira Cloud",
    baseUrl: "https://ugurbank.atlassian.net",
    authKind: "basic",
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
    ...over,
  };
}

/**
 * A fetch stub that answers per URL SUBSTRING, so a test states which endpoint
 * it is serving instead of relying on call order. An unmatched URL is a 404,
 * which is exactly how a deployment without createmeta behaves.
 */
function router(routes: readonly { match: string; status: number; body: unknown }[]): {
  fetch: ConnectorFetch;
  urls: string[];
} {
  const urls: string[] = [];
  const fetch: ConnectorFetch = (url) => {
    const href = String(url);
    urls.push(href);
    const hit = routes.find((r) => href.includes(r.match));
    if (hit === undefined) return Promise.resolve(new Response("{}", { status: 404 }));
    return Promise.resolve(new Response(JSON.stringify(hit.body), { status: hit.status }));
  };
  return { fetch, urls };
}

const CREATEMETA = { match: "/issue/createmeta/", status: 200, body: CREATEMETA_BODY };
const STATUSES = { match: "/statuses", status: 200, body: STATUSES_BODY };

describe("listJiraMatchValues — Cloud issue types", () => {
  it("returns the LOCALISED names from createmeta, not the English ones from /statuses", async () => {
    const { fetch, urls } = router([CREATEMETA, STATUSES]);
    const result = await listJiraMatchValues(conn(), "OPS", "issuetype", TOKEN, fetch);

    expect(result).toEqual({ ok: true, values: ["Görev", "Hata", "Hikaye", "Subtask"] });
    // The names the statuses payload would have produced must NOT appear: those
    // are the ones that silently match no ticket.
    if (result.ok) {
      expect(result.values).not.toContain("Task");
      expect(result.values).not.toContain("Bug");
      expect(result.values).not.toContain("Story");
    }
    // Only createmeta was called — the fallback costs a request we did not need.
    expect(urls).toEqual([
      "https://ugurbank.atlassian.net/rest/api/3/issue/createmeta/OPS/issuetypes",
    ]);
  });

  it("parses the paginated {values:[…]} shape as well as {issueTypes:[…]}", async () => {
    const { fetch } = router([
      { match: "/issue/createmeta/", status: 200, body: { values: CREATEMETA_BODY.issueTypes } },
      STATUSES,
    ]);
    const result = await listJiraMatchValues(conn(), "OPS", "issuetype", TOKEN, fetch);
    expect(result).toEqual({ ok: true, values: ["Görev", "Hata", "Hikaye", "Subtask"] });
  });

  it("presents Basic auth with the stored email and never puts the token in the URL", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetch: ConnectorFetch = (url, init) => {
      calls.push({ url: String(url), ...(init ? { init } : {}) });
      return Promise.resolve(new Response(JSON.stringify(CREATEMETA_BODY), { status: 200 }));
    };
    await listJiraMatchValues(conn(), "OPS", "issuetype", TOKEN, fetch);

    const auth = (calls[0]?.init?.headers as Record<string, string>).authorization ?? "";
    expect(Buffer.from(auth.replace("Basic ", ""), "base64").toString()).toBe(
      `bot@ugurbank.local:${TOKEN}`,
    );
    expect(calls[0]?.url).not.toContain(TOKEN);
  });
});

describe("listJiraMatchValues — degradation when createmeta cannot answer", () => {
  it("falls back to /statuses on a 403 and SAYS it degraded, instead of emptying the list", async () => {
    const { fetch, urls } = router([
      { match: "/issue/createmeta/", status: 403, body: { errorMessages: ["no create permission"] } },
      STATUSES,
    ]);
    const result = await listJiraMatchValues(conn(), "OPS", "issuetype", TOKEN, fetch);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Stale, possibly-wrong-language names — but a list the operator can read.
      expect(result.values).toEqual(["Task", "Bug", "Story", "Subtask"]);
      expect(result.degraded).toBe(true);
      expect(result.degradedKey).toBe("onboard.jira.issuetypes_degraded");
    }
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("/project/OPS/statuses");
  });

  it("falls back when createmeta 404s (an older deployment without the endpoint)", async () => {
    const { fetch } = router([STATUSES]); // createmeta unmatched → 404
    const result = await listJiraMatchValues(conn(), "OPS", "issuetype", TOKEN, fetch);
    expect(result).toMatchObject({ ok: true, degraded: true });
  });

  it("falls back when createmeta answers 200 with a shape it does not recognise", async () => {
    const { fetch } = router([
      { match: "/issue/createmeta/", status: 200, body: { unexpected: true } },
      STATUSES,
    ]);
    const result = await listJiraMatchValues(conn(), "OPS", "issuetype", TOKEN, fetch);
    expect(result).toMatchObject({ ok: true, degraded: true });
    if (result.ok) expect(result.values).toEqual(["Task", "Bug", "Story", "Subtask"]);
  });

  it("treats an EMPTY createmeta page as no answer and degrades rather than returning []", async () => {
    const { fetch } = router([
      { match: "/issue/createmeta/", status: 200, body: { issueTypes: [] } },
      STATUSES,
    ]);
    const result = await listJiraMatchValues(conn(), "OPS", "issuetype", TOKEN, fetch);
    expect(result).toMatchObject({ ok: true, degraded: true });
    if (result.ok) expect(result.values.length).toBeGreaterThan(0);
  });

  it("reports a secret-free failure when BOTH sources fail, and never leaks the token", async () => {
    const { fetch } = router([]); // everything 404s
    const result = await listJiraMatchValues(conn(), "OPS", "issuetype", TOKEN, fetch);
    expect(result).toMatchObject({ ok: false, messageKey: "onboard.jira.http_error" });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });

  it("reports a thrown fetch as unreachable rather than throwing to the caller", async () => {
    const fetch: ConnectorFetch = () => Promise.reject(new Error(`connect failed to ${TOKEN}`));
    await expect(listJiraMatchValues(conn(), "OPS", "issuetype", TOKEN, fetch)).resolves.toMatchObject(
      { ok: false, messageKey: "onboard.jira.unreachable" },
    );
    const result = await listJiraMatchValues(conn(), "OPS", "status", TOKEN, fetch);
    expect(JSON.stringify(result)).not.toContain(TOKEN);
  });
});

describe("listJiraMatchValues — status branch (regression lock)", () => {
  /**
   * The status-map feature ships against these names. This branch was CORRECT
   * before the issue-type fix and must stay byte-identical: the nested statuses
   * of `/project/{key}/statuses` are the same strings `fields.status.name`
   * carries, and createmeta must never be consulted for them.
   */
  it("reads the NESTED status names off /project/{key}/statuses, de-duplicated", async () => {
    const { fetch, urls } = router([CREATEMETA, STATUSES]);
    const result = await listJiraMatchValues(conn(), "OPS", "status", TOKEN, fetch);

    expect(result).toEqual({
      ok: true,
      values: ["Yapılacaklar", "Devam Ediyor", "Tamam", "İNCELEMEDE"],
    });
    expect(urls).toEqual(["https://ugurbank.atlassian.net/rest/api/3/project/OPS/statuses"]);
    // No `degraded` flag ever appears on the status path.
    expect(result.ok && "degraded" in result).toBe(false);
  });

  it("still maps a status HTTP error to the same secret-free key", async () => {
    const { fetch } = router([{ match: "/statuses", status: 401, body: { message: "Unauthorized" } }]);
    const result = await listJiraMatchValues(conn(), "OPS", "status", TOKEN, fetch);
    expect(result).toMatchObject({
      ok: false,
      messageKey: "onboard.jira.http_error",
      messageParams: { status: "401" },
    });
  });
});

describe("listJiraMatchValues — Data Center stays on its verified source", () => {
  /**
   * DC keeps `/project/{key}/statuses` for BOTH kinds. Server/DC documents the
   * same createmeta route, but with no DC instance to measure we will not trade
   * a list that works for one that might 404 — see the comment in
   * `jiraMatchSource`.
   */
  it("reads DC issue types off /rest/api/2/project/{key}/statuses with a bearer token", async () => {
    const { fetch, urls } = router([CREATEMETA, STATUSES]);
    const calls: string[] = [];
    const spy: ConnectorFetch = (url, init) => {
      calls.push(((init?.headers as Record<string, string>) ?? {}).authorization ?? "");
      return fetch(url, init);
    };
    const result = await listJiraMatchValues(conn({ kind: "jira_dc" }), "OPS", "issuetype", TOKEN, spy);

    expect(result).toEqual({ ok: true, values: ["Task", "Bug", "Story", "Subtask"] });
    expect(urls).toEqual(["https://ugurbank.atlassian.net/rest/api/2/project/OPS/statuses"]);
    expect(urls[0]).not.toContain("createmeta");
    expect(calls[0]).toBe(`Bearer ${TOKEN}`);
  });

  it("reads DC statuses off the same endpoint, unchanged", async () => {
    const { fetch } = router([STATUSES]);
    const result = await listJiraMatchValues(conn({ kind: "jira_dc" }), "OPS", "status", TOKEN, fetch);
    expect(result).toEqual({
      ok: true,
      values: ["Yapılacaklar", "Devam Ediyor", "Tamam", "İNCELEMEDE"],
    });
  });
});

describe("listJiraMatchValues — guards that must not reach the network", () => {
  it("refuses a kind that cannot list values", async () => {
    const { fetch, urls } = router([CREATEMETA, STATUSES]);
    const result = await listJiraMatchValues(conn({ kind: "github" }), "OPS", "issuetype", TOKEN, fetch);
    expect(result).toMatchObject({ ok: false, messageKey: "onboard.jira.not_listable" });
    expect(urls).toHaveLength(0);
  });

  it("refuses a missing token and an empty project key", async () => {
    const { fetch, urls } = router([CREATEMETA, STATUSES]);
    expect(await listJiraMatchValues(conn(), "OPS", "issuetype", null, fetch)).toMatchObject({
      ok: false,
      messageKey: "onboard.jira.no_token",
    });
    expect(await listJiraMatchValues(conn(), "   ", "issuetype", TOKEN, fetch)).toMatchObject({
      ok: false,
      messageKey: "onboard.jira.bad_response",
    });
    expect(urls).toHaveLength(0);
  });
});

describe("parseCreateMetaIssueTypes", () => {
  it("de-duplicates, trims, and keeps subtask types", () => {
    expect(
      parseCreateMetaIssueTypes({
        issueTypes: [{ name: " Görev " }, { name: "Görev" }, { name: "Subtask", subtask: true }],
      }),
    ).toEqual(["Görev", "Subtask"]);
  });

  it("returns null (not []) for shapes it cannot read, so the caller degrades", () => {
    expect(parseCreateMetaIssueTypes(null)).toBeNull();
    expect(parseCreateMetaIssueTypes([])).toBeNull();
    expect(parseCreateMetaIssueTypes({ issueTypes: [] })).toBeNull();
    expect(parseCreateMetaIssueTypes({ issueTypes: [{ id: "1" }] })).toBeNull();
  });
});

describe("fetchSeedIssueTypes — the seed matches on the same names", () => {
  /**
   * The default-rule seed writes `matchValue` straight into a listening rule,
   * so it has to prefer the same source: a seeded "Task" rule is a project that
   * silently listens to nothing.
   */
  it("seeds from the LOCALISED createmeta names and keeps the subtask flag", async () => {
    const { fetch } = router([CREATEMETA, STATUSES]);
    const result = await fetchSeedIssueTypes(conn(), "OPS", TOKEN, fetch);
    expect(result).toEqual({
      ok: true,
      issueTypes: [
        { name: "Görev", subtask: false },
        { name: "Hata", subtask: false },
        { name: "Hikaye", subtask: false },
        { name: "Subtask", subtask: true },
      ],
    });
  });

  it("degrades to /statuses rather than seeding nothing when createmeta 403s", async () => {
    const { fetch } = router([
      { match: "/issue/createmeta/", status: 403, body: {} },
      STATUSES,
    ]);
    const result = await fetchSeedIssueTypes(conn(), "OPS", TOKEN, fetch);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.issueTypes.map((t) => t.name)).toEqual(["Task", "Bug", "Story", "Subtask"]);
  });

  it("keeps DC on the statuses payload, never calling createmeta", async () => {
    const { fetch, urls } = router([CREATEMETA, STATUSES]);
    const result = await fetchSeedIssueTypes(conn({ kind: "jira_dc" }), "OPS", TOKEN, fetch);
    expect(result.ok).toBe(true);
    expect(urls).toEqual(["https://ugurbank.atlassian.net/rest/api/2/project/OPS/statuses"]);
  });

  it("reports unavailable when nothing answers, without throwing", async () => {
    const { fetch } = router([]);
    await expect(fetchSeedIssueTypes(conn(), "OPS", TOKEN, fetch)).resolves.toEqual({
      ok: false,
      reason: "issue_types_unavailable",
    });
  });
});
