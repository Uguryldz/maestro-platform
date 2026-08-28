import { PiiLeakError, ReverseMap } from "@maestro/pii";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LlmAuthError, LlmConfigError, LlmHttpError, createLlmGateway, redact, type LlmGatewayDeps } from "../src/index.js";
import { SAMPLE_IBAN, SAMPLE_TCKN, fakeClock, gatewayDeps, piiMask, stubFetch } from "./helpers.js";

/**
 * B7/B8 regressions. Two egress points nobody had guarded: a provider error
 * object, which a structured logger will happily serialise (M19/M82), and the
 * masker itself, whose output was never checked and whose ReverseMap was thrown
 * away so the answer could not be reopened (M20).
 */

describe("provider error bodies carry no secrets or PII (B7 · M19/M82)", () => {
  it("strips keys, bearer tokens and identifiers from the snippet", () => {
    const raw = `{"error":"invalid","key":"sk-ant-api03-AAAABBBBCCCCDDDD","auth":"Bearer ya29.abcdEFGH1234","tckn":"${SAMPLE_TCKN}","iban":"${SAMPLE_IBAN}"}`;
    const clean = redact(raw);

    expect(clean).not.toContain("sk-ant-api03-AAAABBBBCCCCDDDD");
    expect(clean).not.toContain("ya29.abcdEFGH1234");
    expect(clean).not.toContain(SAMPLE_TCKN);
    expect(clean).not.toContain(SAMPLE_IBAN);
    // The diagnostic value survives: an operator still sees what went wrong.
    expect(clean).toContain("invalid");
  });

  it("redacts an AWS access key id and a JSON secret field", () => {
    const clean = redact('{"aws":"AKIAIOSFODNN7EXAMPLE","password":"hunter2","note":"ok"}');
    expect(clean).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(clean).not.toContain("hunter2");
    expect(clean).toContain("ok");
  });

  it("keeps responseBody off every serialisation path", () => {
    const error = new LlmHttpError(500, "anthropic-direct", "https://api.anthropic.com/v1/messages", "sk-ant-secret1234");

    expect(JSON.stringify(error)).not.toContain("sk-ant-secret1234");
    expect(JSON.stringify({ ...error })).not.toContain("sk-ant-secret1234");
    expect(Object.keys(error)).not.toContain("responseBody");
    // …but the audit trail can still ask for it explicitly, already redacted.
    expect(error.responseBody).toBe("[REDACTED]");
  });

  it("applies to the auth subclass too, where leaked keys hurt most", () => {
    const error = new LlmAuthError(401, "openai-compat", "https://vllm.internal.bank", `key sk-live-9876543210 tckn ${SAMPLE_TCKN}`);
    expect(JSON.stringify(error)).not.toContain("sk-live-9876543210");
    expect(error.responseBody).not.toContain(SAMPLE_TCKN);
  });
});

const Answer = z.object({ risk: z.string().min(1) });

const config = {
  drivers: [{ driver: "anthropic-direct", apiKeyRef: "llm/anthropic" }],
  bindings: [{ role: "analyst", driver: "anthropic-direct", model: "claude-x" }],
  routes: [
    { dataClass: "acik", allowedDrivers: ["anthropic-direct"] },
    { dataClass: "dahili", allowedDrivers: ["anthropic-direct"] },
    { dataClass: "gizli", allowedDrivers: ["anthropic-direct"] },
  ],
  onPremMissing: "masked_cloud",
};

const request = {
  role: "analyst",
  variantId: "backend",
  dataClass: "gizli",
  schemaName: "Answer",
  input: { ticket: "UGURPAY-1", iban: SAMPLE_IBAN, tckn: SAMPLE_TCKN },
} as const;

function build(extra: Partial<LlmGatewayDeps>) {
  const stub = stubFetch([
    { body: { content: [{ type: "text", text: '{"risk":"[IBAN_1] touched"}' }], usage: { input_tokens: 5, output_tokens: 2 } } },
  ]);
  return { stub, gateway: createLlmGateway(config, gatewayDeps(stub, fakeClock(), extra)) };
}

describe("the masker is verified and its ReverseMap is carried (B8 · M20)", () => {
  it("accepts @maestro/pii's maskOutbound as deps.mask without an adapter", async () => {
    const { gateway, stub } = build({ mask: piiMask() });

    const outcome = await gateway.generateObject(request, Answer);

    const sent = JSON.stringify(stub.calls[0]?.body);
    expect(sent).toContain("[IBAN_1."); // per-session nonce, see @maestro/pii B-8
    expect(sent).toContain("[TCKN_1.");
    expect(sent).not.toContain(SAMPLE_IBAN);
    expect(sent).not.toContain(SAMPLE_TCKN);
    if (outcome.status !== "ok") return expect.unreachable("expected an ok outcome");
    // What may be persisted is the masked object (M20/M82)…
    expect(outcome.value).toEqual({ risk: "[IBAN_1] touched" });
    // …and the map survives, so the human-facing copy can be reopened. The
    // stub answers with a literal token, so reopen the nonced one it was sent.
    const token = /\[IBAN_1\.[0-9a-f]+\]/.exec(sent)?.[0] ?? "";
    expect(outcome.unmask?.({ risk: `${token} touched` })).toEqual({ risk: `${SAMPLE_IBAN} touched` });
  });

  it("refuses to send when the masker did not actually mask", async () => {
    // A masker that reports success while returning the payload untouched is
    // exactly the v1 failure mode; the boundary must catch it at runtime.
    const { gateway, stub } = build({
      mask: (payload) => ({ payload, map: new ReverseMap(), counts: { occurrences: 0, fields: 0, byType: {} } }),
    });

    await expect(gateway.generateObject(request, Answer)).rejects.toBeInstanceOf(PiiLeakError);
    expect(stub.calls).toHaveLength(0);
  });

  it("still refuses masked_cloud when no masker is wired at all", async () => {
    const { gateway, stub } = build({});
    await expect(gateway.generateObject(request, Answer)).rejects.toBeInstanceOf(LlmConfigError);
    expect(stub.calls).toHaveLength(0);
  });
});
