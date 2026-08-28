import { describe, expect, it } from "vitest";
import { WebhookDriverConfig } from "../src/config.js";
import { createSlackNotifier, escapeMrkdwn, slackBodyFailure } from "../src/slack.js";
import { FakeFetch, aNotification, fakeSecrets, fakeSleep } from "./helpers.js";

const HOOK = "https://hooks.slack.com/services/T000/B000/SLACKSECRET";

function driver(fetch: FakeFetch) {
  return createSlackNotifier(WebhookDriverConfig.parse({ targets: { ops: "notify/slack/ops" } }), {
    fetchImpl: fetch.fetch,
    secrets: fakeSecrets({ "notify/slack/ops": HOOK }),
    sleep: fakeSleep().sleep,
  });
}

describe("slack driver (M45)", () => {
  it("posts text + a mrkdwn section block", async () => {
    const fetch = new FakeFetch().reply(200, "ok");
    await driver(fetch).send(aNotification({ channel: "slack" }));

    const body = fetch.bodies[0] as { text: string; blocks: { text: { type: string; text: string } }[] };
    expect(body.text).toBe("UGURPAY-501 için 5 bekliyor — sorumlu: Ayşe");
    expect(body.blocks[0]?.text.type).toBe("mrkdwn");
    expect(fetch.calls[0]?.init.headers["content-type"]).toBe("application/json");
  });

  it("escapes the three characters Slack treats as markup", () => {
    expect(escapeMrkdwn("A & B <script> </x>")).toBe("A &amp; B &lt;script&gt; &lt;/x&gt;");
  });

  it("reads 'ok' and an empty body as success, a refusal as failure", () => {
    expect(slackBodyFailure("ok")).toBeNull();
    expect(slackBodyFailure("")).toBeNull();
    expect(slackBodyFailure("invalid_payload")).toBe("invalid_payload");
  });

  it("surfaces a permanent 403 (revoked webhook) to the caller", async () => {
    const fetch = new FakeFetch().reply(403, "invalid_token");
    await expect(driver(fetch).send(aNotification({ channel: "slack" }))).rejects.toThrow(/HTTP 403/);
    expect(fetch.calls).toHaveLength(1);
  });
});
