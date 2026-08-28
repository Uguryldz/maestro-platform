import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { createServer as createNetServer, type Server as NetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LightMyRequestResponse } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConnectionRecord } from "../src/connection-store.js";
import {
  probeFailure,
  runConnectionTest,
  type ConnectorFetch,
} from "../src/connection-service.js";
import { auth, harness, type Harness } from "./helpers.js";

/**
 * The probe's failure DIAGNOSTICS, proven against REAL sockets.
 *
 * The defect this suite pins down: an on-prem model server behind a corporate
 * certificate failed the panel's test as a bare "Adrese ulaşılamadı" — the same
 * sentence a typo'd hostname, a closed port and a silent firewall produced —
 * and the BFF wrote NOTHING server-side. Every test here drives a genuine
 * network failure (a really-closed port, a really-unresolvable name, a real
 * self-signed TLS handshake, a really-silent socket) so the classification is
 * evidence about Node's actual error shapes, not about a hand-built fixture.
 *
 * The TLS-SKIP half proves the other direction — wendoc parity: the same
 * self-signed server that fails a verifying probe must answer a skipping one,
 * because that is precisely what lets an operator reach an in-house endpoint
 * the corporate CA has not been introduced for.
 */

const TOKEN = "ghp_supersecrettokenvalue1234";

/** A stored openai_compat row pointed at `baseUrl` — the unit under test. */
function onPremRecord(baseUrl: string, config: Record<string, string> = {}): ConnectionRecord {
  return {
    id: "llm-onprem",
    kind: "openai_compat",
    displayName: "Kurum içi model",
    baseUrl,
    authKind: "bearer",
    config,
    secretRef: null,
    secretMask: null,
    enabled: true,
    onPrem: true,
    isDefault: false,
    createdAt: "2026-08-09T09:00:00.000Z",
    updatedAt: "2026-08-09T09:00:00.000Z",
    lastTestedAt: null,
    lastTestOk: null,
    lastTestNote: null,
  };
}

const realFetch: ConnectorFetch = (input, init) => fetch(input, init);

