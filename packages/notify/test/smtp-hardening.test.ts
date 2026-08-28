import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { SmtpDriverConfig } from "../src/config.js";
import type { TlsInfo } from "../src/deps.js";
import { createSmtpNotifier } from "../src/smtp.js";
import { SmtpSession } from "../src/smtp-client.js";
import { FakeSocket, type FakeSocketOptions, aNotification, fakeSecrets, fakeSleep, happyRelayReplies } from "./helpers.js";

/**
 * SMTP regressions: a leaked password, a swallowed outcome, a command
 * injection and a TLS "upgrade" nobody verified.
 */

const PASSWORD = "sup3r-secret-relay-pw";
const USERNAME = "maestro-svc";
const PLAIN_TOKEN = Buffer.from(`\0${USERNAME}\0${PASSWORD}`, "utf8").toString("base64");

function config(overrides: Record<string, unknown> = {}) {
  return SmtpDriverConfig.parse({
    host: "mail.bank.local",
    from: "maestro@bank.local",
    username: USERNAME,
    passwordRef: "notify/smtp/password",
    retry: { maxAttempts: 1 },
    ...overrides,
  });
}

function harness(replies: string[], overrides: Record<string, unknown> = {}, socketOptions: FakeSocketOptions = {}) {
  const sockets: FakeSocket[] = [];
  const notifier = createSmtpNotifier(config(overrides), {
    socketFactory: async () => {
      const socket = new FakeSocket(replies, socketOptions);
      sockets.push(socket);
      return socket;
    },
    secrets: fakeSecrets({ "notify/smtp/password": PASSWORD }),
    clock: () => new Date("2026-08-08T06:00:00Z"),
    sleep: fakeSleep().sleep,
    messageId: () => "fixed-id",
  });
  return { notifier, sockets };
}

const mail = () => aNotification({ channel: "smtp", to: ["po@bank.local"] });

/** Every surface an operator (or an exception logger) could print. */
function surfaces(error: unknown): string {
  const parts = [String(error), inspect(error, { depth: null }), JSON.stringify(error) ?? ""];
  if (error instanceof Error) parts.push(error.stack ?? "", JSON.stringify({ ...error }));
  return parts.join("\n");
}

describe("B2 — the password leaks in no encoding", () => {
  it("masks the base64 SASL token a relay quotes back", async () => {
    const replies = happyRelayReplies(1);
    // The realistic refusal: the relay echoes the token it just received.
    replies[4] = `535 5.7.8 authentication failed for credential ${PLAIN_TOKEN}\r\n`;
    const { notifier } = harness(replies);

    const error = await notifier.send(mail()).catch((caught: unknown) => caught);
    const printed = surfaces(error);
    expect(printed).toContain("535");
    expect(printed).not.toContain(PASSWORD);
    expect(printed).not.toContain(PLAIN_TOKEN);
    // And nothing left in the text decodes back to the credential.
    for (const candidate of printed.match(/[A-Za-z0-9+/]{16,}={0,2}/g) ?? []) {
      expect(Buffer.from(candidate, "base64").toString("utf8")).not.toContain(PASSWORD);
    }
  });

  it("masks the bare base64 password of an AUTH LOGIN exchange", async () => {
    const loginToken = Buffer.from(PASSWORD, "utf8").toString("base64");
    const replies = [
      "220 mail\r\n",
      "250-mail\r\n250-STARTTLS\r\n250 AUTH LOGIN\r\n",
      "220 go\r\n",
      "250-mail\r\n250 AUTH LOGIN\r\n",
      "334 VXNlcm5hbWU6\r\n",
      "334 UGFzc3dvcmQ6\r\n",
      `535 rejected ${loginToken}\r\n`,
      "221 bye\r\n",
    ];
    const { notifier } = harness(replies);
    const error = await notifier.send(mail()).catch((caught: unknown) => caught);
    expect(surfaces(error)).not.toContain(loginToken);
    expect(surfaces(error)).not.toContain(PASSWORD);
  });
});

