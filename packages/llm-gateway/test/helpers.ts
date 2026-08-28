import { defaultPiiPolicy, maskOutbound } from "@maestro/pii";
import type { SecretPort } from "@maestro/ports";
import type { AgentRunInput, AgentRunOutput, FetchLike, LlmGatewayDeps, MaskFn } from "../src/index.js";

/** A checksum-valid TR IBAN and TCKN — real shapes, fictional people. */
export const SAMPLE_IBAN = "TR330006100519786457841326";
export const SAMPLE_TCKN = "10000000146";

/**
 * The masker the composition root wires: `@maestro/pii`'s `maskOutbound`
 * adapted to `deps.mask`. Using the real thing is the point — it proves the two
 * signatures actually fit (B8).
 */
export function piiMask(): MaskFn {
  return (payload, context) =>
    maskOutbound(payload, { policy: defaultPiiPolicy(), dataClass: context.dataClass, boundary: context.boundary });
}

export interface RunnerStub {
  inputs: AgentRunInput[];
  run: (input: AgentRunInput) => Promise<AgentRunOutput>;
}

/** Agent runner double: answers in order, records every input. */
export function stubRunner(outputs: AgentRunOutput[]): RunnerStub {
  const inputs: AgentRunInput[] = [];
  let index = 0;
  return {
    inputs,
    run: (input) => {
      inputs.push(input);
      const out = outputs[index];
      index += 1;
      if (!out) throw new Error(`unexpected runner call #${index}`);
      return Promise.resolve(out);
    },
  };
}

export interface StubResponse {
  status?: number;
  body?: unknown;
  /** Raw body wins over `body` — used for the "not JSON" path. */
  raw?: string;
  headers?: Record<string, string>;
  /** Simulates a transport failure (DNS, TLS, timeout). */
  throws?: string;
}

export interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface FetchStub {
  fetchImpl: FetchLike;
  calls: RecordedCall[];
  sleeps: number[];
  sleep: (ms: number) => Promise<void>;
}

/** Offline fetch double: answers in order, fails loudly on an unexpected call. */
export function stubFetch(responses: StubResponse[]): FetchStub {
  const calls: RecordedCall[] = [];
  const sleeps: number[] = [];
  let index = 0;

  const fetchImpl: FetchLike = (url, init) => {
    const spec = responses[index];
    index += 1;
    if (!spec) throw new Error(`unexpected fetch call #${index}: ${init?.method ?? "GET"} ${url}`);

    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: { ...((init?.headers ?? {}) as Record<string, string>) },
      body: typeof init?.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : undefined,
    });
    if (spec.throws !== undefined) return Promise.reject(new Error(spec.throws));

    const payload = spec.raw ?? (spec.body === undefined ? null : JSON.stringify(spec.body));
    return Promise.resolve(
      new Response(payload, {
        status: spec.status ?? 200,
        headers: { ...(payload === null ? {} : { "content-type": "application/json" }), ...(spec.headers ?? {}) },
      }),
    );
  };

  return {
    fetchImpl,
    calls,
    sleeps,
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };
}

export interface FakeClock {
  now: () => Date;
  advance: (ms: number) => void;
  set: (iso: string) => void;
}

/** Injected clock — no test ever reads the wall clock. */
export function fakeClock(startIso = "2026-08-08T09:00:00.000Z"): FakeClock {
  let ms = Date.parse(startIso);
  return {
    now: () => new Date(ms),
    advance: (delta) => {
      ms += delta;
    },
    set: (iso) => {
      ms = Date.parse(iso);
    },
  };
}

export function stubSecrets(values: Record<string, string> = {}): SecretPort {
  return {
    get: (key) => Promise.resolve(values[key] ?? `secret-for-${key}`),
    issueShortLived: (scope) =>
      Promise.resolve({ secret: `short-${scope}`, expiresAt: "2026-08-08T10:00:00.000Z" }),
    set: () => Promise.reject(new Error("not used")),
  };
}

/** Deterministic id source for resume tokens. */
export function idSequence(prefix = "session"): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}-${n}`;
  };
}

export function gatewayDeps(stub: FetchStub, clock: FakeClock, extra: Partial<LlmGatewayDeps> = {}): LlmGatewayDeps {
  return {
    secrets: stubSecrets(),
    fetchImpl: stub.fetchImpl,
    sleep: stub.sleep,
    now: clock.now,
    random: () => 0.5,
    newId: idSequence(),
    ...extra,
  };
}
