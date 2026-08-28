import type {
  ApiDriverId,
  DataClass,
  GenerateObjectRequest,
  LlmDriverId,
  LlmRole,
  SubscriptionAccount,
  SubscriptionDriverId,
} from "@maestro/contracts";
import { GenerateObjectRequest as GenerateObjectRequestSchema, LlmCallLog, isSubscriptionDriver } from "@maestro/contracts";
import type { PiiPolicy } from "@maestro/pii";
import type { AgentSessionOptions, LlmPort, SecretPort } from "@maestro/ports";
import type { z } from "zod";
import { type LlmGatewayConfig, parseGatewayConfig } from "./config.js";
import { AnthropicDirectDriver } from "./driver-anthropic.js";
import { BedrockDriver, VertexDriver } from "./driver-cloud.js";
import { OpenAiCompatDriver } from "./driver-openai.js";
import type { DriverDeps, LlmDriver } from "./driver-types.js";
import { AgentRunnerNotWiredError, LlmConfigError, SessionPolicyChangedError } from "./errors.js";
import { CallCounter, type FetchLike, TokenBucket } from "./http.js";
import { type MaskFn, type MaskedPayload, maskForEgress } from "./masking.js";
import {
  QUEUE_REASON_QUOTA,
  type GatewayOutcome,
  type QueuedOutcome,
  type SessionOutcome,
  haltedFrom,
} from "./outcomes.js";
import { ModelNotConfiguredError, NO_ENDPOINT_CONFIGURED, type ModelResolver, type ResolvedModel } from "./model-source.js";
import { LlmPolicy } from "./policy.js";
import { SubscriptionPool } from "./pool.js";
import { type AgentRunner, AgentSessionStore, type SessionPin, describePin } from "./session.js";
import { generateStructured } from "./structured.js";

export interface LlmGatewayDeps {
  secrets: SecretPort;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  random?: () => number;
  newId?: () => string;
  /** Wave 2 supplies the Claude Agent SDK runner (M17). */
  agentRunner?: AgentRunner;
  /**
   * Required only when the policy resolves to `masked_cloud` (M18/M20). Shaped
   * exactly like `@maestro/pii`'s `maskOutbound`, ReverseMap included.
   */
  mask?: MaskFn;
  /** Profile the gateway re-scans the masked payload with; defaults to the strict built-in. */
  piiPolicy?: PiiPolicy;
  onCallLog?: (log: LlmCallLog) => void;
  runId?: () => string | null;
  signRequest?: DriverDeps["signRequest"];
  accessToken?: DriverDeps["accessToken"];
  /**
   * The model this install actually dials, re-read on every call (M107).
   *
   * When absent, the gateway behaves exactly as it always has and every fact
   * comes from the static config. When present and answering a row, that
   * row's endpoint, model id, on-prem flag and credential OVERRIDE the config
   * for that call, so a model added or changed in the panel takes effect with
   * no restart. When present and answering `null`, the PANEL has no model —
   * and the static config answers next, which is what keeps a deployment that
   * names its endpoint in `.env` running unchanged even though both
   * entrypoints wire this resolver unconditionally. Only when the static
   * config names no endpoint either (`NO_ENDPOINT_CONFIGURED`) does the call
   * refuse by name rather than dialling a placeholder.
   *
   * See `model-source.ts` for why this is a thunk rather than a value, and for
   * the one part that deliberately stays a deployment decision.
   */
  resolveModel?: ModelResolver;
  /**
   * Where the "which source answered" journal line goes (default console).
   *
   * A two-layer model source needs its precedence to be VISIBLE: an operator
   * whose panel row shadows a `.env` value — or whose `.env` value is quietly
   * carrying the whole install because no row exists — must be able to read
   * which one the runs are actually using, or "I changed it and nothing
   * happened" becomes undiagnosable. Same reasoning, same shape as
   * `ConnectionSecretPort`'s announcement of a shadowed credential.
   */
  log?: (message: string) => void;
}

