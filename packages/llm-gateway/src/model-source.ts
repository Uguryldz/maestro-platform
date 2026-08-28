/**
 * The model an install actually dials, resolved PER CALL rather than at boot.
 *
 * ── WHAT THIS FIXES ─────────────────────────────────────────────────────────
 * `llmConfig` used to read `LLM_BASE_URL` and `LLM_MODEL` synchronously while
 * composing the port, so the endpoint and the model id were frozen into the
 * driver at process start. The panel could store both — the connection form has
 * collected them since the `openai_compat` kind was added — and the runtime
 * read neither. An operator changed the address, watched the test go green, and
 * every run kept reaching the old server. The panel was a decoration for the
 * two fields that decide WHICH MODEL ANSWERS.
 *
 * ── WHY A RESOLVER AND NOT A REBUILT PORT ───────────────────────────────────
 * The same reasoning that put the API key behind `ConnectionSecretPort`. Every
 * adapter in this codebase resolves its credential through a THUNK invoked on
 * each request (`token: () => deps.secrets.get(ref)`), never a value captured
 * at composition time, and that is exactly the property that lets a token
 * rotated in the panel take effect on the next call with no restart.
 *
 * The endpoint and the model id are the same kind of fact, so they get the same
 * treatment: an async function the driver calls when it is about to build a
 * request. `buildPortSelection` stays SYNCHRONOUS, the registry stays untouched,
 * the frozen `packages/ports` contract stays untouched, and no boot sequence
 * learns to await a database. That is the whole reason this shape was chosen
 * over an async, rebuildable composition root — the boot-time rewiring that was
 * judged not worth the risk twice before is still not performed here.
 *
 * ── WHAT IT DELIBERATELY DOES NOT DECIDE ────────────────────────────────────
 * Which DRIVER CLASS serves the call. That genuinely cannot move: the gateway
 * instantiates one transport per configured driver in its constructor, and
 * `ApiDriverId` is a closed enum in the frozen contracts. So a UI row may
 * retarget the `openai-compat` transport — its address, its model, its key,
 * whether it counts as on-prem — but it may not turn that transport into a
 * bedrock or a vertex client. This is the minimal irreducible part named
 * plainly: the PROTOCOL stays a deployment decision, the SERVER stops being
 * one. Every self-hosted case the operator has (vLLM, llama.cpp, Ollama,
 * gpt-oss on OpenShift) speaks the OpenAI protocol, so the part that cannot
 * move is not the part anyone needed to change.
 */

/**
 * What a resolver answers with, or `null` when the PANEL has no model row.
 *
 * `null` is a REAL answer and not a failure — and it is the panel's answer
 * only, never the install's. The gateway holds a second, static layer (the
 * `.env`-derived driver config), and `null` hands the decision to it: a
 * deployment that still names `LLM_BASE_URL` keeps running on it exactly as
 * before the panel existed. Only when the static layer names no endpoint
 * either (its `baseUrl` is `NO_ENDPOINT_CONFIGURED`) does the call refuse —
 * at first USE, by name, exactly as the `work`/`ci`/`scan` ports refuse,
 * because a fresh stack must boot with no model at all so the panel can be
 * the place one is added.
 */
export interface ResolvedModel {
  /**
   * The server's root, WITHOUT a trailing `/v1` — the driver appends the
   * version segment itself. The panel normalises what the operator pasted
   * (`normalizeOpenAiBaseUrl`), so both the test probe and the run address the
   * same server and a green test is evidence about the real URL.
   */
  readonly baseUrl: string;
  /** The model id this server serves, as `/v1/models` lists it. */
  readonly model: string;
  /**
   * Whether this endpoint runs inside the institution.
   *
   * The M18 confidential rule leans on this flag and nothing else — never on a
   * guess made from the URL, because a private address is not the same claim as
   * an operator asserting where the weights run. A row added through the panel
   * is therefore subject to the identical test a `.env` binding was: the `gizli`
   * class reaches it only when this is true.
   */
  readonly onPrem: boolean;
  /**
   * Where the key lives, as a SecretPort reference — never the key itself, so
   * this object stays safe to log.
   *
   * This is the PICKED ROW'S OWN slot (`connector:<id>:<rand>`, the reference
   * the panel's `storeToken` wrote), so the endpoint, the model id, the
   * on-prem flag and the credential are all facts of the same row. It used to
   * be the shared `kv/llm#api-key` reference, resolved by scanning connection
   * rows — and with several model rows the scan could pick a DIFFERENT row
   * than the model resolver did, sending one server another server's key. A
   * row whose operator never stored a token (secretRef null) names the shared
   * env reference instead, which is the honest "the key still lives in `.env`"
   * case; an empty string stored in the slot still means "send no key at all".
   */
  readonly apiKeyRef: string;
  /**
   * The row's "skip TLS certificate verification" switch
   * (`config.skipTlsVerify === "true"` in the connection's non-secret bag).
   *
   * Carried here so the RUN performs the same handshake the panel's probe
   * did — the probe honours the flag through `shouldSkipTlsVerify`, and a
   * green test over a skipped handshake followed by a run that verified (and
   * failed) would be the exact test≠run asymmetry this resolver exists to
   * close. Internal addresses (loopback/RFC1918/`.local`) skip automatically
   * regardless of this flag; see `tls.ts` for the rule and its trade-off.
   *
   * Optional, and absence means OFF: a resolver predating the flag keeps its
   * exact old meaning, and an unanswered question fails closed onto full
   * verification.
   */
  readonly skipTlsVerify?: boolean;
}

