import { z } from "zod";
import type { DriverCall, DriverResult, LlmDriver } from "./driver-types.js";
import { LlmSchemaValidationError } from "./errors.js";

export interface StructuredArgs<T> {
  driver: LlmDriver;
  schemaName: string;
  schema: z.ZodType<T>;
  input: unknown;
  call: Omit<DriverCall, "prompt" | "system">;
}

export interface StructuredResult<T> {
  object: T;
  tokensIn: number;
  tokensOut: number;
  cachePct: number | null;
  attempts: number;
}

const SYSTEM =
  "You are a structured-output service. Reply with a single JSON value that satisfies the given schema. " +
  "No prose, no markdown fences, no explanation.";

/**
 * Structured output (M17). The model gets the schema, the answer is parsed and
 * validated; a schema miss buys exactly ONE repair round carrying the concrete
 * validation issues, and a second miss is an error — never a partial object.
 */
export async function generateStructured<T>(args: StructuredArgs<T>): Promise<StructuredResult<T>> {
  const prompt = initialPrompt(args.schemaName, args.schema, args.input);
  const first = await args.driver.complete({ ...args.call, system: SYSTEM, prompt });
  const firstTry = validate(args.schema, first.text);
  if (firstTry.ok) return result(firstTry.value, [first], 1);

  const second = await args.driver.complete({
    ...args.call,
    system: SYSTEM,
    prompt: repairPrompt(prompt, first.text, firstTry.issues),
  });
  const secondTry = validate(args.schema, second.text);
  if (secondTry.ok) return result(secondTry.value, [first, second], 2);

  throw new LlmSchemaValidationError(args.schemaName, 2, [...firstTry.issues, ...secondTry.issues]);
}

function result<T>(object: T, calls: DriverResult[], attempts: number): StructuredResult<T> {
  return {
    object,
    attempts,
    tokensIn: calls.reduce((sum, c) => sum + c.tokensIn, 0),
    tokensOut: calls.reduce((sum, c) => sum + c.tokensOut, 0),
    // The last round's cache share: the earlier round already primed the cache.
    cachePct: calls[calls.length - 1]?.cachePct ?? null,
  };
}

function initialPrompt(schemaName: string, schema: z.ZodType<unknown>, input: unknown): string {
  return [
    `Schema name: ${schemaName}`,
    `JSON schema:\n${describe(schema)}`,
    // A string input is already rendered (e.g. masked payload — M18/M20).
    `Input:\n${typeof input === "string" ? input : JSON.stringify(input, null, 2)}`,
    "Return only the JSON value.",
  ].join("\n\n");
}

function repairPrompt(original: string, previous: string, issues: string[]): string {
  return [
    original,
    `Your previous answer did not satisfy the schema:\n${previous}`,
    `Validation errors:\n- ${issues.join("\n- ")}`,
    "Return a corrected JSON value that fixes every error above.",
  ].join("\n\n");
}

/** JSON Schema when zod can produce one; the schema name alone otherwise. */
function describe(schema: z.ZodType<unknown>): string {
  try {
    return JSON.stringify(z.toJSONSchema(schema, { io: "output" }), null, 2);
  } catch {
    return "(schema could not be serialised; follow the field names in the input contract)";
  }
}

type Validation<T> = { ok: true; value: T } | { ok: false; issues: string[] };

function validate<T>(schema: z.ZodType<T>, text: string): Validation<T> {
  const json = extractJson(text);
  if (json === undefined) return { ok: false, issues: ["response contained no JSON value"] };

  const parsed = schema.safeParse(json);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`) };
}

/** Tolerates a fenced block or leading chatter; anything else fails loudly. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.search(/[[{]/);
  if (start === -1) return undefined;
  const end = Math.max(candidate.lastIndexOf("}"), candidate.lastIndexOf("]"));
  if (end < start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
}
