import { describe, expect, it } from "vitest";
import { SmtpDriverConfig } from "../src/config.js";
import type { SocketTarget } from "../src/deps.js";
import { NotifyRecipientError } from "../src/errors.js";
import { createSmtpNotifier } from "../src/smtp.js";
import { FakeSocket, type FakeSocketOptions, aNotification, fakeSecrets, fakeSleep, happyRelayReplies } from "./helpers.js";

const PASSWORD = "sup3r-secret-relay-pw";

function config(overrides: Record<string, unknown> = {}) {
  return SmtpDriverConfig.parse({
    host: "mail.bank.local",
    port: 587,
    from: "maestro@bank.local",
    fromName: "Maestro",
    username: "maestro-svc",
    passwordRef: "notify/smtp/password",
    retry: { maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 10 },
    ...overrides,
  });
}

function harness(scripts: string[][], overrides: Record<string, unknown> = {}, socketOptions: FakeSocketOptions = {}) {
  const sockets: FakeSocket[] = [];
  const targets: SocketTarget[] = [];
  const notifier = createSmtpNotifier(config(overrides), {
    socketFactory: async (target) => {
      // Implicit TLS means the transport hands back an already-encrypted
      // socket; the driver verifies that claim before it writes anything.
      const socket = new FakeSocket(scripts[sockets.length] ?? [], {
        secureFromStart: target.tls,
        ...socketOptions,
      });
      targets.push(target);
      sockets.push(socket);
      return socket;
    },
    secrets: fakeSecrets({ "notify/smtp/password": PASSWORD }),
    clock: () => new Date("2026-08-08T06:00:00Z"),
    sleep: fakeSleep().sleep,
    messageId: () => "fixed-id",
  });
  return { notifier, sockets, targets };
}

const mail = () => aNotification({ channel: "smtp", to: ["po@bank.local", "lead@bank.local"] });

