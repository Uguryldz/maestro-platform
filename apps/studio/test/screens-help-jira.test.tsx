import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { JiraSetupCard } from "../src/screens/help/JiraSetup.tsx";
import { renderScreen, stubFetch } from "./harness.tsx";

/**
 * "Jira'da ne yapmam gerekiyor?" — the card that tells an operator how to make a
 * ticket reach Maestro.
 *
 * The point of these tests is that the answer is DERIVED, not written: the
 * project key, the issue type and the bot account come from the live listening
 * rules, so a rule change moves the instructions. The second test is the one
 * that matters most — a different rule must produce different text, which a
 * hard-coded paragraph could never do.
 */

const LIVE_RULE = {
  ruleId: "lr_487a6ec900944a4662",
  projectKey: "OPS",
  assigneeAccountId: "712020:b836c135-c9d3-499a-a665-aed43d362cfd",
  matchKind: "issuetype",
  matchValue: "Görev",
  flowType: "analiz",
  enabled: true,
};

describe("help — what to do in Jira", () => {
  it("names the project, issue type and bot account from the live rule", async () => {
    const { fetchImpl } = stubFetch([
      { path: "/studio/listening-rules", body: { rules: [LIVE_RULE] } },
    ]);
    renderScreen(<JiraSetupCard />, { fetchImpl });

    expect(await screen.findByText("OPS")).toBeInTheDocument();
    expect(screen.getByText("Görev")).toBeInTheDocument();
    expect(screen.getByText("Ticket tipi:")).toBeInTheDocument();
    expect(
      screen.getByText("712020:b836c135-c9d3-499a-a665-aed43d362cfd"),
    ).toBeInTheDocument();
    expect(screen.getByText("analiz")).toBeInTheDocument();
  });

  it("follows the rule when it changes — the text is data, not a constant", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/studio/listening-rules",
        body: {
          rules: [
            {
              ...LIVE_RULE,
              projectKey: "BANK",
              matchKind: "status",
              matchValue: "Hazır",
              flowType: "duzeltme",
              assigneeAccountId: "acct-99",
            },
          ],
        },
      },
    ]);
    renderScreen(<JiraSetupCard />, { fetchImpl });

    expect(await screen.findByText("BANK")).toBeInTheDocument();
    expect(screen.getByText("Durum:")).toBeInTheDocument();
    expect(screen.getByText("Hazır")).toBeInTheDocument();
    expect(screen.getByText("duzeltme")).toBeInTheDocument();
    // The previous rule's values are nowhere on the screen.
    expect(screen.queryByText("OPS")).toBeNull();
    expect(screen.queryByText("Görev")).toBeNull();
  });

  it("says so plainly when no rule exists rather than inventing an example", async () => {
    const { fetchImpl } = stubFetch([
      { path: "/studio/listening-rules", body: { rules: [] } },
    ]);
    renderScreen(<JiraSetupCard />, { fetchImpl });

    expect(await screen.findByText(/Henüz dinleme kuralı tanımlı değil/)).toBeInTheDocument();
    expect(screen.queryByText("OPS")).toBeNull();
  });

  it("ignores a disabled rule — it triggers nothing, so it instructs nothing", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/studio/listening-rules",
        body: { rules: [{ ...LIVE_RULE, enabled: false }] },
      },
    ]);
    renderScreen(<JiraSetupCard />, { fetchImpl });

    expect(await screen.findByText(/Henüz dinleme kuralı tanımlı değil/)).toBeInTheDocument();
  });

  it("gives the webhook URL and events, and keeps the secret out of the screen", async () => {
    const { fetchImpl } = stubFetch([
      { path: "/studio/listening-rules", body: { rules: [LIVE_RULE] } },
    ]);
    renderScreen(<JiraSetupCard />, { fetchImpl });

    // The PATH is Maestro's own fact; the HOST is left as a placeholder rather
    // than guessed from the browser's origin, which points at Studio, not the
    // BFF that Jira has to reach.
    expect(
      await screen.findByText("https://<maestro-sunucusu>/webhooks/jira"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/127\.0\.0\.1|localhost/)).toBeNull();
    expect(screen.getByText("Issue: created, updated · Comment: created")).toBeInTheDocument();
    // The secret is named by its Vault ref; the value itself never appears.
    expect(screen.getByText(/kv\/jira#webhook/)).toBeInTheDocument();
  });

  it("shows no e-mail address anywhere (PII stays off the screen)", async () => {
    const { fetchImpl } = stubFetch([
      { path: "/studio/listening-rules", body: { rules: [LIVE_RULE] } },
    ]);
    renderScreen(<JiraSetupCard />, { fetchImpl });

    await screen.findByText("OPS");
    expect(document.body.textContent ?? "").not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/);
  });
});
