import { describe, expect, it } from "vitest";
import { decodeReply, encodeCommand, expectInteger, expectIntegerArray, RespError } from "../src/resp.js";
import { RedisProtocolError } from "../src/errors.js";

const decode = (text: string): ReturnType<typeof decodeReply> => decodeReply(Buffer.from(text, "utf8"));

describe("encodeCommand", () => {
  it("encodes every argument as a length-prefixed bulk string", () => {
    expect(Buffer.from(encodeCommand(["GET", "k"])).toString()).toBe("*2\r\n$3\r\nGET\r\n$1\r\nk\r\n");
  });

  it("encodes numbers as text, since Redis parses the argument itself", () => {
    expect(Buffer.from(encodeCommand(["EXPIRE", "k", 60])).toString()).toBe(
      "*3\r\n$6\r\nEXPIRE\r\n$1\r\nk\r\n$2\r\n60\r\n",
    );
  });

  it("cannot be used to inject a second command through a CRLF in a value", () => {
    // The whole reason nothing is sent inline. A key carrying \r\n must be
    // transported as bytes, not as a command boundary.
    const encoded = Buffer.from(encodeCommand(["SET", "k", "v\r\nFLUSHALL"])).toString();
    expect(encoded).toBe("*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$11\r\nv\r\nFLUSHALL\r\n");
    // Length 11 covers the whole payload, so the parser reads it as one value.
    expect("v\r\nFLUSHALL".length).toBe(11);
  });

  it("counts bytes, not characters, for multi-byte payloads", () => {
    const encoded = Buffer.from(encodeCommand(["SET", "k", "é"]));
    expect(encoded.toString()).toContain("$2\r\né\r\n");
  });
});

describe("decodeReply", () => {
  it("decodes a simple string", () => {
    expect(decode("+OK\r\n")).toEqual({ value: "OK", consumed: 5 });
  });

  it("decodes an integer", () => {
    expect(decode(":42\r\n")).toEqual({ value: 42, consumed: 5 });
  });

  it("decodes a negative integer", () => {
    expect(decode(":-2\r\n")).toEqual({ value: -2, consumed: 5 });
  });

  it("decodes a bulk string", () => {
    expect(decode("$5\r\nhello\r\n")).toEqual({ value: "hello", consumed: 11 });
  });

  it("decodes an empty bulk string as an empty string, not null", () => {
    expect(decode("$0\r\n\r\n")).toEqual({ value: "", consumed: 6 });
  });

  it("decodes a null bulk string as null — this is how SET NX reports refusal", () => {
    expect(decode("$-1\r\n")).toEqual({ value: null, consumed: 5 });
  });

  it("decodes a nested array", () => {
    expect(decode("*3\r\n:1\r\n:0\r\n:900\r\n")?.value).toEqual([1, 0, 900]);
  });

  it("decodes a null array as null", () => {
    expect(decode("*-1\r\n")).toEqual({ value: null, consumed: 5 });
  });

  it("surfaces an error reply as a RespError rather than a string", () => {
    const result = decode("-NOSCRIPT No matching script\r\n");
    expect(result?.value).toBeInstanceOf(RespError);
    expect((result?.value as unknown as RespError).message).toBe("NOSCRIPT No matching script");
  });

  it("does not mistake a bulk string starting with '-' for an error", () => {
    // The reason RespError is a class: a Lua script may return "-1" as text.
    const result = decode("$2\r\n-1\r\n");
    expect(result?.value).toBe("-1");
    expect(result?.value).not.toBeInstanceOf(RespError);
  });

  it("returns null for a reply that has not fully arrived", () => {
    expect(decode("$5\r\nhel")).toBeNull();
    expect(decode("*2\r\n:1\r\n")).toBeNull();
    expect(decode("+OK")).toBeNull();
  });

  it("returns null when the bulk payload arrived but its trailing CRLF has not", () => {
    // Consuming here would start the next decode mid-terminator.
    expect(decode("$5\r\nhello")).toBeNull();
    expect(decode("$5\r\nhello\r\n")).not.toBeNull();
  });

  it("consumes exactly one reply, leaving the rest for the next decode", () => {
    const buffer = Buffer.from("+OK\r\n:7\r\n", "utf8");
    const first = decodeReply(buffer);
    expect(first).toEqual({ value: "OK", consumed: 5 });
    expect(decodeReply(buffer, first?.consumed ?? 0)).toEqual({ value: 7, consumed: 4 });
  });

  it("throws on an unknown marker rather than guessing", () => {
    expect(() => decode("%1\r\n")).toThrow(RedisProtocolError);
  });

  it("throws when an integer reply is not an integer", () => {
    expect(() => decode(":abc\r\n")).toThrow(RedisProtocolError);
  });
});

describe("narrowing helpers", () => {
  it("expectInteger accepts an integer and names what arrived otherwise", () => {
    expect(expectInteger(5, "ctx")).toBe(5);
    expect(() => expectInteger(null, "lock-release")).toThrow(/lock-release: expected an integer, got nil/);
    expect(() => expectInteger("5", "ctx")).toThrow(/expected an integer, got string/);
  });

  it("expectIntegerArray maps element-wise and reports the offending index", () => {
    expect(expectIntegerArray([1, 0, 900], "ctx")).toEqual([1, 0, 900]);
    expect(() => expectIntegerArray([1, "x"], "semaphore")).toThrow(/semaphore\[1\]/);
    expect(() => expectIntegerArray(7, "semaphore")).toThrow(/expected an array/);
  });
});
