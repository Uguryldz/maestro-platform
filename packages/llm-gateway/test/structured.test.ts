import { describe, expect, it } from "vitest";
import { z } from "zod";
import { LlmSchemaValidationError, extractJson, generateStructured } from "../src/index.js";
import type { DriverCall, DriverResult, LlmDriver } from "../src/index.js";

const Answer = z.object({ risk: z.enum(["dusuk", "orta", "kritik"]), reason: z.string().min(1) });

interface ScriptedDriver extends LlmDriver {
  prompts: string[];
}

/** Canned driver: no network, and every prompt is captured for assertions. */
function scripted(texts: string[], usage: Partial<DriverResult> = {}): ScriptedDriver {
  const prompts: string[] = [];
  let index = 0;
  return {
    id: "anthropic-direct",
    prompts,
    complete(call: DriverCall): Promise<DriverResult> {
      prompts.push(call.prompt);
      const text = texts[index];
      index += 1;
      if (text === undefined) throw new Error(`unexpected driver call #${index}`);
      return Promise.resolve({ text, tokensIn: 10, tokensOut: 5, cachePct: null, ...usage });
    },
  };
}

const args = { schemaName: "AnalysisRisk", schema: Answer, input: { ticket: "UGURPAY-1" }, call: { model: "m", maxTokens: 100, temperature: 0 } };

describe("generateStructured (M17)", () => {
  it("validates the first answer against the caller's schema", async () => {
    const driver = scripted(['{"risk":"orta","reason":"payment path"}']);
    const result = await generateStructured({ ...args, driver });

    expect(result.object).toEqual({ risk: "orta", reason: "payment path" });
    expect(result.attempts).toBe(1);
    expect(driver.prompts).toHaveLength(1);
  });

  it("puts the schema name, JSON schema and input in the prompt", async () => {
    const driver = scripted(['{"risk":"dusuk","reason":"docs only"}']);
    await generateStructured({ ...args, driver });

    const prompt = driver.prompts[0] ?? "";
    expect(prompt).toContain("Schema name: AnalysisRisk");
    expect(prompt).toContain('"risk"');
    expect(prompt).toContain("UGURPAY-1");
  });

  it("passes a pre-rendered string input through untouched (masked payloads)", async () => {
    const driver = scripted(['{"risk":"dusuk","reason":"ok"}']);
    await generateStructured({ ...args, driver, input: "customer ***MASKED***" });

    expect(driver.prompts[0]).toContain("customer ***MASKED***");
  });

  it("accepts a fenced JSON block and leading chatter", async () => {
    const driver = scripted(['Sure!\n```json\n{"risk":"kritik","reason":"core banking"}\n```\n']);
    const result = await generateStructured({ ...args, driver });

    expect(result.object.risk).toBe("kritik");
  });

  it("buys exactly one repair round and reports the concrete validation errors", async () => {
    const driver = scripted(['{"risk":"HIGH","reason":"x"}', '{"risk":"kritik","reason":"x"}']);
    const result = await generateStructured({ ...args, driver });

    expect(result.object.risk).toBe("kritik");
    expect(result.attempts).toBe(2);
    expect(driver.prompts).toHaveLength(2);
    expect(driver.prompts[1]).toContain("Validation errors:");
    expect(driver.prompts[1]).toContain("risk:");
    expect(driver.prompts[1]).toContain('{"risk":"HIGH","reason":"x"}');
  });

  it("fails after the second miss instead of returning a partial object", async () => {
    const driver = scripted(['{"risk":"HIGH"}', '{"risk":"still wrong"}']);
    const error = await generateStructured({ ...args, driver }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LlmSchemaValidationError);
    expect((error as LlmSchemaValidationError).schemaName).toBe("AnalysisRisk");
    expect((error as LlmSchemaValidationError).attempts).toBe(2);
    expect((error as LlmSchemaValidationError).issues.length).toBeGreaterThanOrEqual(2);
    expect(driver.prompts).toHaveLength(2);
  });

  it("treats a prose-only answer as a schema miss, not as an empty object", async () => {
    const driver = scripted(["I cannot help with that.", "Still no JSON."]);
    const error = await generateStructured({ ...args, driver }).catch((e: unknown) => e);

    expect((error as LlmSchemaValidationError).issues).toContain("response contained no JSON value");
  });

  it("sums tokens across the repair round and keeps the last cache share", async () => {
    const driver = scripted(['{"risk":"HIGH"}', '{"risk":"orta","reason":"y"}'], { cachePct: 30 });
    const result = await generateStructured({ ...args, driver });

    expect(result.tokensIn).toBe(20);
    expect(result.tokensOut).toBe(10);
    expect(result.cachePct).toBe(30);
  });
});

describe("extractJson", () => {
  it("reads plain, fenced and embedded JSON", () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('here you go: [1,2] thanks')).toEqual([1, 2]);
  });

  it("returns undefined for prose and broken JSON", () => {
    expect(extractJson("no json here")).toBeUndefined();
    expect(extractJson('{"a":')).toBeUndefined();
    expect(extractJson("")).toBeUndefined();
  });
});