interface Routed {
  status: "ready";
  driver: LlmDriverId;
  model: string;
  transport: LlmDriver;
  credentialRef: string | null;
  accountId: string | null;
}

/**
 * The LLM gateway (M16/M17/M18/M55). Driver choice is policy, invisible to
 * callers: data class picks the permitted backends, role+variant picks the
 * model, and a subscription binding goes through the quota-aware pool.
 *
 * Both port methods return an `LlmOutcome`: `queued` (pool exhausted, wait until
 * `resumeAt`), `degraded` (continue human-led, M97) and `blocked` (stop) are
 * decisions, not exceptions. Exceptions mean something broke — transport,
 * provider, wiring, schema.
 */
export class LlmGateway implements LlmPort {
  private readonly policy: LlmPolicy;
  private readonly pool: SubscriptionPool;
  private readonly sessions: AgentSessionStore;
  private readonly drivers = new Map<ApiDriverId, LlmDriver>();
  private readonly now: () => Date;
  /** On-prem standing from the static config, used when no panel row is active. */
  private readonly staticOnPrem: ReadonlyMap<ApiDriverId, boolean>;
  /**
   * The row `activeModel()` last resolved, held only for the duration of one
   * call so `policy.resolve` and `route` agree about which server they are
   * deciding for. It is refreshed before every resolution and never cached
   * across calls — a model changed in the panel must be live on the next one.
   */
  #active: ResolvedModel | null = null;
  /**
   * Whether the static config names a REAL endpoint — i.e. any enabled HTTP
   * driver whose baseUrl is not the never-dialled `NO_ENDPOINT_CONFIGURED`
   * placeholder `llmConfig` writes for an install with no `LLM_BASE_URL`.
   * This is what separates "fall back to `.env`" from the honest
   * `ModelNotConfiguredError`: the refusal is reserved for a stack where the
   * panel has no row AND the environment names nothing.
   */
  readonly #staticEndpointConfigured: boolean;
  /**
   * The model-source line last written, deduplicated so the journal says which
   * layer answers ONCE per change rather than once per call — this resolves on
   * every request, and a per-call line would bury the thing it is saying.
   */
  #announcedSource: string | null = null;

  constructor(
    private readonly cfg: LlmGatewayConfig,
    private readonly deps: LlmGatewayDeps,
  ) {
    this.now = deps.now ?? (() => new Date());
    const fetchImpl = deps.fetchImpl ?? (globalThis.fetch as FetchLike | undefined);
    if (!fetchImpl) throw new LlmConfigError("no fetch implementation available");

    const driverDeps: DriverDeps = {
      secrets: deps.secrets,
      fetchImpl,
      now: this.now,
      sleep: deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
      random: deps.random ?? Math.random,
      bucket: new TokenBucket(cfg.rateLimit, this.now),
      retry: cfg.retry,
      signRequest: deps.signRequest,
      accessToken: deps.accessToken,
    };

    for (const driverCfg of cfg.drivers) {
      if (!driverCfg.enabled) continue;
      this.drivers.set(driverCfg.driver, buildDriver(driverCfg, driverDeps));
    }

    const onPrem = new Map(cfg.drivers.map((d) => [d.driver, d.onPrem && d.enabled] as const));
    this.staticOnPrem = onPrem;
    // Bedrock's baseUrl is optional (the public regional endpoint is implied),
    // so a driver WITHOUT one still counts as configured; only the explicit
    // placeholder marks "no endpoint anywhere".
    this.#staticEndpointConfigured = cfg.drivers.some(
      (d) => d.enabled && (!("baseUrl" in d) || d.baseUrl !== NO_ENDPOINT_CONFIGURED),
    );
    this.policy = new LlmPolicy(
      cfg,
      /**
       * Whether this driver counts as on-prem RIGHT NOW.
       *
       * When a panel row is active it is the authority — an operator who moved
       * the endpoint to a cloud vendor must not keep the on-prem standing the
       * `.env` binding had, and one who pointed it at an internal server must
       * gain it. `#active` is refreshed immediately before every `policy.resolve`
       * (see `activeModel`), so this closure reads a value that belongs to the
       * call being decided rather than to whenever the port was built.
       *
       * Falling back to the static map when no row is active is what keeps a
       * deployment configured entirely from `.env` behaving exactly as before.
       */
      (id) => (this.#active === null ? onPrem.get(id as ApiDriverId) === true : this.#active.onPrem),
      (id) => (isSubscriptionDriver(id) ? true : this.drivers.has(id as ApiDriverId)),
    );
    this.pool = new SubscriptionPool(cfg.subscriptionPool, this.now);
    this.sessions = new AgentSessionStore(deps.newId ?? (() => crypto.randomUUID()), this.now);
  }

