import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  createLlmGateway,
  isModelNotConfigured,
  MSG_BLOCKED_CONFIDENTIAL,
  MSG_DEGRADED_AI_ASSIST,
  NO_ENDPOINT_CONFIGURED,
  type ResolvedModel,
} from "../src/index.js";
import { fakeClock, gatewayDeps, stubFetch, stubSecrets } from "./helpers.js";

/**
 * A model added in the panel is the model a run actually dials (M107).
 *
 * WHAT THESE PIN. The connections screen has collected an address, a model name
 * and an optional key for a self-hosted server since the `openai_compat` kind
 * existed — and none of it reached a run, because `llmConfig` read
 * `LLM_BASE_URL`/`LLM_MODEL` synchronously while composing the port. The panel
 * stored, tested and displayed three facts nothing used, which is the same
 * split `ConnectionSecretPort` had already closed for the API key alone. These
 * tests are the evidence that the other three facts now travel too — and that
 * the confidential rule did not become negotiable on the way.
 *
 * The precedence pinned throughout is ROW → ENV → REFUSAL. Both entrypoints
 * wire the resolver UNCONDITIONALLY, so "resolver answers null" is the state
 * every `.env`-only install lives in on every call — it must fall back to the
 * static config, not refuse. The refusal is reserved for a stack where the
 * static config names no endpoint either (`NO_ENDPOINT_CONFIGURED`).
 */

const ANSWER = {
  choices: [{ message: { content: '{"ok":true}' } }],
  usage: { prompt_tokens: 10, completion_tokens: 2 },
};

const Schema = z.object({ ok: z.boolean() });

/** The static config an install with `.env` values composes today. */
function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    drivers: [
      {
        driver: "openai-compat",
        baseUrl: "https://from-env.invalid",
        apiKeyRef: "kv/llm#api-key",
        onPrem: false,
      },
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
    ...overrides,
  };
}

/**
 * The static config of a stack that names NOTHING in `.env` — `llmConfig`
 * composes the driver with the never-dialled placeholder so the process can
 * boot and serve the panel. This is the only shape that may refuse by name.
 */
function unconfigured(): Record<string, unknown> {
  return config({
    drivers: [
      {
        driver: "openai-compat",
        baseUrl: NO_ENDPOINT_CONFIGURED,
        apiKeyRef: "kv/llm#api-key",
        onPrem: false,
      },
    ],
  });
}

function request(dataClass = "acik") {
  return {
    role: "analyst" as const,
    variantId: "v1",
    dataClass: dataClass as "acik" | "dahili" | "gizli",
    schemaName: "Verdict",
    input: { ticket: "UGURPAY-1" },
  };
}

/**
 * A panel row, as `connectionModelFrom` would answer with one. `apiKeyRef` is
 * the ROW'S OWN slot (`connector:<id>:<rand>`, written by `storeToken`), never
 * the shared `kv/llm#api-key` — the key must come from the same row as the
 * endpoint, or two rows can be mixed into one request (the credential-egress
 * bug these tests pin shut).
 */
function panelModel(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
  return {
    baseUrl: "https://gpt-oss.openshift.internal",
    model: "gpt-oss-120b",
    onPrem: true,
    apiKeyRef: "connector:llm-local:a1b2c3",
    ...overrides,
  };
}

