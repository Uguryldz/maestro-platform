import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  InvalidTtlError,
  ObjectLockNotConfiguredError,
  StorageConfigError,
  StorageRequestError,
} from "../src/errors.js";
import { createS3Storage, S3CompatStorage, S3StorageOptions } from "../src/s3.js";
import type { FetchLike } from "../src/deps.js";
import { FakeS3 } from "./fakes/fake-s3.js";

const CLOCK = () => new Date("2026-08-08T09:00:00.000Z");

const BASE = {
  endpoint: "https://s3.corp.local",
  bucket: "maestro",
  accessKeyId: "AKIA_TEST",
  secretAccessKey: "secret",
};

function build(overrides: Record<string, unknown> = {}, basePath?: string) {
  const fake = new FakeS3({ bucket: "maestro", ...(basePath === undefined ? {} : { basePath }) });
  const port = new S3CompatStorage(S3StorageOptions.parse({ ...BASE, ...overrides }), {
    fetch: fake.fetch,
    now: CLOCK,
  });
  return { fake, port };
}

describe("addressing styles", () => {
  it("puts the bucket in the path for path-style endpoints", async () => {
    const { fake, port } = build({ addressing: "path" });
    await port.put("evidence/a.json", new Uint8Array([1]));
    expect(fake.requests[0]?.url).toBe("https://s3.corp.local/maestro/evidence/a.json");
  });

  it("puts the bucket in the host for virtual-host endpoints", async () => {
    const { fake, port } = build({ addressing: "virtual-host" });
    await port.put("evidence/a.json", new Uint8Array([1]));
    expect(fake.requests[0]?.url).toBe("https://maestro.s3.corp.local/evidence/a.json");
  });

  it("preserves a base path on the endpoint", async () => {
    const { fake, port } = build({ endpoint: "https://gw.corp.local/storage/" }, "/storage");
    await port.put("a.json", new Uint8Array([1]));
    expect(fake.requests[0]?.url).toBe("https://gw.corp.local/storage/maestro/a.json");
    expect(await port.get("a.json")).toEqual(new Uint8Array([1]));
  });

  it("percent-encodes reserved characters in the key", async () => {
    const { fake, port } = build();
    await port.put("evidence/a b+c$d.json", new Uint8Array([1]));
    expect(fake.requests[0]?.url).toBe(
      "https://s3.corp.local/maestro/evidence/a%20b%2Bc%24d.json",
    );
  });
});

