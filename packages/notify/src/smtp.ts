import { randomUUID } from "node:crypto";
import type { Notification } from "@maestro/contracts";
import type { NotifyPort, SecretPort } from "@maestro/ports";
import { EmailAddress, SMTP_DRIVER, type SmtpDriverConfig } from "./config.js";
import { type Clock, type Sleep, type SocketFactory, systemClock, systemSleep } from "./deps.js";
import { NotifyPermanentError, NotifyRecipientError, NotifyTransientError, safeMessage } from "./errors.js";
import { renderMessage, requireNotification } from "./message.js";
import { sendWithRetry } from "./retry.js";
import { SmtpSession } from "./smtp-client.js";
import { buildMimeMessage } from "./smtp-protocol.js";

/**
 * E-mail channel (M45). The SMTP password is resolved from `SecretPort` at
 * send time and never stored, logged or put in an error (test/leak.test.ts).
 */
export interface SmtpDeps {
  socketFactory: SocketFactory;
  secrets: SecretPort;
  clock?: Clock;
  sleep?: Sleep;
  /** Injected so Message-ID is deterministic in tests. */
  messageId?: () => string;
}

export class SmtpNotifier implements NotifyPort {
  private readonly clock: Clock;
  private readonly sleep: Sleep;
  private readonly messageId: () => string;

  constructor(
    private readonly config: SmtpDriverConfig,
    private readonly deps: SmtpDeps,
  ) {
    this.clock = deps.clock ?? systemClock;
    this.sleep = deps.sleep ?? systemSleep;
    this.messageId = deps.messageId ?? (() => randomUUID());
  }

  async send(input: Notification): Promise<void> {
    const notification = requireNotification(SMTP_DRIVER, input);
    if (notification.channel !== SMTP_DRIVER) {
      throw new NotifyPermanentError(SMTP_DRIVER, `notification is addressed to channel "${notification.channel}"`);
    }
    const recipients = notification.to.map((recipient) => {
      const parsed = EmailAddress.safeParse(recipient);
      if (!parsed.success) throw new NotifyRecipientError(SMTP_DRIVER, recipient, "not a valid e-mail address");
      return parsed.data;
    });

    const { subject, body } = renderMessage(notification);
    const password = await this.resolvePassword();
    const data = buildMimeMessage({
      from: this.config.from,
      fromName: this.config.fromName,
      to: recipients,
      subject,
      body,
      date: this.clock(),
      messageId: this.messageId(),
    });

    // One SMTP transaction carries all recipients, so a retry re-sends to all
    // of them: the delivery guarantee here is at-least-once, as everywhere in
    // this package. Losing an approver is the failure we refuse; a duplicate
    // reminder is not.
    await sendWithRetry(
      { driver: SMTP_DRIVER, event: notification.event, policy: this.config.retry, sleep: this.sleep },
      () => this.deliver({ from: this.config.from, to: recipients, data }, password),
    );
  }

  private async resolvePassword(): Promise<string | undefined> {
    if (this.config.passwordRef === undefined) return undefined;
    if (this.config.username === undefined) {
      throw new NotifyPermanentError(SMTP_DRIVER, "passwordRef is set but username is missing");
    }
    try {
      return await this.deps.secrets.get(this.config.passwordRef);
    } catch (error) {
      throw new NotifyTransientError(
        SMTP_DRIVER,
        `secret "${this.config.passwordRef}" unavailable: ${safeMessage(error, [])}`,
      );
    }
  }

  private async deliver(
    envelope: { from: string; to: readonly string[]; data: string },
    password: string | undefined,
  ): Promise<void> {
    let session: SmtpSession | undefined;
    try {
      const socket = await this.deps.socketFactory({
        host: this.config.host,
        port: this.config.port,
        tls: this.config.security === "implicit",
        timeoutMs: this.config.requestTimeoutMs,
      });
      session = new SmtpSession(socket, this.config, password);
      await session.send(envelope);
    } catch (error) {
      if (error instanceof NotifyPermanentError || error instanceof NotifyTransientError) throw error;
      // Connect/DNS/TLS failures land here — worth another attempt.
      throw new NotifyTransientError(SMTP_DRIVER, safeMessage(error, [password]));
    } finally {
      // Closing must never decide the outcome. It used to: a 250-queued
      // followed by an ECONNRESET on close reported "not delivered" and
      // Temporal sent the mail again, while a permanent 552 vanished behind
      // the close error and nobody learned the message was rejected.
      try {
        await session?.close();
      } catch {
        /* the transaction is already decided; the socket is being dropped */
      }
    }
  }
}

export function createSmtpNotifier(config: SmtpDriverConfig, deps: SmtpDeps): SmtpNotifier {
  return new SmtpNotifier(config, deps);
}
