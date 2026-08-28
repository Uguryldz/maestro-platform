import type { ReadModels } from "@maestro/bff";
import { describe, expect, it } from "vitest";
import {
  MISSING_READ_MODELS,
  unbridgedReadModels,
  unbridgedReadError,
} from "../src/stores/read-models.js";

/**
 * Studio's unwired read side.
 *
 * The property under test is not "these throw" — it is that they CANNOT be
 * mistaken for an answer. A read model that returned an empty page would pass
 * a naive smoke test and then tell an operator the platform is idle while the
 * database sits unreachable, so every assertion below is about the refusal
 * being loud, attributable and quiet about secrets.
 */

/** The keys `BffDeps.read` requires, spelled out rather than derived from the object. */
const EXPECTED_MODELS = [
  "runs",
  "journal",
  "gates",
  "apps",
  "knowledge",
  "runners",
  "quota",
  "cost",
  "scans",
  "evidence",
  "audit",
  "health",
  "onboarding",
  "repoPolicy",
] as const satisfies readonly (keyof ReadModels)[];

/** Every method the BFF's read interfaces declare, per model. */
const METHODS: Record<keyof ReadModels, readonly string[]> = {
  runs: ["get", "list"],
  journal: ["list", "summary"],
  gates: ["listOpen"],
  apps: ["get", "list", "repoCard"],
  knowledge: ["search"],
  runners: ["list", "sandboxes"],
  quota: ["accounts"],
  cost: ["calls"],
  scans: ["list"],
  evidence: ["get"],
  audit: ["list", "verify"],
  health: ["services"],
  onboarding: ["options", "recentTickets", "binding"],
  repoPolicy: ["list", "get"],
};

function methodOf(read: ReadModels, model: keyof ReadModels, method: string): () => Promise<unknown> {
  const target = read[model] as unknown as Record<string, () => Promise<unknown>>;
  return target[method]!.bind(target);
}

/** Every (model, method) pair, flattened for table-driven tests. */
const ALL_METHODS = EXPECTED_MODELS.flatMap((model) =>
  METHODS[model].map((method) => [model, method] as const),
);

/**
 * The `Error` a call rejects with — failing the test if it resolves instead.
 * Returning the resolved value here would let "it answered with an empty page"
 * masquerade as a passing message assertion.
 */
async function rejection(call: () => Promise<unknown>): Promise<Error> {
  let resolved: unknown;
  try {
    resolved = await call();
  } catch (error) {
    if (error instanceof Error) return error;
    throw new Error(`rejected with a non-Error: ${String(error)}`);
  }
  throw new Error(`resolved with ${JSON.stringify(resolved)} instead of refusing`);
}

describe("unbridgedReadModels: shape", () => {
  it("fills every key BffDeps.read requires", () => {
    // The compiler already enforces this, but a structural check catches a
    // key that was satisfied by `undefined` through a cast.
    const read = unbridgedReadModels();
    expect(Object.keys(read).sort()).toEqual([...EXPECTED_MODELS].sort());
    for (const model of EXPECTED_MODELS) {
      expect(read[model], `read.${model} is missing`).toBeTypeOf("object");
      expect(read[model]).not.toBeNull();
    }
  });

  it("covers every read model `BffDeps.read` declares", () => {
    // Derived rather than a literal count. The number grew from twelve to
    // fourteen when onboarding and repoPolicy landed, and a hard-coded 12 makes
    // that growth look like a failure — while `EXPECTED_MODELS` is already
    // pinned to `keyof ReadModels` by `satisfies`, so a model added upstream
    // without an entry there still breaks the build.
    expect(EXPECTED_MODELS.length).toBeGreaterThanOrEqual(12);
    expect(ALL_METHODS.length).toBeGreaterThanOrEqual(EXPECTED_MODELS.length);
  });

  it("exposes every declared method as a function", () => {
    const read = unbridgedReadModels();
    for (const [model, method] of ALL_METHODS) {
      expect(methodOf(read, model, method), `${model}.${method}`).toBeTypeOf("function");
    }
  });

  it("hands out independent instances rather than a shared mutable singleton", () => {
    expect(unbridgedReadModels()).not.toBe(unbridgedReadModels());
  });
});

describe("unbridgedReadModels: every method refuses", () => {
  it.each(ALL_METHODS)("%s.%s rejects instead of returning empty data", async (model, method) => {
    const read = unbridgedReadModels();
    // Called with no arguments on purpose: a refusal must not depend on the
    // caller passing a well-formed filter.
    await expect(methodOf(read, model, method)()).rejects.toThrow(Error);
  });

  it.each(ALL_METHODS)("%s.%s never resolves to a value", async (model, method) => {
    const read = unbridgedReadModels();
    const settled = await methodOf(read, model, method)().then(
      (value) => ({ ok: true as const, value }),
      () => ({ ok: false as const }),
    );
    // The failure this guards against: `{items: [], nextCursor: null}`, `[]`
    // or `null` — each of which renders as "nothing here" in Studio.
    expect(settled.ok, `${model}.${method} resolved with ${JSON.stringify(settled)}`).toBe(false);
  });

  it("rejects rather than throwing synchronously, so an unawaited call still fails", () => {
    const read = unbridgedReadModels();
    // If this threw synchronously the expression itself would blow up here.
    const promise = read.runs.list({ limit: 50, cursor: null, appId: null, projectKeys: null, archived: "active" });
    expect(promise).toBeInstanceOf(Promise);
    return expect(promise).rejects.toThrow(/runs\.list/);
  });
});

