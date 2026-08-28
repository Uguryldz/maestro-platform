import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  RateLimitConfig,
  RetryConfig,
  TokenBucket,
  needsTlsSkip,
  postJson,
  shouldSkipTlsVerify,
  tlsAwareFetchWith,
} from "../src/index.js";
import { fakeClock } from "./helpers.js";

/**
 * The TLS-skip rule and its runtime effect — proven with a REAL self-signed
 * handshake, because this module exists to close a difference that was
 * measured on a real server: wendoc's model calls reached the user's on-prem
 * endpoint and Maestro's did not.
 */

describe("needsTlsSkip — the internal-address auto rule", () => {
  it.each([
    // Inside: addresses that cannot be an internet host.
    ["https://localhost:8443", true],
    ["https://127.0.0.1:8443", true],
    ["https://[::1]:8443", true],
    ["https://llm.banka.local", true],
    ["https://10.20.30.40", true],
    ["https://192.168.1.5:9000", true],
    ["https://172.16.0.9", true],
    ["https://172.31.255.1", true],
    // Outside the RFC1918 172 window — public space, verified.
    ["https://172.32.0.1", false],
    ["https://172.15.0.1", false],
    // Public names are ALWAYS verified; the flag or the CA is the way in.
    ["https://tfs.ugurbank.example", false],
    ["https://api.openai.com", false],
    // No certificate to skip on plain http.
    ["http://127.0.0.1:8000", false],
    // Junk cannot enable a skip.
    ["not a url", false],
  ])("%s → %s", (url, expected) => {
    expect(needsTlsSkip(url)).toBe(expected);
  });

  it("the explicit switch reaches hosts the auto rule never will", () => {
    // A bank's ADO on public-style internal DNS: auto says verify, the
    // operator's flag says skip — the flag wins, and only for that dial.
    expect(shouldSkipTlsVerify("https://tfs.ugurbank.example", true)).toBe(true);
    expect(shouldSkipTlsVerify("https://tfs.ugurbank.example", false)).toBe(false);
  });
});

describe("the runtime dial against a real self-signed server", () => {
  let dir: string;
  let server: HttpsServer;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "maestro-gw-tls-"));
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048",
      "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
      "-days", "2", "-nodes", "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ], { stdio: "pipe" });
    server = createHttpsServer(
      { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) },
      (_req, res) => {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ok: true }));
      },
    );
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    base = `https://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("postJson reaches it — the RUN performs the handshake the probe tested green", async () => {
    /**
     * This is the parity the whole packet is for: the panel's probe auto-skips
     * a loopback https endpoint and goes green; the driver's `postJson` must
     * make the same call succeed, or the operator has a green test over a
     * model no run can reach. The injected fetchImpl throws on purpose — the
     * skip path is REQUIRED to go through undici's own fetch, and falling back
     * to the injected transport here would mean it did not.
     */
    const clock = fakeClock();
    const context = {
      deps: {
        fetchImpl: () => Promise.reject(new Error("the skip path must not use the injected fetch")),
        sleep: () => Promise.resolve(),
        now: clock.now,
        random: () => 0.5,
      },
      bucket: new TokenBucket(RateLimitConfig.parse({}), clock.now),
      retry: RetryConfig.parse({ maxAttempts: 1 }),
    };
    const json = await postJson(
      { driver: "openai-compat", url: `${base}/v1/chat/completions`, headers: {}, body: {}, timeoutMs: 2_000 },
      context,
    );
    expect(json).toEqual({ ok: true });
  });

  it("tlsAwareFetchWith consults the flag lookup, and a lookup failure fails CLOSED", async () => {
    // Flagged host: the insecure dial succeeds against the self-signed server.
    const flagged = tlsAwareFetchWith(() => true);
    const ok = await flagged(`${base}/anything`);
    expect(ok.status).toBe(200);

    // A throwing lookup must read as "not flagged": for a non-internal host
    // the wrapper must then take the VERIFYING path — observed by standing in
    // for the global fetch, because proving "did not skip" over a real socket
    // would need a public host this suite must not depend on.
    const original = globalThis.fetch;
    const verifyingCalls: string[] = [];
    globalThis.fetch = ((url: string | URL) => {
      verifyingCalls.push(String(url));
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof fetch;
    try {
      const failingLookup = tlsAwareFetchWith(() => {
        throw new Error("store down");
      });
      await failingLookup("https://tfs.ugurbank.example/x");
      expect(verifyingCalls).toEqual(["https://tfs.ugurbank.example/x"]);
    } finally {
      globalThis.fetch = original;
    }
  });
});