describe("B3 — a failing close() never decides the outcome", () => {
  it("reports success when the relay queued the mail and then reset the connection", async () => {
    const { notifier, sockets } = harness(happyRelayReplies(1), {}, {
      closeError: new Error("ECONNRESET"),
    });
    await expect(notifier.send(mail())).resolves.toBeUndefined();
    expect(sockets).toHaveLength(1); // no duplicate delivery attempt
  });

  it("keeps the permanent 552 instead of losing it behind the close error", async () => {
    const replies = happyRelayReplies(1);
    replies[8] = "552 message too large\r\n";
    const { notifier, sockets } = harness(replies, {}, { closeError: new Error("ECONNRESET") });
    await expect(notifier.send(mail())).rejects.toThrow(/552/);
    expect(sockets).toHaveLength(1); // permanent: not retried
  });
});

describe("B8 — no SMTP command injection through a Studio parameter", () => {
  it("refuses an ehloName carrying CR/LF at config time", () => {
    expect(() => config({ ehloName: "maestro\r\nMAIL FROM:<attacker@evil.example>\r\n" })).toThrow();
    expect(() => config({ ehloName: "maestro relay" })).toThrow();
    expect(() => config({ host: "mail.bank.local\r\nEVIL" })).toThrow();
  });

  it("refuses the injected command at the wire, even if a config slips through", async () => {
    const socket = new FakeSocket(happyRelayReplies(1));
    const smuggled = { ...config(), ehloName: "maestro\r\nMAIL FROM:<attacker@evil.example>" };
    const session = new SmtpSession(socket, smuggled, undefined);
    await expect(
      session.send({ from: "maestro@bank.local", to: ["po@bank.local"], data: "x" }),
    ).rejects.toThrow(/CR\/LF/);
    expect(socket.written.join("")).not.toContain("attacker@evil.example");
  });
});

describe("B9 — an unverified TLS session is not a TLS session", () => {
  const cases: [string, TlsInfo][] = [
    [
      "an unverified certificate chain",
      { authorized: false, authorizationError: "SELF_SIGNED_CERT_IN_CHAIN", protocol: "TLSv1.3", servername: "mail.bank.local" },
    ],
    [
      "a withdrawn protocol version",
      { authorized: true, protocol: "TLSv1", servername: "mail.bank.local" },
    ],
    [
      "a handshake against another host",
      { authorized: true, protocol: "TLSv1.3", servername: "relay.attacker.example" },
    ],
  ];

  it.each(cases)("refuses to authenticate over %s", async (_label, tls) => {
    const { notifier, sockets } = harness(happyRelayReplies(1), {}, { tls });
    await expect(notifier.send(mail())).rejects.toThrow(/STARTTLS:/);
    expect(sockets[0]!.written.join("")).not.toContain(PASSWORD);
    expect(sockets[0]!.written.join("")).not.toContain(PLAIN_TOKEN);
  });

  it("verifies an implicit-TLS connection before writing anything", async () => {
    const replies = ["220 mail\r\n", "250-mail\r\n250 AUTH PLAIN\r\n", "235 ok\r\n"];
    const { notifier, sockets } = harness(replies, { security: "implicit", port: 465 }, {
      secureFromStart: true,
      tls: { authorized: false, authorizationError: "UNABLE_TO_VERIFY_LEAF_SIGNATURE", protocol: "TLSv1.3", servername: "mail.bank.local" },
    });
    await expect(notifier.send(mail())).rejects.toThrow(/implicit TLS: peer certificate/);
    // Nothing but the courtesy QUIT: not even EHLO was written.
    expect(sockets[0]!.verbs).toEqual(["QUIT"]);
  });

  it("refuses an implicit-TLS target whose transport reports no TLS at all", async () => {
    const { notifier } = harness(happyRelayReplies(1), { security: "implicit", port: 465 });
    await expect(notifier.send(mail())).rejects.toThrow(/reports no TLS session/);
  });
});

describe("B10 — an advertised STARTTLS is always taken", () => {
  it("upgrades even in plaintext mode when the relay offers it", async () => {
    const { notifier, sockets } = harness(happyRelayReplies(1), { security: "plaintext" });
    await notifier.send(mail());
    expect(sockets[0]!.tlsUpgrades).toBe(1);
    expect(sockets[0]!.verbs).toContain("STARTTLS");
  });

  it("still sends no credentials when a plaintext relay offers no STARTTLS", async () => {
    const replies = ["220 mail\r\n", "250-mail\r\n250 AUTH PLAIN\r\n", "221 bye\r\n"];
    const { notifier, sockets } = harness(replies, { security: "plaintext" });
    await expect(notifier.send(mail())).rejects.toThrow(/credentials over an unencrypted connection/);
    expect(sockets[0]!.written.join("")).not.toContain(PASSWORD);
  });
});
