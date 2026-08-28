import { describe, expect, it } from "vitest";
import {
  SmtpProtocolError,
  SmtpReplyReader,
  assertHeaderSafe,
  buildMimeMessage,
  dotStuff,
  encodeHeaderWord,
  formatDate,
  parseCapabilities,
} from "../src/smtp-protocol.js";

function readerOf(...chunks: string[]): SmtpReplyReader {
  const encoder = new TextEncoder();
  const queue = chunks.map((chunk) => encoder.encode(chunk));
  return new SmtpReplyReader(async () => queue.shift() ?? null);
}

describe("SMTP reply reading", () => {
  it("reads a single-line reply", async () => {
    expect(await readerOf("220 mail ESMTP\r\n").nextReply()).toEqual({ code: 220, lines: ["mail ESMTP"] });
  });

  it("reads a multi-line reply as one reply", async () => {
    const reply = await readerOf("250-mail\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n").nextReply();
    expect(reply).toEqual({ code: 250, lines: ["mail", "STARTTLS", "AUTH PLAIN"] });
  });

  it("reassembles a reply split across arbitrary chunks", async () => {
    const reader = readerOf("25", "0-ma", "il\r\n250 O", "K\r\n");
    expect(await reader.nextReply()).toEqual({ code: 250, lines: ["mail", "OK"] });
  });

  it("reports a connection that dies mid-reply instead of hanging", async () => {
    await expect(readerOf("250-mail\r\n").nextReply()).rejects.toThrow(SmtpProtocolError);
  });

  it("rejects a reply whose code is not a number", async () => {
    await expect(readerOf("hello there\r\n").nextReply()).rejects.toThrow(/unparsable reply code/);
  });

  it("rejects a reply whose code changes mid-reply", async () => {
    await expect(readerOf("250-mail\r\n500 nope\r\n").nextReply()).rejects.toThrow(/code changed/);
  });

  it("knows whether bytes are still buffered (the STARTTLS check)", async () => {
    const reader = readerOf("220 ok\r\n250 injected\r\n");
    await reader.nextReply();
    expect(reader.hasBufferedBytes).toBe(true);
  });
});

describe("EHLO capabilities", () => {
  it("skips the greeting line and upper-cases keywords", () => {
    const caps = parseCapabilities(["mail.bank.local Hello", "starttls", "AUTH plain login", "8BITMIME"]);
    expect(caps.has("STARTTLS")).toBe(true);
    expect(caps.get("AUTH")).toEqual(["PLAIN", "LOGIN"]);
    expect(caps.has("MAIL.BANK.LOCAL")).toBe(false);
  });
});

describe("message building", () => {
  const date = new Date("2026-08-08T09:00:00Z");

  it("formats the Date header per RFC 5322 in UTC", () => {
    expect(formatDate(date)).toBe("Sat, 08 Aug 2026 09:00:00 +0000");
  });

  it("leaves ASCII headers alone and encodes non-ASCII ones", () => {
    expect(encodeHeaderWord("Gate waiting")).toBe("Gate waiting");
    expect(encodeHeaderWord("Kapı bekliyor")).toBe("=?UTF-8?B?S2FwxLEgYmVrbGl5b3I=?=");
  });

  it("keeps every encoded-word line under the 75-character limit", () => {
    const encoded = encodeHeaderWord("ş".repeat(120));
    for (const line of encoded.split("\r\n")) expect(line.trim().length).toBeLessThanOrEqual(75);
  });

  it("refuses CR/LF in a header value (injection) instead of sanitising", () => {
    expect(() => assertHeaderSafe("Subject", "ok\r\nBcc: attacker@evil.example")).toThrow(SmtpProtocolError);
    expect(() =>
      buildMimeMessage({
        from: "maestro@bank.local",
        to: ["a@bank.local\r\nBcc: b@evil.example"],
        subject: "s",
        body: "b",
        date,
        messageId: "id",
      }),
    ).toThrow(/CR\/LF/);
  });

  it("escapes a leading dot so a body line cannot end the DATA block", () => {
    expect(dotStuff("hello\n.\nworld")).toBe("hello\n..\nworld");
  });

  it("builds a base64 UTF-8 body with the expected headers", () => {
    const mime = buildMimeMessage({
      from: "maestro@bank.local",
      fromName: "Maestro Kapı",
      to: ["po@bank.local", "lead@bank.local"],
      subject: "UGURPAY-501 bekliyor",
      body: "Kapı 5 bekliyor",
      date,
      messageId: "abc-123",
    });

    expect(mime).toContain("To: po@bank.local, lead@bank.local");
    expect(mime).toContain("Message-ID: <abc-123@bank.local>");
    expect(mime).toContain("Content-Transfer-Encoding: base64");
    expect(mime).toContain("=?UTF-8?B?TWFlc3RybyBLYXDEsQ==?= <maestro@bank.local>");
    const body = mime.split("\r\n\r\n")[1] ?? "";
    expect(Buffer.from(body, "base64").toString("utf8")).toBe("Kapı 5 bekliyor");
  });
});
