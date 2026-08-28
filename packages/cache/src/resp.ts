import { RedisProtocolError } from "./errors.js";

/**
 * RESP2 encode/decode. Pure bytes in, pure values out — no socket, no state
 * beyond the buffer handed in.
 *
 * Written here rather than pulled from `ioredis` (~2 MB with its transitive
 * tree) because this package needs exactly six verbs — EVAL, SCRIPT LOAD,
 * EVALSHA, GET, SET, DEL, PING — and a bank's dependency review is a real cost
 * paid per package. The rest of the repo already hand-rolls its wire formats
 * for the same reason: `@maestro/storage` speaks S3 over raw HTTP with its own
 * SigV4, `@maestro/runners` speaks the Docker API over a raw unix socket.
 *
 * RESP2 rather than RESP3: RESP2 is what every Redis since 2.0 answers by
 * default, and nothing this package sends has a reply whose RESP3 form carries
 * information the RESP2 form loses.
 */

/** A decoded RESP2 value. `null` covers both the null bulk string and null array. */
export type RespValue = string | number | null | RespValue[];

const CR = 0x0d;
const LF = 0x0a;

/**
 * Encode one command as a RESP array of bulk strings.
 *
 * Everything is a bulk string, including numbers: Redis parses the argument
 * text itself, and inline commands ("SET k v\r\n") are ambiguous the moment an
 * argument contains a space or a newline. A key or a Lua script that happens to
 * contain `\r\n` must not be able to inject a second command, and bulk strings
 * are length-prefixed, so it cannot.
 */
export function encodeCommand(args: readonly (string | number)[]): Uint8Array {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`, "utf8")];
  for (const arg of args) {
    const payload = Buffer.from(String(arg), "utf8");
    parts.push(Buffer.from(`$${payload.length}\r\n`, "utf8"), payload, Buffer.from("\r\n", "utf8"));
  }
  return Buffer.concat(parts);
}

export interface DecodeResult {
  readonly value: RespValue;
  /** Bytes consumed. The caller keeps the remainder for the next reply. */
  readonly consumed: number;
}

/**
 * Decode one reply, or return `null` when the buffer holds only part of one.
 *
 * The incomplete case is not an error and must never be treated as one: TCP
 * delivers a reply in as many chunks as it likes, and a decoder that threw on a
 * short read would turn a normal 1-byte-late `\n` into a connection failure.
 */
export function decodeReply(buffer: Buffer, offset = 0): DecodeResult | null {
  if (offset >= buffer.length) return null;
  const lineEnd = findCrlf(buffer, offset);
  if (lineEnd < 0) return null;

  const marker = buffer[offset];
  const line = buffer.toString("utf8", offset + 1, lineEnd);
  const afterLine = lineEnd + 2;

  switch (marker) {
    case 0x2b: // '+' simple string
      return { value: line, consumed: afterLine - offset };
    case 0x2d: // '-' error. Surfaced as a value; the client turns it into a throw.
      return { value: new RespError(line) as unknown as RespValue, consumed: afterLine - offset };
    case 0x3a: // ':' integer
      return { value: parseInteger(line), consumed: afterLine - offset };
    case 0x24: // '$' bulk string
      return decodeBulk(buffer, offset, line, afterLine);
    case 0x2a: // '*' array
      return decodeArray(buffer, offset, line, afterLine);
    default:
      throw new RedisProtocolError(`unknown reply marker 0x${(marker ?? 0).toString(16)}`);
  }
}

/**
 * An error reply, carried as a value so the decoder stays total.
 *
 * It is a distinct class rather than a string prefixed with "-" because a
 * successful bulk reply may legitimately start with a hyphen (a Lua script can
 * return "-1" as text), and a client that told those apart by looking at the
 * first character would report a working command as failed.
 */
export class RespError {
  constructor(readonly message: string) {}
}

function decodeBulk(buffer: Buffer, offset: number, line: string, afterLine: number): DecodeResult | null {
  const length = parseInteger(line);
  if (length < 0) return { value: null, consumed: afterLine - offset };
  const end = afterLine + length;
  // `end + 2`: the trailing CRLF must have arrived too, or the next decode
  // would start mid-terminator and read the following reply as garbage.
  if (buffer.length < end + 2) return null;
  return { value: buffer.toString("utf8", afterLine, end), consumed: end + 2 - offset };
}

function decodeArray(buffer: Buffer, offset: number, line: string, afterLine: number): DecodeResult | null {
  const count = parseInteger(line);
  if (count < 0) return { value: null, consumed: afterLine - offset };
  const items: RespValue[] = [];
  let cursor = afterLine;
  for (let index = 0; index < count; index += 1) {
    const element = decodeReply(buffer, cursor);
    if (element === null) return null;
    items.push(element.value);
    cursor += element.consumed;
  }
  return { value: items, consumed: cursor - offset };
}

function findCrlf(buffer: Buffer, from: number): number {
  for (let index = from; index + 1 < buffer.length; index += 1) {
    if (buffer[index] === CR && buffer[index + 1] === LF) return index;
  }
  return -1;
}

function parseInteger(line: string): number {
  const value = Number(line);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new RedisProtocolError(`expected an integer, got "${line}"`);
  }
  return value;
}

/** Narrow a reply to an integer, naming what arrived when it is not one. */
export function expectInteger(value: RespValue, context: string): number {
  if (typeof value === "number") return value;
  throw new RedisProtocolError(`${context}: expected an integer, got ${describe(value)}`);
}

/** Narrow a reply to an array of integers — the shape every Lua script here returns. */
export function expectIntegerArray(value: RespValue, context: string): number[] {
  if (!Array.isArray(value)) throw new RedisProtocolError(`${context}: expected an array, got ${describe(value)}`);
  return value.map((item, index) => expectInteger(item, `${context}[${index}]`));
}

function describe(value: RespValue): string {
  if (value === null) return "nil";
  if (Array.isArray(value)) return `an array of ${value.length}`;
  return `${typeof value} ${JSON.stringify(value)}`;
}
