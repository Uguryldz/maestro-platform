import { SMTP_DRIVER, type SmtpDriverConfig } from "./config.js";
import type { SocketLike, TlsInfo } from "./deps.js";
import { NotifyPermanentError, NotifyTransientError, redact, safeMessage } from "./errors.js";
import { parseCapabilities, type SmtpReply, SmtpReplyReader } from "./smtp-protocol.js";

/**
 * Minimal SMTP submission client: EHLO → STARTTLS → AUTH → MAIL → RCPT → DATA.
 *
 * Written by hand rather than pulled from npm (see RAPOR): the flow is ~150
 * lines of a stable 1982 protocol, whereas nodemailer would add a large
 * transitive surface to a bank's build for one code path — and, decisively,
 * its socket is not injectable, so every test here would need a live server.
 *
 * Fail-closed by construction:
 *  - an advertised STARTTLS is ALWAYS taken, whatever the configured mode: an
 *    internal relay is still a bank network, and gate contents crossing it in
 *    cleartext is not a trade-off anyone chose;
 *  - `security: "starttls"` additionally REQUIRES the upgrade, so a relay that
 *    stops advertising it fails loudly instead of silently downgrading;
 *  - an encrypted connection is VERIFIED (chain, protocol version, SNI) before
 *    anything else is written — an upgrade nobody checked is not protection;
 *  - credentials are never sent over an unencrypted channel;
 *  - a rejected recipient aborts the whole message instead of delivering to
 *    "most" approvers.
 */
export const SMTP_OK = 250;

/** TLS 1.0/1.1 are withdrawn (RFC 8996); anything older is not a protocol. */
const ACCEPTED_TLS = new Set(["TLSv1.2", "TLSv1.3"]);

export interface SmtpEnvelope {
  from: string;
  to: readonly string[];
  /** Ready-made DATA payload (headers + body), CRLF-terminated lines. */
  data: string;
}

export class SmtpSession {
  private readonly reader: SmtpReplyReader;
  private readonly encoder = new TextEncoder();
  /** Every wire form of the password, for masking. See `wireForms`. */
  private readonly secrets: readonly string[];
  private tlsActive = false;

  constructor(
    private readonly socket: SocketLike,
    private readonly config: SmtpDriverConfig,
    private readonly password: string | undefined,
  ) {
    this.reader = new SmtpReplyReader(() => socket.read());
    this.secrets = wireForms(config.username, password);
  }

  /** Runs the whole submission. Throws transient/permanent; never partial. */
  async send(envelope: SmtpEnvelope): Promise<void> {
    if (this.config.security === "implicit") {
      // Implicit TLS: the socket claims it was encrypted from byte 0. Claims
      // are checked before the greeting is even read.
      this.assertTls(await this.socket.tlsInfo(), "implicit TLS");
      this.tlsActive = true;
    }
    await this.expect(await this.read(), [220], "greeting");
    let caps = await this.ehlo();

    if (!this.tlsActive) {
      const advertised = caps.has("STARTTLS");
      if (!advertised && this.config.security === "starttls") {
        throw new NotifyPermanentError(SMTP_DRIVER, "server does not advertise STARTTLS — refusing to send in cleartext");
      }
      if (advertised) {
        // Taken even in "plaintext" mode: the relay offered protection, and
        // declining it would put approval contents on the wire for free.
        await this.command("STARTTLS", [220], "STARTTLS");
        if (this.reader.hasBufferedBytes) {
          // Bytes sent before the handshake cannot be trusted after it
          // (a classic STARTTLS command-injection).
          throw new NotifyPermanentError(SMTP_DRIVER, "server sent data before the TLS handshake");
        }
        this.assertTls(await this.socket.startTls(), "STARTTLS");
        this.tlsActive = true;
        caps = await this.ehlo(); // capabilities are re-negotiated after upgrade
      }
    }

    await this.authenticate(caps);
    await this.command(`MAIL FROM:<${envelope.from}>`, [SMTP_OK], "MAIL FROM");
    for (const recipient of envelope.to) {
      await this.command(`RCPT TO:<${recipient}>`, [SMTP_OK, 251], `RCPT TO <${recipient}>`);
    }
    await this.command("DATA", [354], "DATA");
    await this.write(`${envelope.data}\r\n.\r\n`);
    await this.expect(await this.read(), [SMTP_OK], "message body");
  }

  /**
   * Best-effort close: QUIT is courtesy, the socket close is what matters, and
   * NEITHER may throw. A failing close used to replace the real outcome — a
   * queued 250 became "not delivered" (and Temporal re-sent the mail), and a
   * permanent 552 disappeared entirely.
   */
  async close(): Promise<void> {
    try {
      await this.write("QUIT\r\n");
      await this.read();
    } catch {
      /* the server may drop the connection first — nothing to salvage */
    }
    try {
      await this.socket.close();
    } catch {
      /* the socket is being discarded anyway */
    }
  }