describe("a model configured in the panel", () => {
  it("is the endpoint and the model the call actually uses", async () => {
    const stub = stubFetch([{ body: ANSWER }]);
    const clock = fakeClock();
    const lines: string[] = [];
    const gateway = createLlmGateway(
      config(),
      gatewayDeps(stub, clock, {
        resolveModel: () => Promise.resolve(panelModel()),
        log: (m) => lines.push(m),
      }),
    );

    const out = await gateway.generateObject(request(), Schema);

    expect(out.status).toBe("ok");
    // The address comes from the row, not from `baseUrl` in the static config.
    // `/v1` is appended by the driver, which is why the stored base carries none.
    expect(stub.calls[0]?.url).toBe("https://gpt-oss.openshift.internal/v1/chat/completions");
    expect((stub.calls[0]?.body as { model: string }).model).toBe("gpt-oss-120b");
    // And the audit row names what answered, not what a config file still says.
    expect(out.status === "ok" && out.log.model).toBe("gpt-oss-120b");
    // The journal says WHICH layer answered: with two model sources, a silent
    // precedence rule is how "I changed it and nothing happened" is born.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("panel");
    expect(lines[0]).toContain("https://gpt-oss.openshift.internal");
  });

  it("takes effect on the NEXT call, with no restart", async () => {
    const stub = stubFetch([{ body: ANSWER }, { body: ANSWER }]);
    const clock = fakeClock();
    // The operator edits the row between the two calls. The gateway instance is
    // never rebuilt — which is the whole property being pinned here, because a
    // port that had captured the endpoint at composition time could not do this.
    let active = panelModel();
    const gateway = createLlmGateway(
      config(),
      gatewayDeps(stub, clock, { resolveModel: () => Promise.resolve(active), log: () => {} }),
    );

    await gateway.generateObject(request(), Schema);
    active = panelModel({ baseUrl: "https://yeni-sunucu.internal", model: "qwen3-32b" });
    await gateway.generateObject(request(), Schema);

    expect(stub.calls[0]?.url).toBe("https://gpt-oss.openshift.internal/v1/chat/completions");
    expect(stub.calls[1]?.url).toBe("https://yeni-sunucu.internal/v1/chat/completions");
    expect((stub.calls[1]?.body as { model: string }).model).toBe("qwen3-32b");
  });

  it("sends NO Authorization header when the server wants no key", async () => {
    const stub = stubFetch([{ body: ANSWER }]);
    const clock = fakeClock();
    // A self-hosted server commonly needs no credential, and the panel stores
    // "" in the ROW'S OWN slot to say so. A bare `Bearer ` 401s some servers on
    // a request that would otherwise have succeeded, so the header must be
    // absent — not empty, and never someone else's key in its place.
    const gateway = createLlmGateway(
      config(),
      gatewayDeps(stub, clock, {
        secrets: stubSecrets({ "connector:llm-local:a1b2c3": "" }),
        resolveModel: () => Promise.resolve(panelModel()),
        log: () => {},
      }),
    );

    await gateway.generateObject(request(), Schema);

    expect(stub.calls[0]?.headers["authorization"]).toBeUndefined();
  });

  it("still sends the key when the server wants one", async () => {
    const stub = stubFetch([{ body: ANSWER }]);
    const clock = fakeClock();
    const gateway = createLlmGateway(
      config(),
      gatewayDeps(stub, clock, {
        secrets: stubSecrets({ "connector:llm-local:a1b2c3": "panelden-gelen-anahtar" }),
        resolveModel: () => Promise.resolve(panelModel()),
        log: () => {},
      }),
    );

    await gateway.generateObject(request(), Schema);

    expect(stub.calls[0]?.headers["authorization"]).toBe("Bearer panelden-gelen-anahtar");
  });

  it("asks the secret port ONLY for the picked row's slot", async () => {
    const stub = stubFetch([{ body: ANSWER }]);
    const clock = fakeClock();
    // The credential-egress guard at the gateway level: the request's key is
    // resolved through the reference the ROW carried, so no scan can hand this
    // endpoint a credential that belongs to another row or to `.env`.
    const asked: string[] = [];
    const gateway = createLlmGateway(
      config(),
      gatewayDeps(stub, clock, {
        secrets: {
          get: (key) => {
            asked.push(key);
            return Promise.resolve("satirin-kendi-anahtari");
          },
          set: () => Promise.reject(new Error("not used")),
          issueShortLived: () => Promise.reject(new Error("not used")),
        },
        resolveModel: () => Promise.resolve(panelModel()),
        log: () => {},
      }),
    );

    await gateway.generateObject(request(), Schema);

    expect(asked).toEqual(["connector:llm-local:a1b2c3"]);
  });
});

