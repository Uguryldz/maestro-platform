import { describe, expect, it } from "vitest";
import { DockerResponseError } from "../src/errors.js";
import { decodeResponse, encodeRequest, query } from "../src/http.js";
import { FIXTURES, httpResponse } from "./helpers.js";

const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString("utf8");

describe("request encoding", () => {
  it("writes a request line, the mandatory headers and no body", () => {
    const wire = text(encodeRequest({ method: "GET", path: "/v1.44/containers/json" }));

    expect(wire.startsWith("GET /v1.44/containers/json HTTP/1.1\r\n")).toBe(true);
    expect(wire).toContain("Host: docker\r\n");
    expect(wire).toContain("Connection: close\r\n");
    expect(wire).not.toContain("Content-Length");
    expect(wire.endsWith("\r\n\r\n")).toBe(true);
  });

  it("adds content-type and a BYTE length for a JSON body", () => {
    const body = JSON.stringify({ Name: "ölçüm" });
    const wire = text(encodeRequest({ method: "POST", path: "/v1.44/volumes/create", body }));

    expect(wire).toContain("Content-Type: application/json\r\n");
    expect(wire).toContain(`Content-Length: ${Buffer.byteLength(body, "utf8")}\r\n`);
    expect(wire.endsWith(body)).toBe(true);
    // Multi-byte characters make byte length differ from string length; the
    // header must be the byte count or the daemon truncates the body.
    expect(Buffer.byteLength(body, "utf8")).toBeGreaterThan(body.length);
  });

  it("keeps the connection non-persistent so a response ends at EOF", () => {
    expect(text(encodeRequest({ method: "DELETE", path: "/x" }))).toContain("Connection: close");
  });
});

describe("response decoding", () => {
  it("reads the real recorded 201 from Docker Engine 29.4", () => {
    const response = decodeResponse(FIXTURES.create());

    expect(response.status).toBe(201);
    expect(response.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(text(response.body))).toMatchObject({ Warnings: [] });
  });

  it("decodes the recorded chunked wait response", () => {
    const response = decodeResponse(FIXTURES.wait());

    expect(response.headers["transfer-encoding"]).toBe("chunked");
    expect(JSON.parse(text(response.body))).toEqual({ StatusCode: 7 });
  });

  it("handles a 204 with no body", () => {
    const response = decodeResponse(FIXTURES.start());

    expect(response.status).toBe(204);
    expect(response.body.byteLength).toBe(0);
  });

  it("keeps the recorded 404 body so the error can quote the daemon", () => {
    const response = decodeResponse(FIXTURES.notFound());

    expect(response.status).toBe(404);
    expect(text(response.body)).toContain("No such container");
  });

  it("joins multi-chunk bodies in order", () => {
    const wire = Buffer.concat([
      Buffer.from("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n", "utf8"),
      Buffer.from("5\r\nhello\r\n6\r\n world\r\n0\r\n\r\n", "utf8"),
    ]);

    expect(text(decodeResponse(wire).body)).toBe("hello world");
  });

  it("ignores chunk extensions and accepts upper-case hex sizes", () => {
    const wire = Buffer.from(
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nA;name=v\r\n0123456789\r\n0\r\n\r\n",
      "utf8",
    );

    expect(text(decodeResponse(wire).body)).toBe("0123456789");
  });

  it("refuses a body shorter than its content-length instead of returning the fragment", () => {
    const wire = Buffer.from("HTTP/1.1 200 OK\r\nContent-Length: 40\r\n\r\n{\"StatusCode\":0", "utf8");

    expect(() => decodeResponse(wire)).toThrow(DockerResponseError);
  });

  it("refuses a truncated chunk body", () => {
    const wire = Buffer.from("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n20\r\nshort\r\n", "utf8");

    expect(() => decodeResponse(wire)).toThrow(/truncated chunk body/);
  });

  it("refuses garbage instead of guessing", () => {
    expect(() => decodeResponse(Buffer.from("not http at all", "utf8"))).toThrow(/header terminator/);
    expect(() => decodeResponse(Buffer.from("GARBAGE\r\n\r\n", "utf8"))).toThrow(/status line/);
    expect(() => decodeResponse(httpResponse(200, "x", { headers: { "Content-Length": "abc" } }))).toThrow(
      /content-length/,
    );
  });

  it("falls back to close-delimited framing when neither header is present", () => {
    const wire = httpResponse(200, "{\"ok\":true}", { omitLength: true });

    expect(text(decodeResponse(wire).body)).toBe("{\"ok\":true}");
  });

  it("lower-cases header names so lookups are stable", () => {
    const wire = httpResponse(200, "{}", { headers: { "X-Odd-CASE": "1" } });

    expect(decodeResponse(wire).headers["x-odd-case"]).toBe("1");
  });
});

describe("query building", () => {
  it("drops undefined values and encodes the rest", () => {
    expect(query({ name: "maestro run/1", force: true, tail: 100, signal: undefined })).toBe(
      "?name=maestro%20run%2F1&force=true&tail=100",
    );
  });

  it("returns an empty string when nothing is set", () => {
    expect(query({ signal: undefined })).toBe("");
  });
});
