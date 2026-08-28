import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { GenerateObjectRequest } from "@maestro/contracts";
import { resolveVariantModel, type VariantModelReader } from "../src/variant.js";
import { createPilotGateway } from "../src/wiring.js";
import { createPilotSecrets } from "../src/wiring.js";

/**
 * DB-first model resolution for the pilot (M38 / Uğur's hard rule).
 *
 * The rule these pin: at flow time the model comes from the VARIANT (DB), never
 * from env `PILOT_MODEL`. env is only a bootstrap fallback used when no variant
 * store is wired, and that fallback is always logged, never silent.
 */

function readerReturning(model: string | null): VariantModelReader {
  return { activeModel: () => Promise.resolve(model) };
}

describe("resolveVariantModel", () => {
  it("uses the variant's active model when a reader is wired (DB-first)", async () => {
    const warn = vi.fn();
    const resolved = await resolveVariantModel("analyst-default", readerReturning("model-X"), {
      fallbackModel: "env-Y",
      warn,
    });
    expect(resolved).toEqual({ variantId: "analyst-default", model: "model-X", source: "variant" });
    // The intended path warns about nothing.
    expect(warn).not.toHaveBeenCalled();
  });

  it("falls back to env with a warning when no reader is wired", async () => {
    const warn = vi.fn();
    const resolved = await resolveVariantModel("analyst-default", undefined, {
      fallbackModel: "env-Y",
      warn,
    });
    expect(resolved).toEqual({
      variantId: "analyst-default",
      model: "env-Y",
      source: "env-fallback",
    });
    expect(warn).toHaveBeenCalledOnce();
  });

  it("falls back to env with a warning when the variant has no published model", async () => {
    const warn = vi.fn();
    const resolved = await resolveVariantModel("ghost", readerReturning(null), {
      fallbackModel: "env-Y",
      warn,
    });
    expect(resolved.source).toBe("env-fallback");
    expect(resolved.model).toBe("env-Y");
    expect(warn).toHaveBeenCalledOnce();
  });

  it("propagates a THROWING store rather than silently using env", async () => {
    const reader: VariantModelReader = {
      activeModel: () => Promise.reject(new Error("db unreachable")),
    };
    await expect(
      resolveVariantModel("analyst-default", reader, { fallbackModel: "env-Y", warn: vi.fn() }),
    ).rejects.toThrow(/db unreachable/);
  });
});

/**
 * The gateway binds the role to the RESOLVED model, so an LLM call really runs
 * on the variant's model X — even when env `PILOT_MODEL` says Y. Offline: a stub
 * fetch records the `model` field the OpenAI-compatible driver sends.
 */
describe("createPilotGateway model binding", () => {
  const ENV_KEY = "PILOT_MODEL";
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env[ENV_KEY];
    // env says Y; the resolved variant model must still win.
    process.env[ENV_KEY] = "env-model-Y";
  });
  afterEach(() => {
    if (previous === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = previous;
  });

  it("sends the variant model X on an analyst call, not env Y", async () => {
    const sent: string[] = [];
    const fetchImpl = (_url: string, init?: RequestInit): Promise<Response> => {
      const body: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
      sent.push((body as { model: string }).model);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ ok: true }) } }],
            usage: { prompt_tokens: 10, completion_tokens: 5 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );
    };

    const secrets = createPilotSecrets(
      { apiKey: "k", baseUrl: "http://127.0.0.1:1" },
      { baseUrl: "https://example.atlassian.net", email: "p@b.example", apiToken: "t" },
      undefined,
    );
    const { gateway } = createPilotGateway(
      secrets,
      { apiKey: "k", baseUrl: "http://127.0.0.1:1" },
      { fetchImpl },
      // The DB-resolved model — env says env-model-Y, this must win.
      { analyst: "variant-model-X", engineer: "variant-model-X", intake: "variant-model-X" },
    );

    const request: GenerateObjectRequest = {
      role: "analyst",
      variantId: "analyst-default",
      dataClass: "acik",
      schemaName: "Probe",
      input: { hello: "world" },
    };
    const outcome = await gateway.generateObject(request, z.object({ ok: z.boolean() }));

    expect(outcome.status).toBe("ok");
    expect(sent).toEqual(["variant-model-X"]);
    expect(sent).not.toContain("env-model-Y");
  });
});