describe("an install with no model configured ANYWHERE", () => {
  it("refuses by name at first use rather than failing to boot", async () => {
    const stub = stubFetch([]);
    const clock = fakeClock();
    // Building the gateway MUST succeed: the panel is how a model gets added,
    // so a process that refused to start without one could never be configured
    // through its own screen. The refusal belongs at first use — and ONLY on a
    // stack whose static config carries the placeholder, i.e. no `LLM_BASE_URL`
    // either. That is the fresh-install boot path and it must keep refusing.
    const gateway = createLlmGateway(
      unconfigured(),
      gatewayDeps(stub, clock, { resolveModel: () => Promise.resolve(null), log: () => {} }),
    );

    const error = await gateway.generateObject(request(), Schema).catch((e: unknown) => e);

    expect(isModelNotConfigured(error)).toBe(true);
    // Catchable as a named state, and the sentence points at the panel rather
    // than at a file on the server — the panel is where a model is added now.
    expect((error as Error).message).toContain("MAESTRO_NOT_CONFIGURED");
    expect((error as Error).message).toContain("Ayarlar & bağlantılar");
    // Nothing was dialled: a placeholder endpoint is never contacted.
    expect(stub.calls).toHaveLength(0);
  });
});

describe("the gizli class against a panel-added model", () => {
  it("refuses a model the operator marked as cloud", async () => {
    const stub = stubFetch([]);
    const clock = fakeClock();
    /**
     * THE RULE THAT MUST NOT BECOME NEGOTIABLE (M18). The static driver row is
     * declared `onPrem: false`, and the panel row says the same — a UI-added
     * cloud model is treated exactly as a cloud `.env` binding is. The default
     * `onPremMissing` action is `degrade_ai_assist`, so the platform stops
     * offering AI assistance rather than shipping a bank's confidential payload
     * to an outside endpoint.
     */
    const gateway = createLlmGateway(
      config(),
      gatewayDeps(stub, clock, { resolveModel: () => Promise.resolve(panelModel({ onPrem: false })), log: () => {} }),
    );

    const out = await gateway.generateObject(request("gizli"), Schema);

    expect(out.status).toBe("degraded");
    expect(out.status === "degraded" && out.messageKey).toBe(MSG_DEGRADED_AI_ASSIST);
    // The decisive assertion: no request left the process.
    expect(stub.calls).toHaveLength(0);
  });

  it("blocks a cloud model outright when the deployment says block", async () => {
    const stub = stubFetch([]);
    const clock = fakeClock();
    const gateway = createLlmGateway(
      config({ onPremMissing: "block" }),
      gatewayDeps(stub, clock, { resolveModel: () => Promise.resolve(panelModel({ onPrem: false })), log: () => {} }),
    );

    const out = await gateway.generateObject(request("gizli"), Schema);

    expect(out.status).toBe("blocked");
    expect(out.status === "blocked" && out.messageKey).toBe(MSG_BLOCKED_CONFIDENTIAL);
    expect(stub.calls).toHaveLength(0);
  });

  it("allows a model the operator marked as on-prem", async () => {
    const stub = stubFetch([{ body: ANSWER }]);
    const clock = fakeClock();
    /**
     * The mirror image, and the reason the flag has to be per-row rather than
     * per-deployment: the STATIC config still says `onPrem: false`, exactly as a
     * stack whose `.env` never set `LLM_ON_PREM` would. The panel row is what
     * grants on-prem standing, so a confidential run reaches the internal server
     * without anyone editing a file — which is the entire point of the change.
     */
    const gateway = createLlmGateway(
      config(),
      gatewayDeps(stub, clock, { resolveModel: () => Promise.resolve(panelModel({ onPrem: true })), log: () => {} }),
    );

    const out = await gateway.generateObject(request("gizli"), Schema);

    expect(out.status).toBe("ok");
    expect(stub.calls[0]?.url).toBe("https://gpt-oss.openshift.internal/v1/chat/completions");
    // Unmasked: an on-prem endpoint is inside the bank, so `masked_cloud` never
    // applied and the analyst sees the real ticket.
    expect(out.status === "ok" && out.unmask).toBeUndefined();
  });
});

