import type { z } from "zod";
import { GithubResponseError } from "./errors.js";

/** Validates an API payload, reporting every Zod issue as one error. */
export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, operation: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new GithubResponseError(
      operation,
      result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
    );
  }
  return result.data;
}