describe("unbridgedReadModels: the refusal is attributable", () => {
  it.each(ALL_METHODS)("%s.%s names the model and the method", async (model, method) => {
    const read = unbridgedReadModels();
    const error = await rejection(methodOf(read, model, method));

    expect(error).toBeInstanceOf(Error);
    // An operator reading one line in the aggregator must be able to say which
    // screen broke and why, without a stack trace.
    expect(error.message).toContain(model);
    expect(error.message).toContain(method);
    expect(error.message).toContain(`${model}.${method}`);
  });

  it.each(ALL_METHODS)("%s.%s says what is missing, not just that it failed", async (model, method) => {
    const read = unbridgedReadModels();
    const error = await rejection(methodOf(read, model, method));

    expect(error.message).toMatch(/not wired/);
    // "what do I have to install to fix this" must be answerable from the message.
    expect(error.message).toMatch(/no .*(implementation|store|index|probe|driver|runner)/i);
    expect(error.message.length).toBeGreaterThan(60);
  });

  it("gives each model its own explanation rather than one generic sentence", async () => {
    const read = unbridgedReadModels();
    const reasons = new Set<string>();
    for (const model of EXPECTED_MODELS) {
      const method = METHODS[model][0]!;
      const error = await rejection(methodOf(read, model, method));
      reasons.add(error.message.split("not wired —")[1] ?? error.message);
    }
    expect(reasons.size).toBe(EXPECTED_MODELS.length);
  });

  it("lists every unwired read model for the boot banner", () => {
    expect(MISSING_READ_MODELS).toHaveLength(EXPECTED_MODELS.length);
    for (const model of EXPECTED_MODELS) {
      expect(MISSING_READ_MODELS.some((line) => line.startsWith(`${model} (`))).toBe(true);
    }
  });
});

describe("unbridgedReadModels: the refusal leaks nothing", () => {
  /**
   * These messages reach an HTTP error body and a shared log aggregator. A
   * connection string in either is a credential disclosure, and the read
   * models are exactly the layer that would have one in scope.
   */
  const SECRET_PATTERNS: readonly [string, RegExp][] = [
    ["password", /password|passwd|passphrase/i],
    ["token", /\btokens?\b|bearer|api[-_ ]?key|secret[-_ ]?key/i],
    ["connection string", /postgres(ql)?:\/\/|mysql:\/\/|redis:\/\/|amqp:\/\//i],
    ["credentials in a URL", /\/\/[^/\s]+:[^/\s]+@/],
    ["env var value", /DATABASE_URL\s*=|JIRA_[A-Z_]*\s*=|VAULT_[A-Z_]*\s*=/],
    ["private key", /BEGIN [A-Z ]*PRIVATE KEY/],
  ];

  it.each(ALL_METHODS)("%s.%s message carries no secret-shaped text", async (model, method) => {
    const read = unbridgedReadModels();
    const error = await rejection(methodOf(read, model, method));

    for (const [label, pattern] of SECRET_PATTERNS) {
      expect(error.message, `${model}.${method} leaks ${label}`).not.toMatch(pattern);
    }
  });

  it("does not echo the caller's arguments back into the message", async () => {
    // A ticket key, a knowledge query or an actor name is business data; a log
    // line is a wider audience than the request that produced it.
    const read = unbridgedReadModels();
    const secretish = "PROJ-4242-super-secret-query";
    const error = await rejection(() =>
      read.knowledge.search({ text: secretish, appId: secretish, limit: 10, cursor: secretish }),
    );

    expect(error.message).not.toContain(secretish);
  });

  it("keeps the same guarantees when the error is built directly", () => {
    const error = unbridgedReadError("audit", "verify") as unknown as {
      status: number;
      code: string;
      details: { capability: string; missing: string };
      message: string;
    };
    // 503, not 500: an unwired capability is not a broken platform. The
    // screen-by-screen sweep found `/cache` answering 503 and `/studio/runners`
    // answering 500 for the identical reason.
    expect(error.status).toBe(503);
    expect(error.code).toBe("capability_not_wired");
    expect(error.details.capability).toBe("audit.verify");
    // The leak guarantee still holds, now across every field a client or a log
    // aggregator can read.
    const everything = JSON.stringify(error.details) + error.message;
    expect(everything).not.toMatch(/postgres(ql)?:\/\//i);
  });
});