describe("a deployment that still configures its model in .env", () => {
  it("keeps running on the static config when the resolver finds no row", async () => {
    const stub = stubFetch([{ body: ANSWER }]);
    const clock = fakeClock();
    // THE PRODUCTION SHAPE. `bin/bff.ts` and `bin/worker.ts` wire
    // `connectionModelFrom(db)` unconditionally, so an install configured only
    // via `.env` reaches this state — resolver present, answering null — on
    // EVERY call. Before the fix this threw ModelNotConfiguredError and broke
    // every existing `.env` install at the first worker restart; the resolver's
    // null must instead hand the decision back to the env-derived binding.
    const gateway = createLlmGateway(
      config(),
      gatewayDeps(stub, clock, { resolveModel: () => Promise.resolve(null), log: () => {} }),
    );

    const out = await gateway.generateObject(request(), Schema);

    expect(out.status).toBe("ok");
    expect(stub.calls[0]?.url).toBe("https://from-env.invalid/v1/chat/completions");
    expect((stub.calls[0]?.body as { model: string }).model).toBe("env-model");
  });

  it("names the .env layer in the journal, once, not per call", async () => {
    const stub = stubFetch([{ body: ANSWER }, { body: ANSWER }]);
    const clock = fakeClock();
    const lines: string[] = [];
    const gateway = createLlmGateway(
      config(),
      gatewayDeps(stub, clock, { resolveModel: () => Promise.resolve(null), log: (m) => lines.push(m) }),
    );

    await gateway.generateObject(request(), Schema);
    await gateway.generateObject(request(), Schema);

    // One line naming the source, so the two-layer split is visible instead of
    // silent — and only one, because this resolves on every request and a
    // per-call line would bury the thing it is saying.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(".env");
  });

  it("announces the switch when a panel row appears mid-flight", async () => {
    const stub = stubFetch([{ body: ANSWER }, { body: ANSWER }]);
    const clock = fakeClock();
    const lines: string[] = [];
    // The operator adds the first model row while the process runs: the next
    // call must both USE it and SAY so, or the journal claims `.env` is still
    // serving a stack it no longer serves.
    let active: ResolvedModel | null = null;
    const gateway = createLlmGateway(
      config(),
      gatewayDeps(stub, clock, { resolveModel: () => Promise.resolve(active), log: (m) => lines.push(m) }),
    );

    await gateway.generateObject(request(), Schema);
    active = panelModel();
    await gateway.generateObject(request(), Schema);

    expect(stub.calls[1]?.url).toBe("https://gpt-oss.openshift.internal/v1/chat/completions");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain(".env");
    expect(lines[1]).toContain("panel");
  });

  it("behaves exactly as before when no resolver is wired", async () => {
    const stub = stubFetch([{ body: ANSWER }]);
    const clock = fakeClock();
    // No `resolveModel` at all — the shape pre-existing tests compose. Nothing
    // may change for it, and no source line is written either: with a single
    // layer there is no precedence worth a journal entry.
    const gateway = createLlmGateway(config(), gatewayDeps(stub, clock));

    const out = await gateway.generateObject(request(), Schema);

    expect(out.status).toBe("ok");
    expect(stub.calls[0]?.url).toBe("https://from-env.invalid/v1/chat/completions");
    expect((stub.calls[0]?.body as { model: string }).model).toBe("env-model");
  });
});
