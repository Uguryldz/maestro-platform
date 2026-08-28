import { describe, expect, it } from "vitest";
import { WebhookDriverConfig } from "../src/config.js";
import { NotifyDeliveryError, NotifyTransientError } from "../src/errors.js";
import { renderMessage } from "../src/message.js";
import { sendToEachTarget } from "../src/retry.js";
import { createSlackNotifier } from "../src/slack.js";
import { SmtpProtocolError, SmtpReplyReader, buildMimeMessage } from "../src/smtp-protocol.js";
import { createTeamsNotifier } from "../src/teams.js";
import { FakeFetch, aNotification, fakeSecrets, fakeSleep } from "./helpers.js";

/**
 * Regression tests for the verification round. Every case here reproduces a
 * defect that shipped green: a silent success, a leak, an injection or a
 * retried permanent failure.
 */

const TEAMS_HOOK = "https://outlook.office.com/webhook/00000000/IncomingWebhook/TEAMSTOKEN";
const SLACK_HOOK = "https://hooks.slack.com/services/T000/B000/SLACKTOKEN";

function teams(fetch: FakeFetch, targets: Record<string, string> = { ops: "notify/teams/ops" }) {
  return createTeamsNotifier(WebhookDriverConfig.parse({ targets, retry: { maxAttempts: 1 } }), {
    fetchImpl: fetch.fetch,
    secrets: fakeSecrets({ "notify/teams/ops": TEAMS_HOOK }),
    sleep: fakeSleep().sleep,
  });
}

function slack(fetch: FakeFetch) {
  return createSlackNotifier(
    WebhookDriverConfig.parse({ targets: { ops: "notify/slack/ops" }, retry: { maxAttempts: 1 } }),
    {
      fetchImpl: fetch.fetch,
      secrets: fakeSecrets({ "notify/slack/ops": SLACK_HOOK }),
      sleep: fakeSleep().sleep,
    },
  );
}

describe("B1 — a 2xx body is a success only when it says so", () => {
  it.each([
    "Bad payload received by generic incoming webhook.",
    "Summary or Text is required.",
    "Webhook message delivery failed with error",
    "Microsoft Teams endpoint returned HTTP error 400",
  ])("treats the Teams refusal %j as a permanent failure", async (body) => {
    const fetch = new FakeFetch().reply(200, body);
    await expect(teams(fetch).send(aNotification())).rejects.toThrow(/rejected the message/);
  });

  it("still accepts the two bodies a healthy Teams endpoint returns", async () => {
    const fetch = new FakeFetch().reply(200, "1").reply(202, "");
    await teams(fetch).send(aNotification());
    await teams(fetch).send(aNotification());
    expect(fetch.calls).toHaveLength(2);
  });

  it.each(["channel_not_found", "no_service", "invalid_payload", "action_prohibited"])(
    "treats the Slack refusal %j as a permanent failure",
    async (body) => {
      const fetch = new FakeFetch().reply(200, body);
      await expect(slack(fetch).send(aNotification({ channel: "slack" }))).rejects.toThrow(
        /rejected the message/,
      );
    },
  );

  it("still accepts Slack's `ok`", async () => {
    const fetch = new FakeFetch().reply(200, "ok");
    await slack(fetch).send(aNotification({ channel: "slack" }));
    expect(fetch.calls).toHaveLength(1);
  });
});

describe("B6 — a webhook URL smuggled into `to` is never echoed", () => {
  it("refuses a target that looks like a URL, before any lookup", async () => {
    const fetch = new FakeFetch();
    const error = await teams(fetch)
      .send(aNotification({ to: [SLACK_HOOK] }))
      .catch((caught: unknown) => caught);
    expect(String(error)).not.toContain("SLACKTOKEN");
    expect(String(error)).not.toContain("hooks.slack.com");
    expect(fetch.calls).toHaveLength(0);
  });
});

describe("B7 — prototype keys are not configured targets", () => {
  it.each(["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"])(
    "rejects %j as an unknown target instead of retrying it",
    async (target) => {
      const fetch = new FakeFetch();
      await expect(teams(fetch).send(aNotification({ to: [target] }))).rejects.toThrow(
        /not a configured target/,
      );
      expect(fetch.calls).toHaveLength(0);
    },
  );
});

