import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createLlmGateway, type FetchLike } from "@maestro/llm-gateway";
import type { SecretPort } from "@maestro/ports";
import {
  connectionModelFrom,
  pickModelRow,
  type ConnectionModelRow,
} from "../src/stores/connection-model.js";
import { ConnectionSecretPort } from "../src/stores/connection-secrets.js";

/**
 * The panel's rows, read as the model a run dials (M107).
 *
 * The counterpart of `connection-secrets.test.ts`, which pins the same journey
 * for the API key. What is pinned here is the other three facts — the endpoint,
 * the model id and the on-prem standing — travelling from a row an admin
 * created to the gateway that dials it, AND the rule that the key travels with
 * the SAME row: the integration block at the bottom drives the real resolver,
 * the real secret composite and the real gateway together, because the
 * credential-egress bug it pins shut lived precisely in the seams between them.
 */

function row(overrides: Partial<ConnectionModelRow> = {}): ConnectionModelRow {
  return {
    id: "model-1",
    kind: "openai_compat",
    baseUrl: "https://gpt-oss.openshift.internal",
    secretRef: "connector:model-1:abc",
    enabled: true,
    onPrem: true,
    isDefault: false,
    configJson: { model: "gpt-oss-120b" },
    ...overrides,
  };
}

function db(rows: ConnectionModelRow[]): { connection: { findMany: () => Promise<ConnectionModelRow[]> } } {
  return { connection: { findMany: () => Promise.resolve(rows) } };
}

describe("pickModelRow", () => {
  it("prefers the row marked as default", () => {
    const picked = pickModelRow([
      row({ id: "a", configJson: { model: "first-by-id" } }),
      row({ id: "b", isDefault: true, configJson: { model: "the-default" } }),
    ]);
    expect(picked?.id).toBe("b");
  });

  it("falls back to the first by id when nothing is default", () => {
    // Deterministic rather than arbitrary: an install whose answering model
    // depends on row order is not one a bank can audit.
    const picked = pickModelRow([row({ id: "a" }), row({ id: "b" })]);
    expect(picked?.id).toBe("a");
  });

  it("ignores a disabled row", () => {
    // Disabling a model in the panel must take it out of service, not merely
    // grey it out on the screen.
    expect(pickModelRow([row({ enabled: false })])).toBeNull();
  });

  it("ignores a row that names no model", () => {
    // A connection created without a model id has not been finished. Treating
    // it as active would dial a server with no model name and fail at the
    // provider instead of here.
    expect(pickModelRow([row({ configJson: {} })])).toBeNull();
  });

  it("ignores a kind that does not name an inference endpoint", () => {
    // A Jira or GitHub connection has no authority over which model answers.
    expect(pickModelRow([row({ kind: "jira_cloud" })])).toBeNull();
  });
});

describe("connectionModelFrom", () => {
  it("round-trips a panel row into what the gateway dials", async () => {
    const resolved = await connectionModelFrom(db([row()]))();

    expect(resolved).toEqual({
      baseUrl: "https://gpt-oss.openshift.internal",
      model: "gpt-oss-120b",
      onPrem: true,
      // THE ROW'S OWN slot, so the key provably belongs to the same row that
      // supplied the endpoint. The shared `kv/llm#api-key` reference would be
      // answered by a row SCAN, and with several model rows the scan and the
      // model pick could disagree — one row's key on another row's server.
      apiKeyRef: "connector:model-1:abc",
      // No flag in the config bag = full verification, said explicitly so the
      // run's handshake is never left to an undefined read.
      skipTlsVerify: false,
    });
  });

  it("carries the row's skipTlsVerify switch to the run's handshake", async () => {
    // The probe honoured this flag when the panel's test went green; the
    // resolver must hand the same answer to the driver, or the green test is
    // evidence about a handshake no run performs.
    const flagged = await connectionModelFrom(
      db([row({ configJson: { model: "gpt-oss-120b", skipTlsVerify: "true" } })]),
    )();
    expect(flagged?.skipTlsVerify).toBe(true);

    // Anything but the exact string "true" — junk, "false", a boolean that
    // should never be there — fails closed onto verification.
    const junk = await connectionModelFrom(
      db([row({ configJson: { model: "gpt-oss-120b", skipTlsVerify: "yes" } })]),
    )();
    expect(junk?.skipTlsVerify).toBe(false);
  });

  it("names the env fallback reference for a row that never stored a token", async () => {
    // The operator configured the address in the panel but left the key where
    // the deployment already kept it (`.env`/Vault). `kv/llm#api-key` resolves
    // from the environment ONLY — never by scanning other rows for a token.
    const resolved = await connectionModelFrom(db([row({ secretRef: null })]))();
    expect(resolved?.apiKeyRef).toBe("kv/llm#api-key");
  });

  it("strips a trailing /v1 the operator pasted", async () => {
    // The driver appends `/v1` itself, so a stored base ending in one produces
    // `/v1/v1/chat/completions` and every call 404s. The panel normalises what
    // was typed; this is the runtime half of the same rule, so the probe and
    // the run address the same server.
    const resolved = await connectionModelFrom(db([row({ baseUrl: "https://llm.local/v1/" })]))();
    expect(resolved?.baseUrl).toBe("https://llm.local");
  });

  it("carries a cloud row's on-prem standing as FALSE", async () => {
    // The flag is the only thing between the confidential class and an outside
    // endpoint (M18), so it must travel exactly as the operator asserted it.
    const resolved = await connectionModelFrom(db([row({ onPrem: false })]))();
    expect(resolved?.onPrem).toBe(false);
  });

  it("answers null when the install has configured no model", async () => {
    // Not an error here: null hands the decision back to the static config, and
    // the gateway is what refuses by name when nothing answers at all.
    expect(await connectionModelFrom(db([]))()).toBeNull();
  });

  it("answers null rather than throwing when the table cannot be read", async () => {
    // A stack that predates the migration, or a database blip. Neither is a
    // reason to fail a call the environment can still answer.
    const broken = { connection: { findMany: () => Promise.reject(new Error("relation does not exist")) } };
    expect(await connectionModelFrom(broken)()).toBeNull();
  });
});

