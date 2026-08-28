import { describe, expect, it } from "vitest";
import type { FetchLike } from "../src/deps.js";
import { StorageRequestError, UnexpectedResponseError } from "../src/errors.js";
import { S3CompatStorage, S3StorageOptions } from "../src/s3.js";

const CLOCK = () => new Date("2026-08-08T09:00:00.000Z");

const BASE = {
  endpoint: "https://s3.corp.local",
  bucket: "maestro",
  accessKeyId: "AKIA_TEST",
  secretAccessKey: "secret",
};

/** Headers every S3 API answer carries; a proxy answering instead does not. */
const S3_HEADERS = { "x-amz-request-id": "R1", "content-type": "application/xml" };

function driver(fetchImpl: FetchLike, overrides: Record<string, unknown> = {}): S3CompatStorage {
  return new S3CompatStorage(S3StorageOptions.parse({ ...BASE, ...overrides }), {
    fetch: fetchImpl,
    now: CLOCK,
  });
}

function respond(body: string, headers: Record<string, string> = S3_HEADERS): FetchLike {
  return () => Promise.resolve(new Response(body, { status: 200, headers }));
}

const LOGIN_PAGE = "<html><body>authentication required</body></html>";

describe("a 200 that did not come from the S3 API is not an empty bucket", () => {
  it("refuses a listing answered by a proxy login page", async () => {
    const port = driver(respond(LOGIN_PAGE, { "content-type": "text/html" }));
    await expect(port.list("evidence/2026/")).rejects.toBeInstanceOf(UnexpectedResponseError);
    await expect(port.list("evidence/2026/")).rejects.toBeInstanceOf(StorageRequestError);
  });

  it("refuses a listing whose root element is not ListBucketResult", async () => {
    const port = driver(respond(LOGIN_PAGE));
    await expect(port.list("evidence/2026/")).rejects.toThrow(/ListBucketResult/);
  });

  it("refuses an object body answered by a proxy login page", async () => {
    const port = driver(respond(LOGIN_PAGE, { "content-type": "text/html" }));
    await expect(port.get("evidence/2026/a.json")).rejects.toBeInstanceOf(UnexpectedResponseError);
  });

  it("refuses a put acknowledged by something that is not the S3 API", async () => {
    const port = driver(respond("OK", { "content-type": "text/plain" }));
    await expect(port.put("evidence/a.json", new Uint8Array([1]))).rejects.toBeInstanceOf(
      UnexpectedResponseError,
    );
  });

  it("can be relaxed for endpoints that strip the x-amz response headers", async () => {
    const body =
      `<ListBucketResult><IsTruncated>false</IsTruncated>` +
      `<Contents><Key>evidence/2026/a.json</Key></Contents></ListBucketResult>`;
    const port = driver(respond(body, { "content-type": "application/xml" }), {
      requireAmzResponseHeaders: false,
    });
    expect(await port.list("evidence/2026/")).toEqual(["evidence/2026/a.json"]);
  });
});

describe("truncated listings", () => {
  it("refuses a truncated page that carries no continuation token", async () => {
    const port = driver(
      respond(
        `<ListBucketResult><IsTruncated>true</IsTruncated>` +
          `<Contents><Key>evidence/2026/a.json</Key></Contents></ListBucketResult>`,
      ),
    );
    await expect(port.list("evidence/2026/")).rejects.toBeInstanceOf(StorageRequestError);
    await expect(port.list("evidence/2026/")).rejects.toThrow(/truncated/i);
  });

  it("refuses a server that repeats the same continuation token", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = () => {
      calls += 1;
      return Promise.resolve(
        new Response(
          `<ListBucketResult><IsTruncated>true</IsTruncated>` +
            `<NextContinuationToken>same</NextContinuationToken>` +
            `<Contents><Key>evidence/2026/a.json</Key></Contents></ListBucketResult>`,
          { status: 200, headers: S3_HEADERS },
        ),
      );
    };
    await expect(driver(fetchImpl).list("evidence/2026/")).rejects.toThrow(/continuation token/i);
    expect(calls).toBeLessThan(10);
  });

  it("stops at the page ceiling instead of looping forever", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = () => {
      calls += 1;
      return Promise.resolve(
        new Response(
          `<ListBucketResult><IsTruncated>true</IsTruncated>` +
            `<NextContinuationToken>token-${calls}</NextContinuationToken>` +
            `<Contents><Key>evidence/2026/${calls}.json</Key></Contents></ListBucketResult>`,
          { status: 200, headers: S3_HEADERS },
        ),
      );
    };
    await expect(driver(fetchImpl).list("evidence/2026/")).rejects.toThrow(/page/i);
    expect(calls).toBeLessThanOrEqual(10_000);
  });
});

describe("delete tells a missing key apart from a missing bucket", () => {
  function notFound(code: string | undefined): FetchLike {
    return () =>
      Promise.resolve(
        new Response(
          code === undefined ? "" : `<Error><Code>${code}</Code><Message>x</Message></Error>`,
          { status: 404, headers: S3_HEADERS },
        ),
      );
  }

  it("treats NoSuchKey as the documented no-op", async () => {
    await expect(driver(notFound("NoSuchKey")).delete("evidence/a.json")).resolves.toBeUndefined();
  });

  it("treats a bodyless 404 as a missing key", async () => {
    await expect(driver(notFound(undefined)).delete("evidence/a.json")).resolves.toBeUndefined();
  });

  it("does not report a misspelled bucket as a successful cleanup", async () => {
    await expect(driver(notFound("NoSuchBucket")).delete("evidence/a.json")).rejects.toBeInstanceOf(
      StorageRequestError,
    );
    await expect(driver(notFound("NoSuchBucket")).delete("evidence/a.json")).rejects.toThrow(
      /NoSuchBucket/,
    );
  });

  it("does not report a missing bucket as an empty object either", async () => {
    await expect(driver(notFound("NoSuchBucket")).get("evidence/a.json")).rejects.toThrow(
      /NoSuchBucket/,
    );
  });
});