describe("B11 — a parameter VALUE may contain braces", () => {
  it("renders a body whose parameter value looks like a placeholder", () => {
    const rendered = renderMessage(
      aNotification({
        messageKey: "notify.handover",
        params: { ticket: "UGURPAY-501", reason: "log line: expected {ops_takimi} to be set" },
      }),
    );
    expect(rendered.body).toContain("{ops_takimi}");
  });

  it("still refuses a template placeholder nobody supplied", () => {
    expect(() => renderMessage(aNotification({ params: { ticket: "UGURPAY-501" } }))).toThrow(
      /missing parameter \{gate\}/,
    );
  });
});

describe("B12 — no clickable phishing link in an approval card", () => {
  it("escapes the Slack fallback `text` exactly like the block body", async () => {
    const fetch = new FakeFetch().reply(200, "ok");
    await slack(fetch).send(
      aNotification({
        channel: "slack",
        params: { ticket: "<https://evil.example|Onayla>", gate: "5", owner: "A & B" },
      }),
    );
    const body = fetch.bodies[0] as { text: string };
    expect(body.text).not.toContain("<https://evil.example");
    expect(body.text).toContain("&lt;https://evil.example");
  });

  it("neutralises Teams card markdown so a ticket summary cannot forge a link", async () => {
    const fetch = new FakeFetch().reply(200, "1");
    await teams(fetch).send(
      aNotification({
        params: { ticket: "[Onayla](https://evil.example)", gate: "5", owner: "Ayşe" },
      }),
    );
    const body = fetch.bodies[0] as {
      summary: string;
      attachments: { content: { body: { text: string }[] } }[];
    };
    const card = body.attachments[0]!.content.body[0]!.text;
    expect(card).not.toMatch(/\[Onayla\]\(/);
    expect(card).toContain("\\[Onayla\\]");
    expect(body.summary).not.toMatch(/\[Onayla\]\(/);
  });
});

describe("B16 — an SMTP reply code is three digits and a separator", () => {
  function readerOf(text: string): SmtpReplyReader {
    const queue = [new TextEncoder().encode(text)];
    return new SmtpReplyReader(async () => queue.shift() ?? null);
  }

  it.each(["2500 weird\r\n", "1e2 exp\r\n", "25 0 short\r\n", "250x nope\r\n", " 250 lead\r\n"])(
    "refuses %j instead of coercing it",
    async (line) => {
      await expect(readerOf(line).nextReply()).rejects.toThrow(SmtpProtocolError);
    },
  );

  it("still reads a well-formed reply", async () => {
    expect(await readerOf("250 OK\r\n").nextReply()).toEqual({ code: 250, lines: ["OK"] });
  });
});

describe("B17/B18 — fan-out reports honest numbers", () => {
  const ctx = () => ({
    driver: "teams",
    event: "gate_open",
    policy: { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 },
    sleep: fakeSleep().sleep,
  });

  it("attempts a repeated target once", async () => {
    const attempted: string[] = [];
    await sendToEachTarget(ctx(), ["ops", "ops", "ops"], async (target) => {
      attempted.push(target);
    });
    expect(attempted).toEqual(["ops"]);
  });

  it("counts attempts, not failed targets, and does not wrap twice", async () => {
    const error = (await sendToEachTarget(ctx(), ["a", "b"], async () => {
      throw new NotifyTransientError("teams", "503");
    }).catch((caught: unknown) => caught)) as NotifyDeliveryError;

    expect(error).toBeInstanceOf(NotifyDeliveryError);
    // 2 targets x 2 attempts each.
    expect(error.attempts).toBe(4);
    expect(error.cause).not.toBeInstanceOf(NotifyDeliveryError);
    expect(String(error)).toMatch(/2 of 2 target\(s\) failed/);
  });
});

describe("B19 — the From display name is header-checked explicitly", () => {
  it("refuses CR/LF in fromName", () => {
    expect(() =>
      buildMimeMessage({
        from: "maestro@bank.local",
        fromName: "Maestro\r\nBcc: attacker@evil.example",
        to: ["po@bank.local"],
        subject: "s",
        body: "b",
        date: new Date("2026-08-08T09:00:00Z"),
        messageId: "id",
      }),
    ).toThrow(SmtpProtocolError);
  });
});
