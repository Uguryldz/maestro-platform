import type { StoragePort } from "@maestro/ports";
import type { Clock, FetchInit, FetchLike } from "./deps.js";
import { systemClock } from "./deps.js";
import type { ResponseContext } from "./errors.js";
import {
  InvalidTtlError,
  ObjectLockNotConfiguredError,
  ObjectNotFoundError,
  StorageConfigError,
  StorageRequestError,
  UnexpectedResponseError,
} from "./errors.js";
import {
  assertKeyByteLength,
  assertValidKey,
  assertValidPrefix,
  encodeTagging,
  retainUntil,
  retentionClassForKey,
  retentionPolicy,
  retentionTags,
} from "./keys.js";
import { S3StorageOptions as S3StorageOptionsSchema } from "./s3-options.js";
import type { S3StorageOptions } from "./s3-options.js";
import type { Endpoint } from "./s3-http.js";
import {
  contentMd5,
  drain,
  MAX_LIST_PAGES,
  queryString,
  responseProblem,
  splitEndpoint,
} from "./s3-http.js";
import {
  canonicalUri,
  EMPTY_BODY_SHA256,
  presignQuery,
  sha256Hex,
  signRequest,
} from "./sigv4.js";
import type { SigningContext } from "./sigv4.js";
import { parseErrorCode, parseListObjectsV2 } from "./xml.js";

/** The option schema lives in its own module; re-exported for callers. */
export * from "./s3-options.js";

export interface S3StorageDeps {
  fetch: FetchLike;
  now?: Clock | undefined;
}

export class S3CompatStorage implements StoragePort {
  private readonly endpoint: Endpoint;
  private readonly now: Clock;

  constructor(
    private readonly options: S3StorageOptions,
    private readonly deps: S3StorageDeps,
  ) {
    if (options.keyPrefix !== "") assertValidPrefix(options.keyPrefix);
    this.endpoint = splitEndpoint(options.endpoint);
    this.now = deps.now ?? systemClock;
  }

  async put(
    key: string,
    data: Uint8Array,
    opts?: { contentType?: string; objectLock?: boolean },
  ): Promise<void> {
    const full = this.fullKey(key);
    // content-length is intentionally not signed: fetch owns that header and
    // strips caller-supplied values, which would invalidate the signature.
    const headers: Record<string, string> = {
      "content-type": opts?.contentType ?? "application/octet-stream",
    };
    if (this.options.tagging) {
      const retentionClass = retentionClassForKey(key, this.options.retentionClass);
      headers["x-amz-tagging"] = encodeTagging(retentionTags(retentionPolicy(retentionClass)));
    }
    if (opts?.objectLock === true) {
      const lock = this.options.objectLock;
      if (!lock) throw new ObjectLockNotConfiguredError(key);
      headers["x-amz-object-lock-mode"] = lock.mode;
      headers["x-amz-object-lock-retain-until-date"] = retainUntil(
        this.now().toISOString(),
        lock.years,
      );
      // Signed, because an Object Lock put without an integrity checksum is
      // rejected with 400 by the real endpoint.
      headers["content-md5"] = contentMd5(data);
    }
    const response = await this.send("put", key, {
      method: "PUT",
      objectKey: full,
      headers,
      body: data,
    });
    await drain(response);
  }

  async get(key: string): Promise<Uint8Array> {
    const response = await this.send("get", key, { method: "GET", objectKey: this.fullKey(key) });
    return new Uint8Array(await response.arrayBuffer());
  }