describe("smtp driver (M45)", () => {
  it("runs EHLO → STARTTLS → EHLO → AUTH → MAIL → RCPT → DATA → QUIT", async () => {
    const { notifier, sockets, targets } = harness([happyRelayReplies()]);
    await notifier.send(mail());

    const socket = sockets[0]!;
    expect(socket.verbs).toEqual([
      "EHLO",
      "STARTTLS",
      "EHLO",
      "AUTH",
      "MAIL",
      "RCPT",
      "RCPT",
      "DATA",
      "From:",
      "QUIT",
    ]);
    expect(socket.tlsUpgrades).toBe(1);
    expect(socket.closed).toBe(1);
    expect(targets[0]).toEqual({ host: "mail.bank.local", port: 587, tls: false, timeoutMs: 20_000 });
    expect(socket.written).toContain("MAIL FROM:<maestro@bank.local>\r\n");
    expect(socket.written).toContain("RCPT TO:<lead@bank.local>\r\n");
    expect(socket.written.at(-2)).toMatch(/\r\n\.\r\n$/);
  });

  it("sends AUTH PLAIN with the password resolved from SecretPort", async () => {
    const { notifier, sockets } = harness([happyRelayReplies()]);
    await notifier.send(mail());
    const auth = sockets[0]!.written.find((line) => line.startsWith("AUTH PLAIN"))!;
    const token = auth.trim().split(" ")[2]!;
    expect(Buffer.from(token, "base64").toString("utf8")).toBe(`\0maestro-svc\0${PASSWORD}`);
  });

  it("falls back to AUTH LOGIN when PLAIN is not offered", async () => {
    const replies = [
      "220 mail\r\n",
      "250-mail\r\n250-STARTTLS\r\n250 AUTH LOGIN\r\n",
      "220 go ahead\r\n",
      "250-mail\r\n250 AUTH LOGIN\r\n",
      "334 VXNlcm5hbWU6\r\n",
      "334 UGFzc3dvcmQ6\r\n",
      "235 ok\r\n",
      "250 ok\r\n",
      "250 ok\r\n",
      "354 go\r\n",
      "250 queued\r\n",
      "221 bye\r\n",
    ];
    const { notifier, sockets } = harness([replies]);
    await notifier.send(aNotification({ channel: "smtp", to: ["po@bank.local"] }));
    const written = sockets[0]!.written;
    expect(written).toContain("AUTH LOGIN\r\n");
    expect(Buffer.from(written[4]!.trim(), "base64").toString("utf8")).toBe("maestro-svc");
    expect(Buffer.from(written[5]!.trim(), "base64").toString("utf8")).toBe(PASSWORD);
  });

  it("refuses to send when the relay does not advertise STARTTLS", async () => {
    const { notifier, sockets } = harness([["220 mail\r\n", "250-mail\r\n250 AUTH PLAIN\r\n", "221 bye\r\n"]]);
    await expect(notifier.send(mail())).rejects.toThrow(/does not advertise STARTTLS/);
    expect(sockets[0]!.written.join("")).not.toContain("AUTH");
  });

  // NOTE: this relay does NOT advertise STARTTLS, which is the only reason the
  // connection stays in the clear — `smtp-hardening.test.ts` covers the case
  // where it does advertise it and the upgrade is taken regardless of mode.
  it("never sends credentials over an unencrypted connection", async () => {
    const { notifier, sockets } = harness([["220 mail\r\n", "250-mail\r\n250 AUTH PLAIN\r\n", "221 bye\r\n"]], {
      security: "plaintext",
    });
    await expect(notifier.send(mail())).rejects.toThrow(/credentials over an unencrypted connection/);
    expect(sockets[0]!.written.join("")).not.toContain(PASSWORD);
  });

  it("connects with implicit TLS when configured, and skips STARTTLS", async () => {
    const replies = [
      "220 mail\r\n",
      "250-mail\r\n250 AUTH PLAIN\r\n",
      "235 ok\r\n",
      "250 ok\r\n",
      "250 ok\r\n",
      "354 go\r\n",
      "250 queued\r\n",
      "221 bye\r\n",
    ];
    const { notifier, sockets, targets } = harness([replies], { security: "implicit", port: 465 });
    await notifier.send(aNotification({ channel: "smtp", to: ["po@bank.local"] }));
    expect(targets[0]?.tls).toBe(true);
    expect(sockets[0]!.verbs).not.toContain("STARTTLS");
    expect(sockets[0]!.tlsUpgrades).toBe(0);
  });

  it("aborts the whole message when one recipient is rejected", async () => {
    const replies = happyRelayReplies();
    replies[6] = "550 no such mailbox\r\n";
    const { notifier, sockets } = harness([replies]);
    await expect(notifier.send(mail())).rejects.toThrow(/RCPT TO <po@bank.local> rejected with 550/);
    expect(sockets[0]!.verbs).not.toContain("DATA");
  });

  it("retries a 4xx greylisting on a fresh connection", async () => {
    const first = ["421 try later\r\n"];
    const { notifier, sockets } = harness([first, happyRelayReplies()]);
    await notifier.send(mail());
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.verbs).toContain("DATA");
  });

  it("does not retry a 5xx and reports it", async () => {
    const replies = happyRelayReplies();
    replies[9] = "552 message too large\r\n";
    const { notifier, sockets } = harness([replies, happyRelayReplies()]);
    await expect(notifier.send(mail())).rejects.toThrow(/not delivered after 1 attempt/);
    expect(sockets).toHaveLength(1);
  });

  it("rejects data injected before the TLS handshake", async () => {
    const replies = happyRelayReplies();
    replies[2] = "220 ready\r\n250 injected\r\n";
    const { notifier, sockets } = harness([replies]);
    await expect(notifier.send(mail())).rejects.toThrow(/before the TLS handshake/);
    expect(sockets[0]!.tlsUpgrades).toBe(0);
  });

  it("rejects a recipient that is not an e-mail address", async () => {
    const { notifier, sockets } = harness([happyRelayReplies()]);
    await expect(notifier.send(aNotification({ channel: "smtp", to: ["ops"] }))).rejects.toThrow(
      NotifyRecipientError,
    );
    expect(sockets).toHaveLength(0);
  });

  it("sends the rendered catalog text as the base64 body", async () => {
    const { notifier, sockets } = harness([happyRelayReplies()]);
    await notifier.send(mail());
    const data = sockets[0]!.written.at(-2)!;
    const body = data.split("\r\n\r\n")[1]!.replace(/\r\n\.\r\n$/, "");
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("UGURPAY-501 için 5 bekliyor — sorumlu: Ayşe");
    expect(data).toContain("Date: Sat, 08 Aug 2026 06:00:00 +0000");
  });

  it("fails loudly when passwordRef is set without a username", async () => {
    const { notifier } = harness([happyRelayReplies()], { username: undefined });
    await expect(notifier.send(mail())).rejects.toThrow(/passwordRef is set but username is missing/);
  });
});