/**
 * ── THE WHOLE PIPELINE, END TO END ──────────────────────────────────────────
 * Real `connectionModelFrom`, real `ConnectionSecretPort`, real gateway, fake
 * network. These exist because the two audited bugs lived BETWEEN the units:
 * each store was individually correct while a run dialled one row's endpoint
 * with another row's credential, or refused an install `.env` still served.
 */

const ANSWER = {
  choices: [{ message: { content: '{"ok":true}' } }],
  usage: { prompt_tokens: 10, completion_tokens: 2 },
};

/** The gateway config `llmConfig` composes for a stack with `.env` values. */
function envConfig(): Record<string, unknown> {
  return {
    drivers: [
      { driver: "openai-compat", baseUrl: "https://from-env.invalid", apiKeyRef: "kv/llm#api-key", onPrem: false },
    ],
    bindings: [
      { role: "intake", driver: "openai-compat", model: "env-model" },
      { role: "analyst", driver: "openai-compat", model: "env-model" },
    ],
    routes: [
      { dataClass: "acik", allowedDrivers: ["openai-compat"] },
      { dataClass: "dahili", allowedDrivers: ["openai-compat"] },
      { dataClass: "gizli", allowedDrivers: ["openai-compat"] },
    ],
  };
}

interface RecordedCall {
  url: string;
  headers: Record<string, string>;
  body: { model?: string };
}

/** Offline fetch double: one canned answer, every request recorded. */
function fetchStub(): { calls: RecordedCall[]; fetchImpl: FetchLike } {
  const calls: RecordedCall[] = [];
  const fetchImpl: FetchLike = (url, init) => {
    calls.push({
      url,
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body: typeof init?.body === "string" ? (JSON.parse(init.body) as { model?: string }) : {},
    });
    return Promise.resolve(
      new Response(JSON.stringify(ANSWER), { status: 200, headers: { "content-type": "application/json" } }),
    );
  };
  return { calls, fetchImpl };
}

/** A SecretPort double that records every reference it is asked for. */
function recordingPort(slots: Record<string, string>): { asked: string[]; port: SecretPort } {
  const asked: string[] = [];
  const port: SecretPort = {
    get: (key) => {
      asked.push(key);
      return key in slots
        ? Promise.resolve(slots[key]!)
        : Promise.reject(new Error(`no secret stored under "${key}"`));
    },
    set: () => Promise.reject(new Error("not used")),
    issueShortLived: () => Promise.reject(new Error("not used")),
  };
  return { asked, port };
}

const Verdict = z.object({ ok: z.boolean() });

function generateRequest() {
  return {
    role: "analyst" as const,
    variantId: "v1",
    dataClass: "acik" as const,
    schemaName: "Verdict",
    input: { ticket: "UGURPAY-1" },
  };
}

/** The two-row install of the audit finding: a deliberate-keyless on-prem
 * default next to a keyed cloud row. Which row is FIRST BY ID is exactly what
 * must stop mattering. */
function twoRows(): ConnectionModelRow[] {
  return [
    {
      id: "01-openrouter",
      kind: "openrouter",
      baseUrl: "https://openrouter.ai/api",
      secretRef: "connector:01-openrouter:aaa",
      enabled: true,
      onPrem: false,
      isDefault: false,
      configJson: { model: "openai/gpt-5" },
    },
    {
      id: "02-local",
      kind: "openai_compat",
      baseUrl: "https://vllm.internal",
      secretRef: "connector:02-local:bbb",
      enabled: true,
      onPrem: true,
      isDefault: true,
      configJson: { model: "gpt-oss-120b" },
    },
  ];
}