  async list(prefix: string): Promise<string[]> {
    assertValidPrefix(prefix);
    const fullPrefix = `${this.options.keyPrefix}${prefix}`;
    const keys: string[] = [];
    let continuationToken: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const query: Record<string, string> = { "list-type": "2", prefix: fullPrefix };
      if (continuationToken !== undefined) query["continuation-token"] = continuationToken;
      const response = await this.send("list", prefix, { method: "GET", objectKey: "", query }, true);
      const context: ResponseContext = { operation: "list", key: prefix, status: response.status };
      const body = await response.text();
      const parsed = parseListObjectsV2(context, body);
      for (const key of parsed.keys) keys.push(key.slice(this.options.keyPrefix.length));
      if (!parsed.isTruncated) return keys;
      const next = parsed.nextContinuationToken;
      // A truncated page without a token, or with the token we just used, means
      // the listing is incomplete or looping: never report a partial result.
      if (next === undefined) {
        throw new UnexpectedResponseError(context, "page is truncated but carries no token", body);
      }
      if (next === continuationToken) {
        throw new UnexpectedResponseError(context, "continuation token repeats", body);
      }
      continuationToken = next;
    }
    throw new StorageRequestError("list", prefix, 200, `listing exceeded ${MAX_LIST_PAGES} pages`);
  }

  /** Idempotent by contract: deleting an absent key is a no-op on both drivers. */
  async delete(key: string): Promise<void> {
    try {
      const response = await this.send("delete", key, {
        method: "DELETE",
        objectKey: this.fullKey(key),
      });
      await drain(response);
    } catch (error) {
      if (error instanceof ObjectNotFoundError) return;
      throw error;
    }
  }

  async presign(key: string, ttlSeconds: number): Promise<string> {
    const full = this.fullKey(key);
    const max = this.options.maxPresignSeconds;
    if (!Number.isInteger(ttlSeconds) || ttlSeconds <= 0 || ttlSeconds > max) {
      throw new InvalidTtlError(key, ttlSeconds, max);
    }
    const ttl = ttlSeconds;
    const { host, path } = this.address(full);
    const query = presignQuery(
      this.signingContext(),
      { method: "GET", path, headers: { host } },
      ttl,
    );
    return `${this.baseUrl(full)}?${queryString(query)}`;
  }

  private fullKey(key: string): string {
    assertValidKey(key);
    const full = `${this.options.keyPrefix}${key}`;
    // The endpoint measures the physical key, tenant prefix included.
    assertKeyByteLength(full);
    return full;
  }

  private signingContext(): SigningContext {
    return {
      region: this.options.region,
      service: "s3",
      credentials: {
        accessKeyId: this.options.accessKeyId,
        secretAccessKey: this.options.secretAccessKey,
        sessionToken: this.options.sessionToken,
      },
      date: this.now(),
    };
  }

  /** Signed path + Host header for the configured addressing style. */
  private address(objectKey: string): { host: string; path: string } {
    const suffix = objectKey === "" ? "" : `/${objectKey}`;
    if (this.options.addressing === "virtual-host") {
      return {
        host: `${this.options.bucket}.${this.endpoint.host}`,
        path: `${this.endpoint.basePath}${suffix === "" ? "/" : suffix}`,
      };
    }
    return {
      host: this.endpoint.host,
      path: `${this.endpoint.basePath}/${this.options.bucket}${suffix}`,
    };
  }

  private baseUrl(objectKey: string): string {
    const { path } = this.address(objectKey);
    const origin =
      this.options.addressing === "virtual-host"
        ? this.endpoint.origin.replace("://", `://${this.options.bucket}.`)
        : this.endpoint.origin;
    return `${origin}${canonicalUri(path)}`;
  }

  private async send(
    operation: string,
    logicalKey: string,
    request: {
      method: string;
      objectKey: string;
      headers?: Record<string, string>;
      query?: Record<string, string>;
      body?: Uint8Array;
    },
    expectXml = false,
  ): Promise<Response> {
    const { host, path } = this.address(request.objectKey);
    const payloadSha256 = request.body ? sha256Hex(request.body) : EMPTY_BODY_SHA256;
    const signed = signRequest(this.signingContext(), {
      method: request.method,
      path,
      query: request.query,
      headers: { ...request.headers, host },
      payloadSha256,
    });
    // `host` is signed but never sent explicitly: fetch derives it from the URL
    // and rejects caller-supplied values. The two always agree by construction.
    const { host: _host, ...headers } = signed;
    const query = request.query ? `?${queryString(request.query)}` : "";
    const init: FetchInit = { method: request.method, headers };
    if (request.body) init.body = request.body;
    const response = await this.deps.fetch(`${this.baseUrl(request.objectKey)}${query}`, init);
    const context: ResponseContext = { operation, key: logicalKey, status: response.status };
    if (response.ok) {
      const problem = responseProblem(response, {
        requireAmzResponseHeaders: this.options.requireAmzResponseHeaders,
        expectXml,
      });
      if (problem === undefined) return response;
      throw new UnexpectedResponseError(context, problem, await response.text());
    }
    const body = await response.text();
    const code = parseErrorCode(body);
    // A 404 for the key is the documented "absent object"; a 404 for the whole
    // bucket is a misconfiguration and must never read as a successful cleanup.
    if (code === "NoSuchKey" || (response.status === 404 && code === undefined)) {
      throw new ObjectNotFoundError(logicalKey);
    }
    throw new StorageRequestError(operation, logicalKey, response.status, body);
  }
}

export function createS3Storage(options: unknown, deps: S3StorageDeps): StoragePort {
  const parsed = S3StorageOptionsSchema.safeParse(options);
  if (!parsed.success) {
    throw new StorageConfigError(
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  return new S3CompatStorage(parsed.data, deps);
}
