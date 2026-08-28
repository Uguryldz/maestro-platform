import { createHash, createHmac } from "node:crypto";

/**
 * AWS Signature Version 4, implemented in-house on node:crypto.
 *
 * Rationale: the target is a corporate S3-compatible endpoint, not AWS, so the
 * official SDK's credential-provider chain, retry stack and IMDS lookups are
 * dead weight and an egress risk. SigV4 itself is ~150 lines of hashing; the
 * known-answer vectors in test/sigv4.test.ts pin it to the published spec.
 */

export const ALGORITHM = "AWS4-HMAC-SHA256";
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
export const EMPTY_BODY_SHA256 = sha256Hex("");

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** STS session token; when present it is signed as x-amz-security-token. */
  sessionToken?: string | undefined;
}

export interface SigV4Request {
  method: string;
  /** Absolute path, already starting with "/". Not yet URI-encoded. */
  path: string;
  /** Query parameters; encoded and sorted by this module. */
  query?: Record<string, string>;
  /** Header names are lower-cased before signing. Must include "host". */
  headers: Record<string, string>;
  /** Hex sha256 of the body, or UNSIGNED_PAYLOAD. */
  payloadSha256: string;
}

export interface SigningContext {
  region: string;
  service: string;
  credentials: SigV4Credentials;
  /** Signing instant; injected so signatures are deterministic in tests. */
  date: Date;
}

export function sha256Hex(payload: string | Uint8Array): string {
  return createHash("sha256").update(payload).digest("hex");
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** `20130524T000000Z` */
export function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]/g, "").replace(/\.\d{3}/, "");
}

/** `20130524` */
export function amzDateStamp(date: Date): string {
  return amzDate(date).slice(0, 8);
}

/**
 * RFC 3986 encoding. `encodeURIComponent` leaves ! ' ( ) * unescaped, which AWS
 * requires to be percent-encoded.
 */
export function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Canonical URI. For S3 each path segment is encoded exactly once — S3 is the
 * documented exception to SigV4's double-encoding rule.
 */
export function canonicalUri(path: string): string {
  if (path === "" || path === "/") return "/";
  return path
    .split("/")
    .map((segment) => uriEncode(segment))
    .join("/");
}

export function canonicalQueryString(query: Record<string, string>): string {
  return Object.entries(query)
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? compare(a[1], b[1]) : compare(a[0], b[0])))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

interface CanonicalHeaders {
  canonical: string;
  signedHeaders: string;
}

function canonicalHeaders(headers: Record<string, string>): CanonicalHeaders {
  // Names differing only in case are ONE header: AWS wants their values joined
  // with a comma and the name listed once, not "host;host".
  const merged = new Map<string, string[]>();
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    const values = merged.get(lower);
    const trimmed = value.trim().replace(/\s+/g, " ");
    if (values) values.push(trimmed);
    else merged.set(lower, [trimmed]);
  }
  const normalized = [...merged]
    .map(([k, v]) => [k, v.join(",")] as const)
    .sort((a, b) => compare(a[0], b[0]));
  return {
    canonical: normalized.map(([k, v]) => `${k}:${v}\n`).join(""),
    signedHeaders: normalized.map(([k]) => k).join(";"),
  };
}

export function canonicalRequest(request: SigV4Request): {
  text: string;
  signedHeaders: string;
} {
  const { canonical, signedHeaders } = canonicalHeaders(request.headers);
  const text = [
    request.method.toUpperCase(),
    canonicalUri(request.path),
    canonicalQueryString(request.query ?? {}),
    canonical,
    signedHeaders,
    request.payloadSha256,
  ].join("\n");
  return { text, signedHeaders };
}

export function credentialScope(ctx: SigningContext): string {
  return `${amzDateStamp(ctx.date)}/${ctx.region}/${ctx.service}/aws4_request`;
}

export function stringToSign(ctx: SigningContext, canonicalRequestText: string): string {
  return [ALGORITHM, amzDate(ctx.date), credentialScope(ctx), sha256Hex(canonicalRequestText)].join(
    "\n",
  );
}

/** kSigning = HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), service), "aws4_request") */
export function signingKey(
  secretAccessKey: string,
  dateStamp: string,
  region: string,
  service: string,
): Buffer {
  const kDate = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, "aws4_request");
}

export function signature(ctx: SigningContext, canonicalRequestText: string): string {
  const key = signingKey(
    ctx.credentials.secretAccessKey,
    amzDateStamp(ctx.date),
    ctx.region,
    ctx.service,
  );
  return createHmac("sha256", key).update(stringToSign(ctx, canonicalRequestText), "utf8").digest("hex");
}

/**
 * Header-based signing: returns the full header set to send, including
 * Authorization, x-amz-date, x-amz-content-sha256 and the optional token.
 */
export function signRequest(ctx: SigningContext, request: SigV4Request): Record<string, string> {
  const headers: Record<string, string> = {
    ...request.headers,
    "x-amz-date": amzDate(ctx.date),
    "x-amz-content-sha256": request.payloadSha256,
  };
  if (ctx.credentials.sessionToken) {
    headers["x-amz-security-token"] = ctx.credentials.sessionToken;
  }
  const { text, signedHeaders } = canonicalRequest({ ...request, headers });
  const sig = signature(ctx, text);
  headers["authorization"] =
    `${ALGORITHM} Credential=${ctx.credentials.accessKeyId}/${credentialScope(ctx)}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${sig}`;
  return headers;
}

/**
 * Query-based signing (presigned URL). Only `host` is signed, the payload is
 * declared unsigned, and the credentials travel in the query string.
 */
export function presignQuery(
  ctx: SigningContext,
  request: Omit<SigV4Request, "payloadSha256">,
  expiresInSeconds: number,
): Record<string, string> {
  const query: Record<string, string> = {
    ...(request.query ?? {}),
    "X-Amz-Algorithm": ALGORITHM,
    "X-Amz-Credential": `${ctx.credentials.accessKeyId}/${credentialScope(ctx)}`,
    "X-Amz-Date": amzDate(ctx.date),
    "X-Amz-Expires": String(expiresInSeconds),
    "X-Amz-SignedHeaders": [...new Set(Object.keys(request.headers).map((h) => h.toLowerCase()))]
      .sort(compare)
      .join(";"),
  };
  if (ctx.credentials.sessionToken) {
    query["X-Amz-Security-Token"] = ctx.credentials.sessionToken;
  }
  const { text } = canonicalRequest({ ...request, query, payloadSha256: UNSIGNED_PAYLOAD });
  return { ...query, "X-Amz-Signature": signature(ctx, text) };
}
