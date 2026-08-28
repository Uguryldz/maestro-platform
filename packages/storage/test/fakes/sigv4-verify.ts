import { createHash, createHmac } from "node:crypto";

/**
 * Independent SigV4 verifier used by FakeS3.
 *
 * Deliberately does NOT import src/sigv4.ts: it re-derives the signature from
 * the bytes that actually reached the server (request line, query string,
 * headers, body). A canonicalisation bug in the driver therefore cannot cancel
 * itself out — the package's own tests can catch it, which is impossible when
 * the fake merely checks that an Authorization header exists.
 */

export interface VerifyCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface SignedWireRequest {
  method: string;
  url: URL;
  /** Lower-cased header names, exactly as received (no `host`: fetch owns it). */
  headers: Record<string, string>;
  body: Uint8Array;
}

const AUTHORIZATION =
  /^AWS4-HMAC-SHA256 Credential=([^/]+)\/([^,]+), SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/;

/** RFC 3986 percent-encoding, byte by byte: unreserved is `A-Za-z0-9-._~`. */
function rfc3986(value: string): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const char = String.fromCharCode(byte);
    out += /[A-Za-z0-9\-._~]/.test(char)
      ? char
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

/** Re-encodes each already-encoded path segment, so under-encoding shows up. */
function canonicalPath(pathname: string): string {
  return pathname
    .split("/")
    .map((segment) => rfc3986(decodeURIComponent(segment)))
    .join("/");
}

function canonicalQuery(search: string): string {
  const raw = search.replace(/^\?/, "");
  if (raw === "") return "";
  return raw
    .split("&")
    .map((pair) => {
      const at = pair.indexOf("=");
      const name = at < 0 ? pair : pair.slice(0, at);
      const value = at < 0 ? "" : pair.slice(at + 1);
      return [rfc3986(decodeURIComponent(name)), rfc3986(decodeURIComponent(value))] as const;
    })
    .sort((a, b) => (a[0] === b[0] ? cmp(a[1], b[1]) : cmp(a[0], b[0])))
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

function hex(payload: string | Uint8Array): string {
  return createHash("sha256").update(payload).digest("hex");
}

/** Returns undefined when the request is properly signed, else the reason. */
export function verifySigV4(
  request: SignedWireRequest,
  credentials: VerifyCredentials,
): string | undefined {
  const authorization = request.headers["authorization"];
  if (authorization === undefined) return "missing Authorization header";
  const parsed = AUTHORIZATION.exec(authorization);
  if (!parsed) return `malformed Authorization header: ${authorization}`;
  const [, accessKeyId, scope, signedHeaders, presentedSignature] = parsed as unknown as string[];
  if (accessKeyId !== credentials.accessKeyId) return `unknown access key ${accessKeyId}`;

  const [dateStamp, region, service, terminator] = (scope ?? "").split("/");
  if (terminator !== "aws4_request") return `bad credential scope: ${scope}`;

  const amzDate = request.headers["x-amz-date"];
  if (amzDate === undefined) return "missing x-amz-date";
  if (!amzDate.startsWith(dateStamp ?? "")) return `x-amz-date ${amzDate} is outside scope ${scope}`;

  const payloadHash = request.headers["x-amz-content-sha256"];
  if (payloadHash === undefined) return "missing x-amz-content-sha256";
  if (payloadHash !== "UNSIGNED-PAYLOAD" && payloadHash !== hex(request.body)) {
    return "x-amz-content-sha256 does not match the body";
  }

  const names = (signedHeaders ?? "").split(";");
  if ([...names].sort(cmp).join(";") !== names.join(";")) {
    return `SignedHeaders is not sorted: ${signedHeaders}`;
  }
  if (new Set(names).size !== names.length) return `SignedHeaders repeats a name: ${signedHeaders}`;
  if (!names.includes("host")) return "host is not signed";

  let canonicalHeaders = "";
  for (const name of names) {
    // `host` never travels as a header: it is derived from the URL, which is
    // exactly what a real endpoint compares the signature against.
    const value = name === "host" ? request.url.host : request.headers[name];
    if (value === undefined) return `signed header "${name}" was not sent`;
    canonicalHeaders += `${name}:${value.trim().replace(/\s+/g, " ")}\n`;
  }

  const canonicalRequest = [
    request.method.toUpperCase(),
    canonicalPath(request.url.pathname),
    canonicalQuery(request.url.search),
    canonicalHeaders,
    names.join(";"),
    payloadHash,
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    hex(canonicalRequest),
  ].join("\n");

  const kDate = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp ?? "");
  const kSigning = hmac(hmac(hmac(kDate, region ?? ""), service ?? ""), "aws4_request");
  const expected = createHmac("sha256", kSigning).update(stringToSign, "utf8").digest("hex");
  return expected === presentedSignature
    ? undefined
    : `signature mismatch over canonical request:\n${canonicalRequest}`;
}