/**
 * The static config's baseUrl on an install that names none — NEVER DIALLED.
 *
 * Written by `llmConfig` (apps/deploy) when `LLM_BASE_URL` is absent, because
 * the driver's schema demands a syntactically valid URL to compose at all, and
 * a stack configured entirely from the panel has no address to give it at
 * boot. It lives HERE, not in deploy, because the gateway is what must
 * RECOGNIZE it: a resolver that finds no panel row falls back to the static
 * config, and this value is how the gateway tells "a real `.env` endpoint"
 * from "nothing is configured anywhere" — the only case that may raise
 * `ModelNotConfiguredError`.
 *
 * `.invalid` is the RFC 2606 reserved TLD, guaranteed never to resolve. That
 * is chosen over a plausible-looking default deliberately: if this value ever
 * DID escape into a request, the failure must be an instant, obvious DNS
 * refusal — not a connection to a host somebody else controls.
 */
export const NO_ENDPOINT_CONFIGURED = "https://model-not-configured.invalid";

/**
 * Resolves the panel's active model, or `null` when the panel has none —
 * the static config then decides, see `ResolvedModel`'s note on `null`.
 *
 * Called on EVERY request on purpose — there is no cache. A model changed in
 * the panel is live on the next call, and the alternative is the class of bug
 * where an operator fixes a setting, sees nothing change, and cannot tell
 * whether they fixed the wrong thing or the platform simply did not notice.
 * The read is one indexed query on a table with a handful of rows, on a path
 * that is already about to make a network call to an inference server.
 */
export type ModelResolver = () => Promise<ResolvedModel | null>;

/** The marker a not-configured refusal carries, mirroring `unavailable-ports`. */
export const NOT_CONFIGURED_MARKER = "MAESTRO_NOT_CONFIGURED";

/**
 * Raised when a run asks for a model on an install that has none.
 *
 * It is an ERROR rather than an `LlmOutcome` state, and that distinction is
 * deliberate. `degrade` and `block` are POLICY decisions — the platform
 * considered this call and declined it — and callers branch on them to continue
 * human-led. "Nobody has configured a model yet" is not a policy decision about
 * the request; it is a gap in the installation, and dressing it up as a policy
 * degrade would make an unconfigured stack indistinguishable from one whose
 * compliance rules are working correctly.
 *
 * The message names the panel rather than a variable, because the panel is now
 * where a model is added — telling an operator to edit a file on the server is
 * what the previous two rounds of this got wrong.
 */
export class ModelNotConfiguredError extends Error {
  constructor() {
    super(
      `${NOT_CONFIGURED_MARKER} llm: bu kuruluma henüz bir model tanımlanmadı. ` +
        "Ayarlar & bağlantılar ekranından \"Kurum içi model sunucusu (OpenAI uyumlu)\" " +
        "türünde bir bağlantı ekleyin: adres, model adı ve (gerekiyorsa) API anahtarı " +
        "orada girilir, kaydettiğiniz anda çalışan servisler onu kullanır — yeniden " +
        "başlatma gerekmez.",
    );
    this.name = "ModelNotConfiguredError";
  }
}

/** Whether a thrown value is the "no model configured yet" refusal. */
export function isModelNotConfigured(error: unknown): boolean {
  return error instanceof ModelNotConfiguredError;
}