  /** Thinking roles (M16/M19). One call, one schema, one outcome the caller branches on. */
  async generateObject<T>(request: GenerateObjectRequest, schema: z.ZodType<T>): Promise<GatewayOutcome<T>> {
    const req = GenerateObjectRequestSchema.parse(request);
    // BEFORE the policy: the confidential rule is decided against the endpoint
    // this call will really dial, not against whatever was true at boot.
    const active = await this.#activeModel();
    const decision = this.policy.resolve(req.role, req.variantId, req.dataClass);
    if (decision.kind !== "allow") return haltedFrom(decision);
    // Masking happens BEFORE a seat is taken: a missing masker is a wiring bug,
    // and a wiring bug must not cost quota.
    const masked = decision.masked ? this.mask(req.input, req.dataClass, "llm-gateway/generate-object") : null;
    const routed = this.route(decision.driver, decision.model);
    if (routed.status !== "ready") return routed;
    // A panel row names the model too, and it wins: the id the operator typed
    // is the one the test verified against `/v1/models`, so binding to a stale
    // `.env` name here would make a green test evidence about nothing.
    const target = overrideFor(routed, active);

    const counter = new CallCounter();
    try {
      const out = await generateStructured({
        driver: routed.transport,
        schemaName: req.schemaName,
        schema,
        input: masked === null ? req.input : masked.payload,
        call: {
          model: target.model,
          maxTokens: this.cfg.maxTokens,
          temperature: this.cfg.temperature,
          counter,
          ...(target.baseUrl === null ? {} : { baseUrl: target.baseUrl }),
          ...(target.credentialRef === null ? {} : { credentialRef: target.credentialRef }),
          ...(target.skipTlsVerify ? { skipTlsVerify: true } : {}),
        },
      });
      const { tokensIn, tokensOut, cachePct } = out;
      const { role, variantId, dataClass } = req;
      // The log records what was ACTUALLY dialled, so the audit trail names the
      // model that answered rather than the one a config file still mentions.
      const log = this.writeLog({ role, variantId, dataClass, driver: routed.driver, model: target.model, tokensIn, tokensOut, cachePct });
      return { status: "ok", value: out.object, log, ...(masked === null ? {} : { unmask: masked.unmask }) };
    } finally {
      // A failed call still burned the seat's quota — retries included.
      if (routed.accountId !== null) this.pool.record(routed.accountId, Math.max(1, counter.attempts));
    }
  }