  /**
   * Verifies what the transport reported about the encrypted session. Anything
   * short of "verified chain, modern protocol, the host we meant to reach" is
   * permanent: retrying an unverified relay just leaks the password again.
   */
  private assertTls(info: TlsInfo | null, step: string): void {
    if (info === null) {
      throw new NotifyPermanentError(SMTP_DRIVER, `${step}: the transport reports no TLS session`);
    }
    if (!info.authorized) {
      throw new NotifyPermanentError(
        SMTP_DRIVER,
        `${step}: peer certificate was not verified (${info.authorizationError ?? "no reason given"})`,
      );
    }
    if (!ACCEPTED_TLS.has(info.protocol)) {
      throw new NotifyPermanentError(SMTP_DRIVER, `${step}: negotiated ${info.protocol}, TLS 1.2+ required`);
    }
    if (info.servername !== this.config.host) {
      throw new NotifyPermanentError(
        SMTP_DRIVER,
        `${step}: handshake used servername "${info.servername}" but the configured host is "${this.config.host}"`,
      );
    }
  }

  private async ehlo(): Promise<Map<string, string[]>> {
    const reply = await this.command(`EHLO ${this.config.ehloName}`, [SMTP_OK], "EHLO");
    return parseCapabilities(reply.lines);
  }

  private async authenticate(caps: Map<string, string[]>): Promise<void> {
    if (this.config.username === undefined || this.password === undefined) return;
    if (!this.tlsActive && !this.config.allowInsecureAuth) {
      throw new NotifyPermanentError(SMTP_DRIVER, "refusing to send credentials over an unencrypted connection");
    }
    const mechanisms = caps.get("AUTH") ?? [];
    // `echoReply: false` on every AUTH step: a relay that rejects the login
    // routinely quotes the credential it received back at us, and the quoted
    // form is base64, not the password — masking the raw password alone let it
    // straight through into the error message.
    if (mechanisms.includes("PLAIN")) {
      const token = b64(`\0${this.config.username}\0${this.password}`);
      await this.command(`AUTH PLAIN ${token}`, [235], "AUTH PLAIN", false);
      return;
    }
    if (mechanisms.includes("LOGIN")) {
      await this.command("AUTH LOGIN", [334], "AUTH LOGIN", false);
      await this.command(b64(this.config.username), [334], "AUTH LOGIN (user)", false);
      await this.command(b64(this.password), [235], "AUTH LOGIN (password)", false);
      return;
    }
    throw new NotifyPermanentError(
      SMTP_DRIVER,
      `credentials are configured but the server offers no supported AUTH mechanism (${mechanisms.join(",") || "none"})`,
    );
  }

  /**
   * Sends one command line and checks the reply. The command text is NEVER
   * echoed into an error — `AUTH PLAIN <base64>` carries the password — which
   * is why every call passes a human-readable `step` label instead.
   *
   * A CR/LF in any argument would be a second command: the whole line is
   * refused rather than sanitised, because "what did the relay actually
   * execute" must never depend on our trimming rules.
   */
  private async command(line: string, accept: number[], step: string, echoReply = true): Promise<SmtpReply> {
    if (/[\r\n]/.test(line)) {
      throw new NotifyPermanentError(SMTP_DRIVER, `${step}: command argument contains CR/LF (SMTP command injection)`);
    }
    await this.write(`${line}\r\n`);
    return this.expect(await this.read(), accept, step, echoReply);
  }

  private async read(): Promise<SmtpReply> {
    try {
      return await this.reader.nextReply();
    } catch (error) {
      throw new NotifyTransientError(SMTP_DRIVER, safeMessage(error, this.secrets));
    }
  }

  private async write(text: string): Promise<void> {
    try {
      await this.socket.write(this.encoder.encode(text));
    } catch (error) {
      throw new NotifyTransientError(SMTP_DRIVER, safeMessage(error, this.secrets));
    }
  }

  /** 4xx is retryable (greylisting, mailbox busy); 5xx is final. */
  private expect(reply: SmtpReply, accept: number[], step: string, echoReply = true): SmtpReply {
    if (accept.includes(reply.code)) return reply;
    const text = echoReply ? `: ${redact(reply.lines.join(" "), this.secrets)}` : "";
    const reason = `${step} rejected with ${reply.code}${text}`;
    if (reply.code >= 400 && reply.code < 500) throw new NotifyTransientError(SMTP_DRIVER, reason);
    throw new NotifyPermanentError(SMTP_DRIVER, reason);
  }
}

function b64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/**
 * Every shape the password takes ON THE WIRE. Masking the raw value alone was
 * theatre: what a relay echoes back is the base64 SASL token, and decoding it
 * hands over `\0user\0password` in full.
 */
function wireForms(username: string | undefined, password: string | undefined): string[] {
  if (password === undefined) return [];
  const forms = [password, b64(password)];
  if (username !== undefined) forms.push(b64(`\0${username}\0${password}`), b64(username));
  // Base64 padding is often stripped when a server quotes a token back.
  return [...new Set(forms.flatMap((form) => [form, form.replace(/=+$/, "")]))];
}