/** A 127.0.0.1 port that was just proven free — dialling it refuses. */
async function closedPort(): Promise<number> {
  const server = createNetServer();
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("probe failures carry their real cause (measured on real sockets)", () => {
  it("a dead port answers as REFUSED, naming host and port", async () => {
    const port = await closedPort();
    const outcome = await runConnectionTest(onPremRecord(`http://127.0.0.1:${port}`), null, realFetch);

    expect(outcome.ok).toBe(false);
    expect(outcome.messageKey).toBe("connections.test.refused");
    expect(outcome.messageParams).toEqual({ host: "127.0.0.1", port: String(port) });
    // The server-side log's payload: the real cause code, nothing message-derived.
    expect(outcome.diagnostic?.host).toBe("127.0.0.1");
    expect(outcome.diagnostic?.causes).toContain("ECONNREFUSED");
  });

  it("an unresolvable name answers as DNS, naming the host", async () => {
    // `.invalid` is RFC 2606-reserved: it never resolves, on any network.
    const outcome = await runConnectionTest(onPremRecord("http://model-sunucusu-yok.invalid"), null, realFetch);

    expect(outcome.ok).toBe(false);
    expect(outcome.messageKey).toBe("connections.test.dns");
    expect(outcome.messageParams).toEqual({ host: "model-sunucusu-yok.invalid" });
    // ENOTFOUND normally; EAI_AGAIN on a resolver that answers SERVFAIL — both
    // are the DNS diagnosis, which is what the operator needs either way.
    expect(outcome.diagnostic?.causes.some((c) => c === "ENOTFOUND" || c === "EAI_AGAIN")).toBe(true);
  });

  it("a host that accepts and never answers times out (bounded, classified)", async () => {
    // A socket that ACCEPTS and stays silent — the firewall-swallows shape.
    // The prod probe bounds itself with PROBE_TIMEOUT_MS; the test injects a
    // much shorter signal through the same seam so the suite stays fast.
    const server: NetServer = createNetServer(() => {
      /* accept, say nothing, hold the socket open */
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
    try {
      const impatient: ConnectorFetch = (input, init) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(300) });
      const outcome = await runConnectionTest(onPremRecord(`http://127.0.0.1:${port}`), null, impatient);

      expect(outcome.ok).toBe(false);
      expect(outcome.messageKey).toBe("connections.test.timeout");
      expect(outcome.diagnostic?.causes).toContain("TimeoutError");
    } finally {
      // `close` waits for the deliberately-hanging socket, so it is not
      // awaited; `unref` keeps that socket from holding the process open.
      server.unref();
      server.close();
    }
  });

  it("an error whose codes nothing recognises keeps the honest last resort", () => {
    const outcome = probeFailure(new Error("just prose"), "http://10.0.0.5:8000/v1/models");
    expect(outcome.messageKey).toBe("connections.test.unreachable");
    expect(outcome.diagnostic?.causes).toEqual([]);
  });
});

describe("TLS: a self-signed server, verified and skipped (wendoc parity)", () => {
  let dir: string;
  let server: HttpsServer;
  let port: number;

  beforeAll(async () => {
    // A THROWAWAY certificate minted for this run — self-signed, 2-day life,
    // SAN for 127.0.0.1 so the only verification failure is the chain, not
    // the name. openssl is what install.sh already assumes on every target.
    dir = mkdtempSync(join(tmpdir(), "maestro-tls-"));
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048",
      "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
      "-days", "2", "-nodes", "-subj", "/CN=127.0.0.1",
      "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost",
    ], { stdio: "pipe" });

    server = createHttpsServer(
      { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) },
      (req, res) => {
        res.setHeader("content-type", "application/json");
        // One body serves both probes: `data` is the OpenAI model list,
        // `authenticatedUser` is ADO's `/_apis/connectionData` identity.
        res.end(
          JSON.stringify({
            data: [{ id: "gpt-oss-120b", object: "model" }],
            authenticatedUser: { providerDisplayName: "Maestro Bot" },
          }),
        );
        void req;
      },
    );
    port = await new Promise<number>((resolve) => {
      server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  it("a VERIFYING dial fails with the real OpenSSL code, classified as tls", async () => {
    /**
     * Straight through the classifier with a GENUINE handshake error. It
     * cannot come from `runConnectionTest` here, because 127.0.0.1 is inside
     * the internal-address auto-skip — which the tests below prove is the
     * point — so the verifying dial is made directly, the way any non-internal
     * hostname's probe would make it.
     */
    let caught: unknown;
    try {
      await fetch(`https://127.0.0.1:${port}/v1/models`);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeDefined();

    const outcome = probeFailure(caught, `https://127.0.0.1:${port}/v1/models`);
    expect(outcome.ok).toBe(false);
    expect(outcome.messageKey).toBe("connections.test.tls");
    // The exact code a self-signed leaf produces, surfaced as the param the
    // catalog sentence renders — the operator sees the true reason, not
    // "unreachable".
    expect(outcome.messageParams?.["code"]).toBe("DEPTH_ZERO_SELF_SIGNED_CERT");
    expect(outcome.diagnostic?.causes).toContain("DEPTH_ZERO_SELF_SIGNED_CERT");
    // Codes are vendor constants: nothing from the URL or a header rides along.
    expect(JSON.stringify(outcome)).not.toContain("/v1/models");
  });

  it("the AUTO rule reaches the same server green: loopback https skips verification", async () => {
    // No flag anywhere — 127.0.0.1 is internal by address, so the probe skips
    // verification on its own, reads the model list, and the honest verdict is
    // about the MODEL, not the certificate. This is the wendoc behaviour the
    // user measured against.
    const record = onPremRecord(`https://127.0.0.1:${port}`, { model: "gpt-oss-120b" });
    const outcome = await runConnectionTest(record, null, realFetch);

    expect(outcome.ok).toBe(true);
    expect(outcome.messageKey).toBe("connections.test.ok_models");
    expect(outcome.messageParams?.["models"]).toContain("gpt-oss-120b");
  });

  it("the explicit switch reaches it too, for a NON-model kind (ado)", async () => {
    // The corporate-certificate wall is not a model specialty: an in-house
    // Azure DevOps Server sits behind the same CA. The flag lives in the same
    // config bag on every kind, and the probe's common path honours it — here
    // it is the operator's switch doing the work (the auto rule also matches
    // loopback, but a public-DNS ADO host would rely on the flag alone, and
    // both feed the identical `shouldSkipTlsVerify` predicate).
    const record: ConnectionRecord = {
      ...onPremRecord(`https://127.0.0.1:${port}`, { skipTlsVerify: "true" }),
      id: "ado-onprem",
      kind: "ado",
      displayName: "Kurum içi ADO",
    };
    const outcome = await runConnectionTest(record, TOKEN, realFetch);

    expect(outcome.ok).toBe(true);
    // `/_apis/connectionData` answered with an identity, so the verdict names it.
    expect(outcome.messageKey).toBe("connections.test.ok_as");
    expect(outcome.messageParams?.["who"]).toBe("Maestro Bot");
  });
});

describe("every failed probe leaves ONE server-side warn line", () => {
  interface CapturedHarness {
    h: Harness;
    lines: () => Array<Record<string, unknown>>;
  }

  /** A harness whose fastify logger writes into an assertable buffer. */
  async function capturingHarness(connectorFetch: ConnectorFetch): Promise<CapturedHarness> {
    const raw: string[] = [];
    const h = await harness({
      connectorFetch,
      fastify: {
        logger: {
          level: "warn",
          stream: {
            write: (line: string) => {
              raw.push(line);
            },
          },
        },
      },
    });
    return {
      h,
      lines: () =>
        raw
          .map((line) => {
            try {
              return JSON.parse(line) as Record<string, unknown>;
            } catch {
              return {};
            }
          })
          .filter((entry) => entry["msg"] === "connection test failed"),
    };
  }

  async function admin(h: Harness): Promise<string> {
    await h.addUser({ username: "ayse.kaya", roles: ["admin"] });
    return h.login("ayse.kaya");
  }

  function post(h: Harness, url: string, token: string, payload?: object): Promise<LightMyRequestResponse> {
    return h.app.inject({ method: "POST", url, headers: auth(token), ...(payload ? { payload } : {}) });
  }

  it("a refused model probe logs connection, kind, host, cause chain and the catalog key", async () => {
    const port = await closedPort();
    const { h, lines } = await capturingHarness(realFetch);
    const admToken = await admin(h);
    await post(h, "/studio/connections", admToken, {
      id: "llm-onprem",
      kind: "openai_compat",
      displayName: "Kurum içi model",
      baseUrl: `http://127.0.0.1:${port}`,
      authKind: "bearer",
      token: TOKEN,
    });

    const body = (await post(h, "/studio/connections/llm-onprem/test", admToken)).json() as {
      ok: boolean;
      messageKey: string;
    };
    expect(body.ok).toBe(false);
    expect(body.messageKey).toBe("connections.test.refused");

    // ONE warn line, carrying everything support needs and nothing secret.
    // Before this existed the reproduced live failure left the BFF log EMPTY.
    const warns = lines();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      connection: "llm-onprem",
      kind: "openai_compat",
      host: "127.0.0.1",
      note: "connections.test.refused",
    });
    expect(warns[0]?.["causes"]).toContain("ECONNREFUSED");
    expect(JSON.stringify(warns)).not.toContain(TOKEN);
  });

  it("an ADO probe behind a broken TLS chain logs and answers the tls key (all kinds, not just models)", async () => {
    // The transport rejects the way undici really does: a generic wrapper with
    // the OpenSSL code in `cause` — and with prose that MUST NOT surface.
    const tlsError = new TypeError("fetch failed");
    (tlsError as { cause?: unknown }).cause = Object.assign(
      new Error("self-signed certificate in certificate chain"),
      { code: "SELF_SIGNED_CERT_IN_CHAIN" },
    );
    const { h, lines } = await capturingHarness(() => Promise.reject(tlsError));
    const admToken = await admin(h);
    await post(h, "/studio/connections", admToken, {
      id: "ado",
      kind: "ado",
      displayName: "Kurum içi ADO",
      baseUrl: "https://tfs.ugurbank.example/DefaultCollection",
      authKind: "basic",
      token: TOKEN,
    });

    const response = await post(h, "/studio/connections/ado/test", admToken);
    const body = response.json() as {
      ok: boolean;
      messageKey: string;
      messageParams?: Record<string, string>;
    };
    expect(body.ok).toBe(false);
    expect(body.messageKey).toBe("connections.test.tls");
    expect(body.messageParams?.["code"]).toBe("SELF_SIGNED_CERT_IN_CHAIN");
    // The row's stored note carries the same key AND its params, so the table
    // shows WHY after a reload too — not just in the immediate toast. Storing
    // the key alone rendered the literal `{code}` on every refresh, which is
    // worse than useless: it reads as a bug in the product rather than a
    // missing value.
    const note = (await h.connections.get("ado"))?.lastTestNote ?? "";
    expect(note.split("?")[0]).toBe("connections.test.tls");
    expect(new URLSearchParams(note.slice(note.indexOf("?") + 1)).get("code")).toBe(
      "SELF_SIGNED_CERT_IN_CHAIN",
    );

    const warns = lines();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatchObject({
      connection: "ado",
      kind: "ado",
      host: "tfs.ugurbank.example",
      note: "connections.test.tls",
    });
    expect(warns[0]?.["causes"]).toEqual(["SELF_SIGNED_CERT_IN_CHAIN"]);
    // Neither the token nor the error's prose reaches the log or the response.
    expect(JSON.stringify(warns)).not.toContain(TOKEN);
    expect(response.body).not.toContain("self-signed certificate in");
  });

  it("a green test logs nothing — the warn line is a failure artifact", async () => {
    const { h, lines } = await capturingHarness(() =>
      Promise.resolve(new Response(JSON.stringify({ data: [{ id: "gpt-oss-120b" }] }), { status: 200 })),
    );
    const admToken = await admin(h);
    await post(h, "/studio/connections", admToken, {
      id: "llm-onprem",
      kind: "openai_compat",
      displayName: "Kurum içi model",
      baseUrl: "http://10.0.0.5:8000",
      authKind: "bearer",
      token: TOKEN,
      config: { model: "gpt-oss-120b" },
    });

    const body = (await post(h, "/studio/connections/llm-onprem/test", admToken)).json() as {
      ok: boolean;
      messageKey: string;
    };
    // Regression guard: the success verdicts are untouched by the cause work.
    expect(body.ok).toBe(true);
    expect(body.messageKey).toBe("connections.test.ok_models");
    expect(lines()).toHaveLength(0);
  });
});
