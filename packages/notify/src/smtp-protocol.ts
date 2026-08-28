/**
 * SMTP wire helpers: reply reading (RFC 5321) and message building
 * (RFC 5322 + RFC 2047 + RFC 2045). Pure and byte-exact, so the protocol is
 * testable without a socket, a server or a network.
 */

export interface SmtpReply {
  code: number;
  /** Text of each reply line, continuation markers stripped. */
  lines: string[];
}

const LF = 0x0a;
const CR = 0x0d;
/** Guard against a server that streams forever instead of ending a reply. */
const MAX_REPLY_LINES = 200;
const MAX_LINE_BYTES = 4_096;

export class SmtpProtocolError extends Error {
  constructor(reason: string) {
    super(`smtp protocol violation: ${reason}`);
    this.name = "SmtpProtocolError";
  }
}

/** Line-oriented reader over the pull-based socket. Buffers partial chunks. */
export class SmtpReplyReader {
  private buffer = new Uint8Array(0);

  constructor(private readonly read: () => Promise<Uint8Array | null>) {}

  /** True when bytes are still buffered — checked before a STARTTLS upgrade. */
  get hasBufferedBytes(): boolean {
    return this.buffer.length > 0;
  }

  async nextReply(): Promise<SmtpReply> {
    const lines: string[] = [];
    let code: number | undefined;

    for (;;) {
      const line = await this.nextLine();
      if (line.length < 3) {
        throw new SmtpProtocolError(`reply line too short: ${JSON.stringify(line)}`);
      }
      // RFC 5321 §4.2: exactly three digits, then SP or "-". `Number()` is not
      // a parser — it read "2500 weird" as 250 and "1e2 exp" as 100, i.e. it
      // turned a malformed line into a plausible status code.
      const codeText = line.slice(0, 3);
      if (!/^\d{3}$/.test(codeText)) {
        throw new SmtpProtocolError(`unparsable reply code: ${JSON.stringify(codeText)}`);
      }
      if (line.length > 3 && line[3] !== " " && line[3] !== "-") {
        throw new SmtpProtocolError(`reply code is not followed by SP or "-": ${JSON.stringify(line.slice(0, 4))}`);
      }
      const parsed = Number(codeText);
      if (parsed < 100 || parsed > 599) {
        throw new SmtpProtocolError(`reply code out of range: ${codeText}`);
      }
      if (code !== undefined && parsed !== code) {
        throw new SmtpProtocolError(`reply code changed mid-reply: ${code} then ${parsed}`);
      }
      code = parsed;
      lines.push(line.slice(4).trim());
      if (lines.length > MAX_REPLY_LINES) throw new SmtpProtocolError("reply has too many lines");
      // "250-EXT" continues, "250 OK" (or a bare "250") ends the reply.
      if (line.length === 3 || line[3] !== "-") return { code, lines };
    }
  }

  private async nextLine(): Promise<string> {
    for (;;) {
      const index = this.buffer.indexOf(LF);
      if (index >= 0) {
        const end = index > 0 && this.buffer[index - 1] === CR ? index - 1 : index;
        const line = new TextDecoder().decode(this.buffer.subarray(0, end));
        this.buffer = this.buffer.slice(index + 1);
        return line;
      }
      if (this.buffer.length > MAX_LINE_BYTES) throw new SmtpProtocolError("reply line too long");
      const chunk = await this.read();
      if (chunk === null) throw new SmtpProtocolError("connection closed mid-reply");
      const merged = new Uint8Array(this.buffer.length + chunk.length);
      merged.set(this.buffer, 0);
      merged.set(chunk, this.buffer.length);
      this.buffer = merged;
    }
  }
}

/** EHLO keywords, upper-cased: "AUTH PLAIN LOGIN" → key AUTH, args [...]. */
export function parseCapabilities(lines: readonly string[]): Map<string, string[]> {
  const caps = new Map<string, string[]>();
  // The first EHLO line is the greeting ("mail.bank.local Hello"), not a capability.
  for (const line of lines.slice(1)) {
    const parts = line.trim().split(/\s+/);
    const keyword = parts.shift();
    if (keyword) caps.set(keyword.toUpperCase(), parts.map((part) => part.toUpperCase()));
  }
  return caps;
}

export interface MailMessage {
  from: string;
  fromName?: string | undefined;
  to: readonly string[];
  subject: string;
  body: string;
  date: Date;
  /** Left-hand side of the Message-ID; the domain comes from `from`. */
  messageId: string;
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** RFC 5322 date in UTC — protocol tokens, deliberately not localised. */
export function formatDate(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return (
    `${DAYS[date.getUTCDay()]}, ${pad(date.getUTCDate())} ${MONTHS[date.getUTCMonth()]} ` +
    `${date.getUTCFullYear()} ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:` +
    `${pad(date.getUTCSeconds())} +0000`
  );
}

/**
 * RFC 2047 encoded-word, base64/UTF-8, chunked so no header line exceeds the
 * 75-character limit. Pure ASCII text is returned untouched.
 */
export function encodeHeaderWord(text: string): string {
  if (/^[\x20-\x7e]*$/.test(text)) return text;
  const words: string[] = [];
  let chunk = "";
  for (const char of text) {
    // 45 source bytes -> 60 base64 chars -> 72 with the =?UTF-8?B?...?= frame.
    if (Buffer.byteLength(chunk + char, "utf8") > 45) {
      words.push(chunk);
      chunk = "";
    }
    chunk += char;
  }
  if (chunk.length > 0) words.push(chunk);
  return words.map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`).join("\r\n ");
}

/** CR/LF in a header value is header injection — refuse it, never sanitise. */
export function assertHeaderSafe(field: string, value: string): void {
  if (/[\r\n]/.test(value)) throw new SmtpProtocolError(`header "${field}" contains CR/LF`);
}

/** RFC 5321 §4.5.2: a line starting with "." is escaped inside DATA. */
export function dotStuff(text: string): string {
  return text.replace(/^\./gm, "..");
}

function base64Lines(text: string): string {
  const encoded = Buffer.from(text, "utf8").toString("base64");
  return (encoded.match(/.{1,76}/g) ?? [""]).join("\r\n");
}

/**
 * Build the DATA payload. The body is base64/UTF-8 so Turkish characters, long
 * lines and 8-bit content survive relays that only advertise 7BIT.
 */
export function buildMimeMessage(mail: MailMessage): string {
  assertHeaderSafe("From", mail.from);
  // Checked explicitly, not left to `encodeHeaderWord`: CR/LF happens to take
  // the base64 branch today, so the safety was an accident of the charset test
  // and would disappear the moment that branch changed.
  if (mail.fromName !== undefined) assertHeaderSafe("From (display name)", mail.fromName);
  assertHeaderSafe("Subject", mail.subject);
  for (const recipient of mail.to) assertHeaderSafe("To", recipient);

  const domain = mail.from.split("@")[1] ?? "localhost";
  const from = mail.fromName ? `${encodeHeaderWord(mail.fromName)} <${mail.from}>` : mail.from;
  const headers = [
    `From: ${from}`,
    `To: ${mail.to.join(", ")}`,
    `Subject: ${encodeHeaderWord(mail.subject)}`,
    `Date: ${formatDate(mail.date)}`,
    `Message-ID: <${mail.messageId}@${domain}>`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="utf-8"',
    "Content-Transfer-Encoding: base64",
  ];
  return dotStuff(`${headers.join("\r\n")}\r\n\r\n${base64Lines(mail.body)}`);
}