  /**
   * Doing roles (M17); execution itself is delegated (Wave 2). EVERY turn is
   * re-resolved against the policy, so a narrowed route or a kill-switch (M58)
   * reaches sessions that are already open — and a resolution that contradicts
   * the session's pin is refused rather than quietly ignored.
   *
   * The data class comes from the CALLER (`opts.dataClass`): a resume that
   * arrives with a different class than the session was opened with produces a
   * different pin and is refused, exactly like a policy change would be.
   */
  async agentSession(opts: AgentSessionOptions): Promise<SessionOutcome> {
    const runner = this.deps.agentRunner;
    if (!runner) throw new AgentRunnerNotWiredError();
    const role: LlmRole = this.cfg.agentRole;
    const { dataClass, variantId } = opts;

    const existing = opts.resumeToken === undefined ? null : this.sessions.resume(opts.resumeToken, opts.workspacePath);
    // Re-resolved per turn, exactly like the policy is: a model changed in the
    // panel mid-session must be seen here, and the pin check below is what
    // decides whether the session may continue on it.
    await this.#activeModel();
    const decision = this.policy.resolve(role, variantId, dataClass);
    if (decision.kind !== "allow") return haltedFrom(decision);
    const pin: SessionPin = { driver: decision.driver, model: decision.model, dataClass, masked: decision.masked };
    if (existing && !samePin(existing, pin)) {
      throw new SessionPolicyChangedError(existing.resumeToken, describePin(existing), describePin(pin));
    }

    const masked = pin.masked ? this.mask(opts.task, dataClass, "llm-gateway/agent-session") : null;
    const routed = this.route(pin.driver, pin.model);
    if (routed.status !== "ready") return routed;

    const record = existing ?? this.sessions.start(pin, opts.workspacePath);
    try {
      const out = await runner.run({
        driver: routed.driver,
        model: routed.model,
        workspacePath: opts.workspacePath,
        task: masked === null ? opts.task : masked.payload,
        mcpServers: opts.mcpServers,
        vendorSessionId: record.vendorSessionId,
        credentialRef: routed.credentialRef,
      });
      this.sessions.complete(record.resumeToken, out.vendorSessionId ?? null);
      const log = this.writeLog({
        role, variantId, dataClass, driver: routed.driver,
        model: routed.model, tokensIn: out.tokensIn, tokensOut: out.tokensOut, cachePct: null,
      });
      return {
        status: "ok",
        value: { resumeToken: record.resumeToken, finalText: out.finalText, log },
        log,
        ...(masked === null ? {} : { unmask: masked.unmask }),
      };
    } finally {
      if (routed.accountId !== null) this.pool.record(routed.accountId);
    }
  }

  /** Quota view for Studio/KPI (M62). */
  poolSnapshot(): SubscriptionAccount[] {
    return this.pool.snapshot();
  }

  /**
   * Refresh the active model row and answer with it.
   *
   * Called at the TOP of every port method, before the policy is consulted, so
   * that the routing decision and the request that follows describe the same
   * server. The precedence is ROW → ENV → REFUSAL, and each layer is a
   * different situation:
   *
   *   - resolver with a row → that row wins for this call.
   *   - resolver, no row (or no resolver at all) → `null`, and every fact
   *     stays the static config's. Both entrypoints wire the resolver
   *     UNCONDITIONALLY, so this is the path every deployment configured only
   *     in `.env` takes on every call — including the panel-configured stack
   *     whose database blips, because `connectionModelFrom` maps a read
   *     failure to `null` rather than failing a call the environment can
   *     still answer.
   *   - nothing at either layer (`#staticEndpointConfigured` false) →
   *     `ModelNotConfiguredError`. A fresh install BOOTS and refuses HERE, at
   *     first use, naming the panel — the same shape the work/ci/scan ports
   *     use, and the reason the process does not demand a model at startup:
   *     the panel is how one gets added.
   */
  async #activeModel(): Promise<ResolvedModel | null> {
    const active = this.deps.resolveModel === undefined ? null : await this.deps.resolveModel();
    if (active === null) {
      if (!this.#staticEndpointConfigured) throw new ModelNotConfiguredError();
      // Announced only when a panel layer exists to lose: absent a resolver
      // there is one source, no precedence, and nothing worth a journal line.
      if (this.deps.resolveModel !== undefined) {
        this.#announceSource(
          "env",
          "[maestro] llm: panelde etkin bir model bağlantısı yok; `.env` yapılandırması (LLM_BASE_URL/LLM_MODEL) kullanılıyor.",
        );
      }
      this.#active = null;
      return null;
    }
    this.#announceSource(
      `panel ${active.baseUrl} ${active.model}`,
      `[maestro] llm: model panelde tanımlı bağlantıdan çözüldü (${active.baseUrl}, model "${active.model}"); ` +
        "`.env` içindeki LLM_BASE_URL/LLM_MODEL değerleri yok sayılıyor.",
    );
    this.#active = active;
    return active;
  }

  /** Write the model-source line when the answering layer (or row) changes. */
  #announceSource(key: string, message: string): void {
    if (this.#announcedSource === key) return;
    this.#announcedSource = key;
    (this.deps.log ?? ((m: string) => console.info(m)))(message);
  }

  private route(driver: LlmDriverId, model: string): Routed | QueuedOutcome {
    if (!isSubscriptionDriver(driver)) {
      return { status: "ready", driver, model, transport: this.transport(driver as ApiDriverId), credentialRef: null, accountId: null };
    }
    const acquired = this.pool.acquire(driver as SubscriptionDriverId);
    if (!acquired.ok) return { status: "queued", resumeAt: acquired.resumeAt, reason: QUEUE_REASON_QUOTA };
    const { transport, credentialRef, accountId } = acquired.account;
    return { status: "ready", driver, model, transport: this.transport(transport), credentialRef, accountId };
  }

  private transport(id: ApiDriverId): LlmDriver {
    const driver = this.drivers.get(id);
    if (!driver) throw new LlmConfigError(`driver "${id}" is not configured or is disabled`);
    return driver;
  }

  private mask<T>(payload: T, dataClass: DataClass, boundary: string): MaskedPayload<T> {
    return maskForEgress(this.deps.mask, payload, { dataClass, boundary }, this.deps.piiPolicy);
  }

  private writeLog(fields: Omit<LlmCallLog, "at" | "runId" | "usd">): LlmCallLog {
    // usd is null by design: subscription cost is quota (M55) and no price
    // table lives in this package — a guessed dollar figure would be worse.
    const log = LlmCallLog.parse({
      at: this.now().toISOString(),
      runId: this.deps.runId?.() ?? null,
      usd: null,
      ...fields,
    });
    this.deps.onCallLog?.(log);
    return log;
  }
}

