import { createHash } from "node:crypto";
import { uriEncode } from "./sigv4.js";

/** HTTP plumbing shared by the s3-compat driver, kept out of the driver body. */

export interface Endpoint {
  origin: string;
  host: string;
  basePath: string;
}

export function splitEndpoint(endpoint: string): Endpoint {
  const url = new URL(endpoint);
  const basePath = url.pathname.replace(/\/+$/, "");
  return { origin: url.origin, host: url.host, basePath };
}

export function queryString(query: Record<string, string>): string {
  return Object.entries(query)
    .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
    .join("&");
}

export async function drain(response: Response): Promise<void> {
  await response.arrayBuffer();
}

/**
 * Base64 MD5 of the body. AWS PutObject: "The Content-MD5 or
 * x-amz-sdk-checksum-algorithm header is required for any request to upload an
 * object with a retention period configured using Amazon S3 Object Lock."
 * Without it an Object Lock bucket answers 400 and no evidence is ever written.
 */
export function contentMd5(data: Uint8Array): string {
  return createHash("md5").update(data).digest("base64");
}

/**
 * Ceiling on ListObjectsV2 pages, ~10M keys at the S3 page size. A gateway that
 * keeps claiming "more results" can otherwise spin the driver forever.
 */
export const MAX_LIST_PAGES = 10_000;

/**
 * Why a 2xx response cannot be trusted, or undefined when it can.
 *
 * Every S3 API answer carries `x-amz-request-id`; a corporate proxy that
 * intercepts the call and replies with its own login page does not. Without
 * this check that page becomes an empty listing or a 25-byte "object".
 */
export function responseProblem(
  response: Response,
  options: { requireAmzResponseHeaders: boolean; expectXml: boolean },
): string | undefined {
  if (
    options.requireAmzResponseHeaders &&
    response.headers.get("x-amz-request-id") === null &&
    response.headers.get("x-amz-id-2") === null
  ) {
    return "no x-amz-request-id header: the answer did not come from the S3 API";
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (options.expectXml && !/\bxml\b/i.test(contentType)) {
    return `expected an XML body, got content-type "${contentType || "(none)"}"`;
  }
  return undefined;
}
