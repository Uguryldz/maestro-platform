import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bootPilot, type PilotStage } from "../src/boot.js";
import { scmMode } from "../src/config.js";
import { resolveGithub, resolveJiraCloud, resolveOpenRouter } from "../src/env.js";
import { stubFetch } from "./helpers.js";

/**
 * The isolation guard (test-env fix). The hazard: bootPilot used to fall back to
 * `scmMode(loadRepoEnv())` and the resolvers read `process.env` first, so a
 * developer with `PILOT_SCM=github` (+ a real token) in their shell or
 * `maestro/.env` could sweep an "offline" test into REAL GitHub. The fix makes
 * an injected `env` AUTHORITATIVE: when `bootPilot` is given `env`, the repo
 * `.env` is not read and `process.env` is ignored for every env-derived boot
 * decision. This test pollutes `process.env` the way such a developer would and
 * proves nothing leaks through.
 */

const SITE = "https://uyildiz.atlassian.net";

const POLLUTION: Record<string, string> = {
  PILOT_SCM: "github",
  GITHUB_OWNER: "attacker",
  GITHUB_REPO: "attacker-repo",
  GITHUB_TOKEN: "ghp_pollution_should_never_be_used",
  PILOT_MODEL: "polluted/model",
  OPENROUTER_API_KEY: "sk-pollution-should-never-be-used",
};

describe("env isolation", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of Object.keys(POLLUTION)) {
      saved[key] = process.env[key];
      process.env[key] = POLLUTION[key];
    }
  });

  afterEach(() => {
    for (const key of Object.keys(POLLUTION)) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  // ------------------------------------------------------------- unit level

  it("scmMode: process.env wins by default, injected map wins when authoritative", () => {
    // Default (real app): the polluted shell PILOT_SCM=github takes effect.
    expect(scmMode({})).toBe("github");
    // Authoritative (tests): the injected map is the sole source; `fake` stands.
    expect(scmMode({}, true)).toBe("fake");
    expect(scmMode({ PILOT_SCM: "github" }, true)).toBe("github");
  });

  it("resolvers: authoritative mode ignores the polluted process.env", () => {
    // GitHub owner/repo/token come only from the injected map when authoritative.
    const gh = resolveGithub(
      { GITHUB_OWNER: "ugurbank", GITHUB_REPO: "ugurpay", GITHUB_TOKEN: "injected-token" },
      true,
    );
    expect(gh.owner).toBe("ugurbank");
    expect(gh.token).toBe("injected-token");
    expect(gh.token).not.toBe(POLLUTION["GITHUB_TOKEN"]);

    const or = resolveOpenRouter({ OPENROUTER_API_KEY: "injected-key" }, true);
    expect(or.apiKey).toBe("injected-key");
    expect(or.apiKey).not.toBe(POLLUTION["OPENROUTER_API_KEY"]);

    const jira = resolveJiraCloud(
      { JIRA_CLOUD_BASE_URL: SITE, JIRA_CLOUD_EMAIL: "pilot@bank.example", JIRA_CLOUD_API_TOKEN: "t" },
      true,
    );
    expect(jira.baseUrl).toBe(SITE);

    // A missing key is NOT filled from the polluted shell when authoritative.
    expect(() => resolveGithub({}, true)).toThrow(/GITHUB_OWNER, GITHUB_REPO, GITHUB_TOKEN/);
  });

  // ------------------------------------------------------- integration level

  it("bootPilot threads the injected MAESTRO_BOT_ACCOUNT_ID into the discovery JQL", async () => {
    // The injectable-env contract, proven end to end: a bot accountId placed in
    // the AUTHORITATIVE `env` map (never in process.env, never in maestro/.env)
    // must reach the live search JQL verbatim. We capture the JQL the discovery
    // pass issues to the stubbed Jira transport.
    const BOT = "712020:b836c135-c9d3-499a-a665-aed43d362cfd";
    let discoveryJqlSeen: string | null = null;
    const jiraFetch = (rawUrl: string): Promise<Response> => {
      const url = new URL(rawUrl);
      if (url.pathname === "/rest/api/3/search/jql") {
        discoveryJqlSeen = url.searchParams.get("jql");
        return Promise.resolve(
          new Response(JSON.stringify({ issues: [], total: 0 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      }
      throw new Error(`unexpected jira call: ${rawUrl}`);
    };

    let stage: PilotStage | undefined;
    try {
      stage = await bootPilot({
        // Authoritative env carrying ONLY the bot accountId (plus the values the
        // resolvers need); process.env is polluted but must be ignored.
        env: { MAESTRO_BOT_ACCOUNT_ID: BOT },
        uiPort: 0,
        adoPort: 0,
        openRouter: { apiKey: "test-key", baseUrl: "http://127.0.0.1:1" },
        jiraCloud: { baseUrl: SITE, email: "pilot@bank.example", apiToken: "api-token-123" },
        jiraFetch,
      });
      await stage.refreshDiscovery();
      expect(discoveryJqlSeen).not.toBeNull();
      expect(discoveryJqlSeen!).toContain(`assignee = "${BOT}"`);
      expect(discoveryJqlSeen!).toContain("project = OPS");
      expect(discoveryJqlSeen!).not.toContain("labels = maestro");
    } finally {
      await stage?.close();
    }
  });

  it("bootPilot with a polluted process.env but env:{} still comes up fake", async () => {
    // env:{} is authoritative → PILOT_SCM=github in the shell is ignored, so the
    // github edge is never resolved. If it were NOT ignored, boot would build
    // the REAL github wiring from the polluted GITHUB_* and could push for real.
    // Reaching a working fake stage (no github fetch/exec injected) proves the
    // github path was never taken.
    // A Jira transport that fails loudly on ANY call: boot must not reach the
    // network, and discovery is off, so the queue stays empty.
    const jira = stubFetch([]);
    let stage: PilotStage | undefined;
    try {
      stage = await bootPilot({
        env: {},
        uiPort: 0,
        adoPort: 0,
        openRouter: { apiKey: "test-key", baseUrl: "http://127.0.0.1:1" },
        jiraCloud: { baseUrl: SITE, email: "pilot@bank.example", apiToken: "api-token-123" },
        jiraFetch: jira.fetchImpl,
      });
      // A github run would need github wiring; the fake stage exposes the ADO
      // prop and a live UI on loopback — reached only on the fake path.
      expect(stage.uiUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
      expect(stage.adoUrl).toMatch(/^http:\/\/127\.0\.0\.1:/);
      expect(stage.jiraSite).toBe(SITE);
    } finally {
      await stage?.close();
    }
  });
});