/**
 * What this call should actually dial, once a panel row has had its say.
 *
 * A row overrides the endpoint and the model id, but ONLY for the HTTP
 * transports. A subscription seat is deliberately left alone: it carries its
 * own credential and its own vendor endpoint (`route` already picked both from
 * the pool), and a self-hosted address has no meaning for a CLI running against
 * a consumer subscription. Overriding it would point a seat at a server it
 * cannot authenticate to.
 */
function overrideFor(
  routed: Routed,
  active: ResolvedModel | null,
): { model: string; baseUrl: string | null; credentialRef: string | null; skipTlsVerify: boolean } {
  if (active === null || routed.accountId !== null) {
    return { model: routed.model, baseUrl: null, credentialRef: routed.credentialRef, skipTlsVerify: false };
  }
  return {
    model: active.model,
    baseUrl: active.baseUrl,
    credentialRef: active.apiKeyRef,
    // Rides with the row's address: the handshake the probe tested is the
    // handshake the run performs (see `ResolvedModel.skipTlsVerify`).
    skipTlsVerify: active.skipTlsVerify === true,
  };
}

/** A session may only continue on the exact backend/class/masking it opened with. */
function samePin(a: SessionPin, b: SessionPin): boolean {
  return a.driver === b.driver && a.model === b.model && a.dataClass === b.dataClass && a.masked === b.masked;
}

function buildDriver(cfg: LlmGatewayConfig["drivers"][number], deps: DriverDeps): LlmDriver {
  switch (cfg.driver) {
    case "anthropic-direct": return new AnthropicDirectDriver(cfg, deps);
    case "openai-compat": return new OpenAiCompatDriver(cfg, deps);
    case "aws-bedrock": return new BedrockDriver(cfg, deps);
    case "google-vertex": return new VertexDriver(cfg, deps);
  }
}

/** Build a gateway from raw (unvalidated) config — the composition-root entry. */
export function createLlmGateway(config: unknown, deps: LlmGatewayDeps): LlmGateway {
  return new LlmGateway(parseGatewayConfig(config), deps);
}
