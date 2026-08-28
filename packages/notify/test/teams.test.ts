import { describe, expect, it } from "vitest";
import { WebhookDriverConfig } from "../src/config.js";
import { NotifyDeliveryError, NotifyPermanentError } from "../src/errors.js";
import { createTeamsNotifier } from "../src/teams.js";
import { FakeFetch, aNotification, fakeSecrets, fakeSleep } from "./helpers.js";

const WEBHOOK = "https://outlook.office.com/webhook/00000000/IncomingWebhook/SUPERSECRETTOKEN";

function driver(fetch: FakeFetch, sleep = fakeSleep(), overrides: Partial<{ retry: unknown }> = {}) {
  const config = WebhookDriverConfig.parse({
    targets: { ops: "notify/teams/ops", leads: "notify/teams/leads" },
    retry: { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 1_000 },
    ...overrides,
  });
  return createTeamsNotifier(config, {
    fetchImpl: fetch.fetch,
    secrets: fakeSecrets({ "notify/teams/ops": WEBHOOK, "notify/teams/leads": `${WEBHOOK}2` }),
    sleep: sleep.sleep,
  });
}

describe("teams driver (M45)", () => {
  it("POSTs an Adaptive Card in the envelope Teams requires", async () => {
    const fetch = new FakeFetch().reply(200, "1");
    await driver(fetch).send(aNotification());

    expect(fetch.calls[0]?.url).toBe(WEBHOOK);
    expect(fetch.calls[0]?.init.method).toBe("POST");
    const body = fetch.bodies[0] as {
      type: string;
      attachments: { contentType: string; content: { type: string; body: { text: string }[] } }[];
    };
    expect(body.type).toBe("message");
    expect(body.attachments[0]?.contentType).toBe("application/vnd.microsoft.card.adaptive");
    expect(body.attachments[0]?.content.type).toBe("AdaptiveCard");
    expect(body.attachments[0]?.content.body[0]?.text).toBe("UGURPAY-501 için 5 bekliyor — sorumlu: Ayşe");
  });

  it("resolves the webhook URL from SecretPort by target name", async () => {
    const fetch = new FakeFetch().reply(200, "1").reply(200, "1");
    await driver(fetch).send(aNotification({ to: ["ops", "leads"] }));
    expect(fetch.calls.map((call) => call.url)).toEqual([WEBHOOK, `${WEBHOOK}2`]);
  });

  it("rejects an unknown target instead of dropping the notification", async () => {
    const fetch = new FakeFetch();
    await expect(driver(fetch).send(aNotification({ to: ["unknown"] }))).rejects.toThrow(
      /not a configured target/,
    );
    expect(fetch.calls).toHaveLength(0);
  });

  it("refuses a webhook URL that is not https", async () => {
    const config = WebhookDriverConfig.parse({ targets: { ops: "s" } });
    const notifier = createTeamsNotifier(config, {
      fetchImpl: new FakeFetch().fetch,
      secrets: fakeSecrets({ s: "http://intranet/hook/TOKEN" }),
    });
    await expect(notifier.send(aNotification())).rejects.toThrow(/not an https:\/\/ URL/);
  });

  it("retries a 500 with capped exponential backoff and then succeeds", async () => {
    const fetch = new FakeFetch().reply(500, "boom").reply(500, "boom").reply(200, "1");
    const sleep = fakeSleep();
    await driver(fetch, sleep).send(aNotification());
    expect(fetch.calls).toHaveLength(3);
    expect(sleep.waits).toEqual([100, 200]);
  });

  it("honours Retry-After on 429", async () => {
    const fetch = new FakeFetch().reply(429, "slow down", { "retry-after": "5" }).reply(200, "1");
    const sleep = fakeSleep();
    await driver(fetch, sleep).send(aNotification());
    expect(sleep.waits).toEqual([1_000]); // clamped by maxDelayMs
  });

  it("does not retry a 400 and surfaces it", async () => {
    const fetch = new FakeFetch().reply(400, "Bad payload");
    const sleep = fakeSleep();
    await expect(driver(fetch, sleep).send(aNotification())).rejects.toThrow(NotifyDeliveryError);
    expect(fetch.calls).toHaveLength(1);
    expect(sleep.waits).toEqual([]);
  });

  it("gives up after maxAttempts and reports the failure — never silently", async () => {
    const fetch = new FakeFetch().reply(503, "").reply(503, "").reply(503, "");
    await expect(driver(fetch).send(aNotification())).rejects.toThrow(/not delivered/);
    expect(fetch.calls).toHaveLength(3);
  });

  it("treats a 200 whose body says 'failed' as a refusal, not a success", async () => {
    const fetch = new FakeFetch().reply(200, "Webhook message delivery failed with error");
    await expect(driver(fetch).send(aNotification())).rejects.toThrow(/rejected the message/);
  });

  it("attempts every target and reports which ones failed", async () => {
    const fetch = new FakeFetch().reply(400, "nope").reply(200, "1");
    const error = await driver(fetch)
      .send(aNotification({ to: ["ops", "leads"] }))
      .catch((caught: unknown) => caught);
    expect(fetch.calls).toHaveLength(2);
    expect(String(error)).toMatch(/1 of 2 target\(s\) failed/);
    expect(String(error)).toContain("ops");
  });

  it("refuses a notification addressed to another channel", async () => {
    await expect(driver(new FakeFetch()).send(aNotification({ channel: "slack" }))).rejects.toThrow(
      NotifyPermanentError,
    );
  });

  it("retries a transport error", async () => {
    const fetch = new FakeFetch().fail("ECONNRESET").reply(200, "1");
    await driver(fetch).send(aNotification());
    expect(fetch.calls).toHaveLength(2);
  });
});
