import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { SmtpDriverConfig, WebhookDriverConfig } from "../src/config.js";
import { redact, safeMessage } from "../src/errors.js";
import { createSmtpNotifier } from "../src/smtp.js";
import { createTeamsNotifier } from "../src/teams.js";
import { FakeFetch, FakeSocket, aNotification, fakeSecrets, fakeSleep, happyRelayReplies } from "./helpers.js";

/**
 * A webhook URL IS a credential (its path is the token) and so is the SMTP
 * password. Neither may reach a log line, an error message, a stack, a JSON
 * dump or `util.inspect` — including through an error thrown by fetch or
 * echoed back by the server.
 */
const TOKEN = "SUPERSECRETTOKEN";
const WEBHOOK = `https://outlook.office.com/webhook/00000000/IncomingWebhook/${TOKEN}`;
const PASSWORD = "sup3r-secret-relay-pw";
/** What actually crosses the wire — and therefore what a relay quotes back. */
const SASL_PLAIN = Buffer.from(`\0maestro-svc\0${PASSWORD}`, "utf8").toString("base64");

/** Every surface an operator (or an exception logger) could print. */
function surfaces(error: unknown): string {
  const parts = [String(error), inspect(error, { depth: null }), JSON.stringify(error) ?? ""];
  if (error instanceof Error) parts.push(error.stack ?? "", JSON.stringify({ ...error }));
  return parts.join("\n");
}

function teams(fetch: FakeFetch) {
  return createTeamsNotifier(
    WebhookDriverConfig.parse({ targets: { ops: "notify/teams/ops" }, retry: { maxAttempts: 1 } }),
    { fetchImpl: fetch.fetch, secrets: fakeSecrets({ "notify/teams/ops": WEBHOOK }), sleep: fakeSleep().sleep },
  );
}

describe("secret leak prevention (M80)", () => {
  it("masks a URL that a transport error echoes back", async () => {
    const fetch = new FakeFetch().fail(`request to ${WEBHOOK} failed, reason: ECONNREFUSED`);
    const error = await teams(fetch)
      .send(aNotification())
      .catch((caught: unknown) => caught);
    expect(surfaces(error)).not.toContain(TOKEN);
    expect(String(error)).toContain("***");
  });

  it("masks a URL the server reflects in an error body", async () => {
    const fetch = new FakeFetch().reply(400, `Bad request for ${WEBHOOK}`);
    const error = await teams(fetch)
      .send(aNotification())
      .catch((caught: unknown) => caught);
    expect(surfaces(error)).not.toContain(TOKEN);
  });

  it("names the target and the secret KEY, never the URL", async () => {
    const fetch = new FakeFetch();
    const error = await teams(fetch)
      .send(aNotification({ to: ["nope"] }))
      .catch((caught: unknown) => caught);
    expect(String(error)).toContain("nope");
    expect(surfaces(error)).not.toContain(TOKEN);
  });

  it("masks the SMTP password when the relay echoes it", async () => {
    const replies = happyRelayReplies();
    // The realistic echo is the SASL token, not the raw password: a relay never
    // sees the password in the clear, so asserting on the raw form was a test
    // that could not fail. `smtp-hardening.test.ts` covers the wire forms in
    // full; this case keeps the plain-text form covered too.
    replies[4] = `535 authentication failed: ${SASL_PLAIN} (and ${PASSWORD} is not it)\r\n`;
    const notifier = createSmtpNotifier(
      SmtpDriverConfig.parse({
        host: "mail.bank.local",
        from: "maestro@bank.local",
        username: "maestro-svc",
        passwordRef: "notify/smtp/password",
        retry: { maxAttempts: 1 },
      }),
      {
        socketFactory: async () => new FakeSocket(replies),
        secrets: fakeSecrets({ "notify/smtp/password": PASSWORD }),
        sleep: fakeSleep().sleep,
      },
    );

    const error = await notifier
      .send(aNotification({ channel: "smtp", to: ["po@bank.local"] }))
      .catch((caught: unknown) => caught);
    expect(String(error)).toContain("535");
    expect(surfaces(error)).not.toContain(PASSWORD);
    expect(surfaces(error)).not.toContain(SASL_PLAIN);
  });

  it("masks a secret that a socket failure carries", async () => {
    const notifier = createSmtpNotifier(
      SmtpDriverConfig.parse({
        host: "mail.bank.local",
        from: "maestro@bank.local",
        username: "maestro-svc",
        passwordRef: "notify/smtp/password",
        retry: { maxAttempts: 1 },
      }),
      {
        socketFactory: async () => {
          throw new Error(`TLS handshake failed while sending ${PASSWORD}`);
        },
        secrets: fakeSecrets({ "notify/smtp/password": PASSWORD }),
        sleep: fakeSleep().sleep,
      },
    );
    const error = await notifier
      .send(aNotification({ channel: "smtp", to: ["po@bank.local"] }))
      .catch((caught: unknown) => caught);
    expect(surfaces(error)).not.toContain(PASSWORD);
  });

  it("redact() also masks the percent-encoded form and keeps short strings", () => {
    expect(redact(`see https://x/${encodeURIComponent("a b/c")}`, ["a b/c"])).toBe("see https://x/***");
    expect(redact("value is abc", ["abc"])).toBe("value is abc"); // too short to mask safely
    expect(safeMessage(new Error(`token=${TOKEN}`), [TOKEN])).toBe("Error: token=***");
  });
});