describe("request signing", () => {
  it("signs every request and never sends an explicit host header", async () => {
    const { fake, port } = build();
    await port.put("a.json", new Uint8Array([1]));
    await port.get("a.json");
    await port.list("");
    await port.delete("a.json");
    expect(fake.requests).toHaveLength(4);
    for (const request of fake.requests) {
      expect(request.headers["authorization"]).toMatch(
        /^AWS4-HMAC-SHA256 Credential=AKIA_TEST\/20260808\/us-east-1\/s3\/aws4_request, SignedHeaders=\S+, Signature=[0-9a-f]{64}$/,
      );
      expect(request.headers["x-amz-date"]).toBe("20260808T090000Z");
      expect(request.headers).not.toHaveProperty("host");
    }
  });

  it("signs the payload hash of the body it sends", async () => {
    const { fake, port } = build();
    await port.put("a.json", new TextEncoder().encode("hello"));
    // sha256("hello") — the fake rejects the request if this does not match.
    expect(fake.requests[0]?.headers["x-amz-content-sha256"]).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("propagates a session token to the wire", async () => {
    const { fake, port } = build({ sessionToken: "STS_TOKEN" });
    await port.get("a.json").catch(() => undefined);
    expect(fake.requests[0]?.headers["x-amz-security-token"]).toBe("STS_TOKEN");
    expect(fake.requests[0]?.headers["authorization"]).toContain("x-amz-security-token");
  });
});

describe("retention metadata (M56/M57)", () => {
  it("tags every object with its retention policy", async () => {
    const { fake, port } = build();
    await port.put("evidence/a.json", new Uint8Array([1]));
    expect(fake.objects.get("evidence/a.json")?.tagging).toBe(
      "maestro-class=evidence&maestro-retention-years=10&maestro-archive-after-days=90",
    );
  });

  it("can be deployed against endpoints without tagging support", async () => {
    const { fake, port } = build({ tagging: false });
    await port.put("evidence/a.json", new Uint8Array([1]));
    expect(fake.objects.get("evidence/a.json")?.tagging).toBeUndefined();
    expect(fake.requests[0]?.headers).not.toHaveProperty("x-amz-tagging");
  });

  it("sends compliance-mode retention headers for a locked put", async () => {
    const { fake, port } = build({ objectLock: { mode: "COMPLIANCE", years: 10 } });
    await port.put("evidence/a.json", new Uint8Array([1]), { objectLock: true });
    const stored = fake.objects.get("evidence/a.json");
    expect(stored?.objectLockMode).toBe("COMPLIANCE");
    expect(stored?.retainUntil).toBe("2036-08-08T09:00:00.000Z");
  });

  it("sends an integrity checksum with a locked put, as Object Lock requires", async () => {
    const { fake, port } = build({ objectLock: { mode: "COMPLIANCE", years: 10 } });
    const data = new TextEncoder().encode("evidence");
    await port.put("evidence/a.json", data, { objectLock: true });
    expect(fake.requests[0]?.headers["content-md5"]).toBe(
      createHash("md5").update(data).digest("base64"),
    );
    // The checksum must be inside the signature, or the endpoint rejects it.
    expect(fake.requests[0]?.headers["authorization"]).toContain("content-md5");
  });

  it("labels each object with the retention class of its own key (M65)", async () => {
    const { fake, port } = build();
    await port.put("archive/2026/UGURPAY-1/session.tar", new Uint8Array([1]));
    await port.put("evidence/2026/UGURPAY-1/run-01H8ZQXYZ/a.json", new Uint8Array([1]));
    await port.put("scratch/x.bin", new Uint8Array([1]));
    expect(fake.objects.get("archive/2026/UGURPAY-1/session.tar")?.tagging).toContain(
      "maestro-class=archive",
    );
    expect(fake.objects.get("evidence/2026/UGURPAY-1/run-01H8ZQXYZ/a.json")?.tagging).toContain(
      "maestro-class=evidence",
    );
    // Unknown layouts fall back to the driver default.
    expect(fake.objects.get("scratch/x.bin")?.tagging).toContain("maestro-class=evidence");
  });

  it("does not send retention headers for an unlocked put", async () => {
    const { fake, port } = build({ objectLock: { mode: "COMPLIANCE", years: 10 } });
    await port.put("evidence/a.json", new Uint8Array([1]));
    expect(fake.requests[0]?.headers).not.toHaveProperty("x-amz-object-lock-mode");
  });

  it("fails closed instead of writing an unprotected object", async () => {
    const { fake, port } = build();
    await expect(
      port.put("evidence/a.json", new Uint8Array([1]), { objectLock: true }),
    ).rejects.toBeInstanceOf(ObjectLockNotConfiguredError);
    expect(fake.requests).toHaveLength(0);
  });
});

describe("presigned URLs", () => {
  it("produces a query-signed URL for the configured addressing style", async () => {
    const { port } = build({ addressing: "virtual-host" });
    const url = new URL(await port.presign("evidence/a.json", 900));
    expect(url.origin).toBe("https://maestro.s3.corp.local");
    expect(url.pathname).toBe("/evidence/a.json");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Expires")).toBe("900");
    expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("includes the key prefix in the signed path", async () => {
    const { port } = build({ keyPrefix: "tenant-a/" });
    const url = new URL(await port.presign("evidence/a.json", 60));
    expect(url.pathname).toBe("/maestro/tenant-a/evidence/a.json");
  });

  it.each([
    ["beyond the configured ceiling", 3601],
    ["non-positive", 0],
    ["negative", -60],
    ["fractional", 1.5],
    ["not a number", Number.NaN],
  ])("refuses a ttl that is %s with a storage error, not a schema error", async (_label, ttl) => {
    const { port } = build({ maxPresignSeconds: 3600 });
    await expect(port.presign("a.json", ttl)).rejects.toBeInstanceOf(InvalidTtlError);
  });
});

describe("error handling", () => {
  it("surfaces backend failures instead of swallowing them", async () => {
    const failing: FetchLike = () =>
      Promise.resolve(
        new Response("<Error><Code>InternalError</Code><Message>boom</Message></Error>", {
          status: 500,
        }),
      );
    const port = new S3CompatStorage(S3StorageOptions.parse(BASE), { fetch: failing, now: CLOCK });
    await expect(port.get("a.json")).rejects.toBeInstanceOf(StorageRequestError);
    await expect(port.get("a.json")).rejects.toThrow(/HTTP 500/);
  });

  it("does not treat a failed delete as a successful no-op", async () => {
    const failing: FetchLike = () => Promise.resolve(new Response("denied", { status: 403 }));
    const port = new S3CompatStorage(S3StorageOptions.parse(BASE), { fetch: failing, now: CLOCK });
    await expect(port.delete("a.json")).rejects.toBeInstanceOf(StorageRequestError);
  });

  it("reads paginated listings to the end", async () => {
    const fake = new FakeS3({ bucket: "maestro", pageSize: 1 });
    const port = new S3CompatStorage(S3StorageOptions.parse(BASE), {
      fetch: fake.fetch,
      now: CLOCK,
    });
    for (const key of ["p/a", "p/b", "p/c"]) await port.put(key, new Uint8Array([1]));
    expect(await port.list("p/")).toEqual(["p/a", "p/b", "p/c"]);
    const listRequests = fake.requests.filter((r) => r.url.includes("list-type=2"));
    expect(listRequests).toHaveLength(3);
    expect(listRequests[1]?.url).toContain("continuation-token=");
  });
});

describe("configuration validation", () => {
  it("rejects a malformed endpoint", () => {
    expect(() => createS3Storage({ ...BASE, endpoint: "not-a-url" }, { fetch: fetchStub })).toThrow(
      StorageConfigError,
    );
  });

  it("rejects a malformed bucket name", () => {
    expect(() => createS3Storage({ ...BASE, bucket: "Maestro_Bucket" }, { fetch: fetchStub })).toThrow(
      /bucket/,
    );
  });

  it("rejects missing credentials", () => {
    expect(() => createS3Storage({ ...BASE, secretAccessKey: "" }, { fetch: fetchStub })).toThrow(
      StorageConfigError,
    );
  });

  it("rejects an unsafe key prefix", () => {
    expect(() => createS3Storage({ ...BASE, keyPrefix: "../etc/" }, { fetch: fetchStub })).toThrow(
      /invalid key/,
    );
  });

  it("rejects a misspelled option instead of silently ignoring it", () => {
    expect(() => createS3Storage({ ...BASE, keyPrefixx: "tenant-a/" }, { fetch: fetchStub })).toThrow(
      StorageConfigError,
    );
    expect(() =>
      createS3Storage({ ...BASE, objectLock: { mode: "COMPLIANCE", yearz: 10 } }, { fetch: fetchStub }),
    ).toThrow(StorageConfigError);
  });

  it("uses only the injected fetch, never the ambient global one", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("the driver must not reach for the global fetch");
    }) as typeof globalThis.fetch;
    try {
      const { port } = build();
      await port.put("a.json", new Uint8Array([1]));
      expect(await port.get("a.json")).toEqual(new Uint8Array([1]));
    } finally {
      globalThis.fetch = original;
    }
  });
});

const fetchStub: FetchLike = () => Promise.resolve(new Response(null, { status: 200 }));
