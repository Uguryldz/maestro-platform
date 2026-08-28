import { describe, expect, it } from "vitest";
import { discoveryJql, DISCOVERY_JQL } from "../src/config.js";
import { resolveJiraCloud, resolveMaestroBotAccountId } from "../src/env.js";

/**
 * Assignment-based discovery + the Maestro Bot identity. Two coupled changes:
 *
 *   (1) the discovery JQL now filters by ASSIGNEE, not `labels = maestro`, so a
 *       ticket dragged onto the bot account is what Maestro works on; and
 *   (2) the Jira identity Maestro connects as is the bot account
 *       (MAESTRO_BOT_EMAIL / MAESTRO_BOT_API_TOKEN), with the personal
 *       JIRA_CLOUD_* kept only as a loud fallback.
 *
 * Everything here runs against the pure resolvers — no network, no boot.
 */

const SITE = "https://uyildiz.atlassian.net";
const BOT_ACCOUNT = "712020:b836c135-c9d3-499a-a665-aed43d362cfd";

describe("discoveryJql — assignment-based discovery", () => {
  it("filters by assignee accountId (quoted) and drops the maestro label", () => {
    const jql = discoveryJql(BOT_ACCOUNT);
    expect(jql).toContain('assignee = "712020:b836c135-c9d3-499a-a665-aed43d362cfd"');
    expect(jql).not.toContain("labels = maestro");
  });

  it("stays bounded (project = OPS) and excludes Done", () => {
    const jql = discoveryJql(BOT_ACCOUNT);
    expect(jql).toContain("project = OPS");
    expect(jql).toContain("statusCategory != Done");
    expect(jql).toContain("ORDER BY created DESC");
  });

  it("falls back to currentUser() — still bounded — when no accountId is given", () => {
    const jql = discoveryJql("");
    expect(jql).toContain("assignee = currentUser()");
    expect(jql).toContain("project = OPS");
    // The exported default is the currentUser() form (used offline by discoverTickets).
    expect(DISCOVERY_JQL).toBe(jql);
  });
});

describe("resolveMaestroBotAccountId", () => {
  it("returns the injected MAESTRO_BOT_ACCOUNT_ID and flows into the JQL", () => {
    let warned = false;
    const id = resolveMaestroBotAccountId({ MAESTRO_BOT_ACCOUNT_ID: BOT_ACCOUNT }, true, () => {
      warned = true;
    });
    expect(id).toBe(BOT_ACCOUNT);
    expect(warned).toBe(false);
    // The whole point: the resolved id lands in the assignment clause verbatim.
    expect(discoveryJql(id)).toContain(`assignee = "${BOT_ACCOUNT}"`);
  });

  it("warns loudly and returns empty when the accountId is missing", () => {
    let message = "";
    const id = resolveMaestroBotAccountId({}, true, (m) => {
      message = m;
    });
    expect(id).toBe("");
    expect(message).toContain("MAESTRO_BOT_ACCOUNT_ID");
  });
});

describe("resolveJiraCloud — Maestro Bot identity", () => {
  const base = { JIRA_CLOUD_BASE_URL: SITE };

  it("connects as the bot when both bot values are present (no warning)", () => {
    let warned = false;
    const jira = resolveJiraCloud(
      {
        ...base,
        MAESTRO_BOT_EMAIL: "uyildiz2054@gmail.com",
        MAESTRO_BOT_API_TOKEN: "bot-token-xyz",
        JIRA_CLOUD_EMAIL: "personal@example.com",
        JIRA_CLOUD_API_TOKEN: "personal-token",
      },
      true,
      () => {
        warned = true;
      },
    );
    expect(jira.email).toBe("uyildiz2054@gmail.com");
    expect(jira.apiToken).toBe("bot-token-xyz");
    // The personal identity must NOT leak through when the bot is complete.
    expect(jira.apiToken).not.toBe("personal-token");
    expect(warned).toBe(false);
  });

  it("falls back to the personal identity with a loud warning when the bot is absent", () => {
    let message = "";
    const jira = resolveJiraCloud(
      {
        ...base,
        JIRA_CLOUD_EMAIL: "personal@example.com",
        JIRA_CLOUD_API_TOKEN: "personal-token",
      },
      true,
      (m) => {
        message = m;
      },
    );
    expect(jira.email).toBe("personal@example.com");
    expect(jira.apiToken).toBe("personal-token");
    expect(message).toContain("Maestro Bot");
  });

  it("warns about the specific missing half when only one bot value is set", () => {
    let message = "";
    resolveJiraCloud(
      {
        ...base,
        MAESTRO_BOT_EMAIL: "uyildiz2054@gmail.com",
        JIRA_CLOUD_EMAIL: "personal@example.com",
        JIRA_CLOUD_API_TOKEN: "personal-token",
      },
      true,
      (m) => {
        message = m;
      },
    );
    expect(message).toContain("MAESTRO_BOT_API_TOKEN");
  });

  it("still hard-fails when neither a bot nor a personal identity exists", () => {
    expect(() => resolveJiraCloud({ ...base }, true, () => {})).toThrow(/eksik/);
  });
});
