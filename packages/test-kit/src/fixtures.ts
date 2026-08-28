import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";

/**
 * Contract-test fixture loader. Fixtures are RECORDED REAL responses
 * (insa-plani §6): adapters are tested against them until corporate access
 * enables live smoke tests. Always parse through a schema — an unvalidated
 * fixture is a hallucinated integration waiting to happen.
 */
export function loadFixture<T>(dir: string, name: string, schema: z.ZodType<T>): T {
  const raw = readFileSync(join(dir, `${name}.json`), "utf8");
  return schema.parse(JSON.parse(raw));
}
