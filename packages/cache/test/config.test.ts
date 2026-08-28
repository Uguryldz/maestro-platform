import { describe, expect, it } from "vitest";
import { loadEnv } from "@maestro/config";
import { endpoint, parseRedisUrl } from "../src/client.js";
import { buildCoordination, resolveCacheMode } from "../src/config.js";
import { CacheConfigError } from "../src/errors.js";
import { FakeRedisClient } from "../src/fake-client.js";

describe("parseRedisUrl", () => {
  it("parses host and port", () => {
    const options = parseRedisUrl("redis://cache.internal:6380");
    expect(options.host).toBe("cache.internal");
    expect(options.port).toBe(6380);
    expect(options.tls).toBe(false);
  });

  it("defaults the port to 6379", () => {
    expect(parseRedisUrl("redis://localhost").port).toBe(6379);
  });

  it("reads the database index from the path", () => {
    expect(parseRedisUrl("redis://localhost:6379/3").db).toBe(3);
    expect(parseRedisUrl("redis://localhost:6379").db).toBe(0);
    expect(parseRedisUrl("redis://localhost:6379/").db).toBe(0);
  });

  it("turns rediss:// into a TLS connection", () => {
    expect(parseRedisUrl("rediss://cache.bank.internal:6380").tls).toBe(true);
  });

  it("extracts credentials and percent-decodes them", () => {
    // A password containing `@` must be encoded in the URL; passing the encoded
    // form to AUTH would fail with a message that blames the credential.
    const options = parseRedisUrl("redis://maestro:p%40ss%2Fword@host:6379");
    expect(options.username).toBe("maestro");
    expect(options.password).toBe("p@ss/word");
  });

  it("carries no credential in the string used for errors and logs (M80)", () => {
    const options = parseRedisUrl("redis://user:supersecret@host:6379");
    const printed = endpoint(options);
    expect(printed).toBe("host:6379");
    expect(printed).not.toContain("supersecret");
    expect(printed).not.toContain("user");
  });

  it("refuses a non-redis scheme", () => {
    expect(() => parseRedisUrl("http://localhost:6379")).toThrow(CacheConfigError);
    expect(() => parseRedisUrl("postgresql://localhost:5432")).toThrow(/not redis: or rediss:/);
  });

  it("refuses a value that is not a URL at all", () => {
    expect(() => parseRedisUrl("localhost:6379")).toThrow(CacheConfigError);
    expect(() => parseRedisUrl("")).toThrow(CacheConfigError);
  });

  it("refuses a non-integer database index", () => {
    expect(() => parseRedisUrl("redis://localhost:6379/abc")).toThrow(/database index/);
    expect(() => parseRedisUrl("redis://localhost:6379/-1")).toThrow(/database index/);
  });

  it("lets a caller override the timeouts without restating the endpoint", () => {
    const options = parseRedisUrl("redis://localhost", { commandTimeoutMs: 250 });
    expect(options.commandTimeoutMs).toBe(250);
    expect(options.host).toBe("localhost");
  });
});

describe("resolveCacheMode", () => {
  it("chooses redis whenever a URL is configured", () => {
    expect(resolveCacheMode({ REDIS_URL: "redis://localhost:6379", NODE_ENV: "development" })).toBe("redis");
    expect(resolveCacheMode({ REDIS_URL: "redis://localhost:6379", NODE_ENV: "production" })).toBe("redis");
  });

  it("falls back to memory in development, where one process is the whole platform", () => {
    expect(resolveCacheMode({ NODE_ENV: "development" })).toBe("memory");
    expect(resolveCacheMode({ REDIS_URL: "  ", NODE_ENV: "development" })).toBe("memory");
  });

  it("refuses to fall back to memory in production", () => {
    // The failure this whole package exists to prevent: N replicas each with a
    // full allowance, discovered by a provider's bill rather than by a test.
    expect(() => resolveCacheMode({ NODE_ENV: "production" })).toThrow(CacheConfigError);
    expect(() => resolveCacheMode({ NODE_ENV: "production" })).toThrow(/REDIS_URL is required in production/);
  });
});

describe("buildCoordination", () => {
  it("builds an in-memory client that reports itself as not distributed", () => {
    const coordination = buildCoordination({ mode: "memory" });
    expect(coordination.client).toBeInstanceOf(FakeRedisClient);
    expect(coordination.distributed).toBe(false);
    expect(coordination.mode).toBe("memory");
  });

  it("refuses memory mode when the deployment demands distribution", () => {
    expect(() => buildCoordination({ mode: "memory", requireDistributed: true })).toThrow(/single-process/);
  });

  it("refuses redis mode with no URL", () => {
    expect(() => buildCoordination({ mode: "redis" })).toThrow(/needs REDIS_URL/);
    expect(() => buildCoordination({ mode: "redis", url: "   " })).toThrow(/needs REDIS_URL/);
  });

  it("validates the URL at build time, not at the first command", () => {
    // M6 fail-closed: an operator sees this at boot, not four hours later.
    expect(() => buildCoordination({ mode: "redis", url: "http://nope" })).toThrow(CacheConfigError);
  });

  it("builds a socket client for a well-formed URL without connecting yet", () => {
    // Constructing must not open a socket — nothing here reaches the network.
    const coordination = buildCoordination({ mode: "redis", url: "redis://127.0.0.1:1" });
    expect(coordination.distributed).toBe(true);
    expect(coordination.mode).toBe("redis");
  });
});

describe("REDIS_URL in the shared EnvSchema", () => {
  it("is accepted by @maestro/config and passed through", () => {
    const env = loadEnv({ NODE_ENV: "development", REDIS_URL: "redis://localhost:6379/2" });
    expect(env.REDIS_URL).toBe("redis://localhost:6379/2");
  });

  it("stays optional, so every existing deployment still validates", () => {
    expect(loadEnv({ NODE_ENV: "development" }).REDIS_URL).toBeUndefined();
  });

  it("accepts the redis:// scheme that z.url() would have refused", () => {
    // The reason it is z.string() and not z.url(): Zod's URL check rejects
    // redis:// outright, which would make a correct value unloadable.
    expect(() => loadEnv({ NODE_ENV: "development", REDIS_URL: "rediss://cache:6380" })).not.toThrow();
  });

  it("hands a value @maestro/cache can parse, so the two schemas agree", () => {
    const env = loadEnv({ NODE_ENV: "development", REDIS_URL: "redis://cache.internal:6380/1" });
    const options = parseRedisUrl(env.REDIS_URL as string);
    expect(options).toMatchObject({ host: "cache.internal", port: 6380, db: 1 });
  });
});