function pipeline(rows: ConnectionModelRow[], connectorSlots: Record<string, string>) {
  const net = fetchStub();
  const connector = recordingPort(connectorSlots);
  const env = recordingPort({ "kv/llm#api-key": "env-dosyasindaki-anahtar" });
  const secrets = new ConnectionSecretPort({
    connections: { findMany: () => Promise.resolve(rows) },
    connectorSecrets: connector.port,
    fallback: env.port,
    log: () => {},
  });
  const gateway = createLlmGateway(envConfig(), {
    secrets,
    fetchImpl: net.fetchImpl,
    resolveModel: connectionModelFrom({ connection: { findMany: () => Promise.resolve(rows) } }),
    log: () => {},
  });
  return { net, connector, env, gateway };
}

describe("model row and credential come from ONE row", () => {
  it("dials the default on-prem row with NO auth header — the cloud key is never read", async () => {
    // The audit's scenario: `isDefault` picks the on-prem row whose operator
    // deliberately stored an empty token, while the FIRST row by id is a cloud
    // vendor holding a real key. Before the fix the credential was picked by an
    // independent id-ordered scan: depending on ordering the run either dialled
    // the vendor with the empty key (401 forever, both rows testing green) or —
    // worse — sent the vendor's REAL key as a Bearer header to the on-prem
    // server. Credential egress, no error anywhere.
    const { net, connector, gateway } = pipeline(twoRows(), {
      "connector:01-openrouter:aaa": "or-gercek-anahtar",
      "connector:02-local:bbb": "",
    });

    const out = await gateway.generateObject(generateRequest(), Verdict);

    expect(out.status).toBe("ok");
    expect(net.calls[0]?.url).toBe("https://vllm.internal/v1/chat/completions");
    expect(net.calls[0]?.body.model).toBe("gpt-oss-120b");
    // The deliberate empty key means NO header — and never a fall-through to
    // another row's key, which is exactly the egress path being pinned shut.
    expect(net.calls[0]?.headers["authorization"]).toBeUndefined();
    // The decisive assertion: the cloud row's slot was never even asked for.
    expect(connector.asked).toEqual(["connector:02-local:bbb"]);
  });

  it("dials the default cloud row with ITS OWN key when the default points the other way", async () => {
    const rows = twoRows().map((r) => ({ ...r, isDefault: r.id === "01-openrouter" }));
    const { net, connector, gateway } = pipeline(rows, {
      "connector:01-openrouter:aaa": "or-gercek-anahtar",
      "connector:02-local:bbb": "",
    });

    const out = await gateway.generateObject(generateRequest(), Verdict);

    expect(out.status).toBe("ok");
    expect(net.calls[0]?.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(net.calls[0]?.body.model).toBe("openai/gpt-5");
    expect(net.calls[0]?.headers["authorization"]).toBe("Bearer or-gercek-anahtar");
    expect(connector.asked).toEqual(["connector:01-openrouter:aaa"]);
  });

  it("never answers the picked row's key from the environment", async () => {
    const { net, env, gateway } = pipeline(twoRows(), {
      "connector:01-openrouter:aaa": "or-gercek-anahtar",
      "connector:02-local:bbb": "",
    });

    await gateway.generateObject(generateRequest(), Verdict);

    // A stale `LLM_API_KEY` in `.env` must not reach a server whose operator
    // said "no key" — the row's slot answered, so the env port was never asked.
    expect(env.asked).toEqual([]);
    expect(net.calls[0]?.headers["authorization"]).toBeUndefined();
  });
});

describe("an install still configured in .env, resolver wired (the production shape)", () => {
  it("runs on the environment's endpoint, model and key when the panel has no row", async () => {
    const { net, env, gateway } = pipeline([], {});

    const out = await gateway.generateObject(generateRequest(), Verdict);

    expect(out.status).toBe("ok");
    expect(net.calls[0]?.url).toBe("https://from-env.invalid/v1/chat/completions");
    expect(net.calls[0]?.body.model).toBe("env-model");
    expect(net.calls[0]?.headers["authorization"]).toBe("Bearer env-dosyasindaki-anahtar");
    expect(env.asked).toEqual(["kv/llm#api-key"]);
  });

  it("falls back to .env on a transient database error instead of claiming 'not configured'", async () => {
    // The outage case the audit flagged: the resolver maps an unreadable table
    // to null, and null means "the panel has no answer" — never "refuse a call
    // the environment can still serve".
    const net = fetchStub();
    const env = recordingPort({ "kv/llm#api-key": "env-dosyasindaki-anahtar" });
    const brokenDb = { findMany: () => Promise.reject(new Error("connection refused")) };
    const secrets = new ConnectionSecretPort({
      connections: brokenDb,
      connectorSecrets: recordingPort({}).port,
      fallback: env.port,
      log: () => {},
    });
    const gateway = createLlmGateway(envConfig(), {
      secrets,
      fetchImpl: net.fetchImpl,
      resolveModel: connectionModelFrom({ connection: brokenDb }),
      log: () => {},
    });

    const out = await gateway.generateObject(generateRequest(), Verdict);

    expect(out.status).toBe("ok");
    expect(net.calls[0]?.url).toBe("https://from-env.invalid/v1/chat/completions");
  });
});
