import type { Connection, ConnectionInput, ConnectionKind } from "@maestro/contracts";
import { classifyNetworkFailure, insecureFetch, shouldSkipTlsVerify } from "@maestro/llm-gateway";
import type { ConnectionRecord } from "./connection-store.js";
import type { UserDirectory, UserRecord } from "./deps.js";

/**
 * The connector service: turning a validated `ConnectionInput` into a stored
 * `ConnectionRecord`, masking a token for read, and running the LIVE test.
 *
 * Two rules run through all of it. First, a raw token appears in exactly one
 * place — the inbound `ConnectionInput.token` — and never leaves this process:
 * it is enciphered by the caller's `SecretPort`, and what a read returns is a
 * four-character mask, never the value. Second, the test uses the STORED
 * credential, never one the caller supplied on the test request: a viewer who
 * could hand a token to a test endpoint could exfiltrate it to any URL, so the
 * test reads the connection's own secret and only reports ok/fail.
 */

/**
 * The fetch the live test uses. Injected so an OFFLINE test stubs the target
 * with no network, and so the test path never reaches for a global. The URL is
 * built by this service from the STORED `baseUrl` — never from the request
 * body — so a test cannot be pointed at an arbitrary host by its caller.
 *
 * ONE exception to the injection: an `openai_compat` probe whose dial skips
 * TLS verification (see `runConnectionTest`) goes through undici's own fetch,
 * because the skip can only ride on an undici dispatcher and this signature
 * has no seam for one. Such URLs are https + internal/flagged only, so the
 * offline suites (http/public fixtures) never take that path.
 */
export type ConnectorFetch = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The explicit-switch half of the TLS rule, bound to the connection STORE —
 * the answer to "did an admin flag this host's connection with
 * `skipTlsVerify`?" for a URL about to be dialled.
 *
 * `server.ts` wraps the default connector transport with it
 * (`tlsAwareFetchWith`), so every BFF-side call that reaches a managed
 * connection's server — the onboarding repo/project lists, the listening
 * seed, not just the probe — follows the same skip rule the probe and the
 * runtime drivers do. Matching is by HOSTNAME: the flag is an assertion about
 * a server, and the row's own probe URL, an API sub-path, or a differently
 * spelled port must not dodge it. Read per call (the `resolveModel` idiom) so
 * a switch flipped in the panel is live on the next request; any store
 * failure reads as "not flagged" — fail closed onto full verification.
 */
export function connectionTlsFlag(
  store: { list(): Promise<readonly ConnectionRecord[]> } | undefined,
): (url: string) => Promise<boolean> {
  return async (url) => {
    if (store === undefined) return false;
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      return false;
    }
    let rows: readonly ConnectionRecord[];
    try {
      rows = await store.list();
    } catch {
      return false;
    }
    return rows.some((row) => {
      if (!row.enabled || row.config["skipTlsVerify"] !== "true") return false;
      try {
        return new URL(row.baseUrl).hostname === host;
      } catch {
        return false;
      }
    });
  };
}

/** The last four characters of a token — the only glimpse a read is ever given. */
export function maskToken(token: string): string {
  // Fewer than four chars: mask the whole thing rather than reveal a short
  // token in full. The mask is for recognition, not verification.
  return token.length <= 4 ? "*".repeat(token.length) : token.slice(-4);
}

/**
 * The read shape: the frozen contract `Connection` PLUS the secret-free
 * `lastTestNote`. The note is a BFF/presentation field (the catalog key of the
 * last test's outcome), so it lives here as an intersection rather than an edit
 * to the frozen `Connection` schema.
 */
export type ManagedConnectionView = Connection & { readonly lastTestNote: string | null };

/** The record shape a read hands back — the store record MINUS anything secret. */
export function toConnectionView(record: ConnectionRecord): ManagedConnectionView {
  return {
    id: record.id,
    kind: record.kind,
    displayName: record.displayName,
    baseUrl: record.baseUrl,
    authKind: record.authKind,
    config: record.config,
    // `secretRef` IS returned (it is a reference, not the token) so the screen
    // can reason about which secret slot is in use; the token itself never is.
    secretRef: record.secretRef,
    secretMask: record.secretMask,
    secretSet: record.secretRef !== null,
    enabled: record.enabled,
    onPrem: record.onPrem,
    isDefault: record.isDefault,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    lastTestedAt: record.lastTestedAt,
    lastTestOk: record.lastTestOk,
    lastTestNote: record.lastTestNote,
  };
}

/**
 * Build the record to store from a validated input.
 *
 * The token is NOT part of the record — the caller enciphers it separately and
 * passes the resulting `secretRef`/`secretMask` here. Passing `null` for both
 * keeps whatever was already set (an edit that did not change the token).
 */
export function toConnectionRecord(
  id: string,
  input: ConnectionInput,
  secret: { ref: string | null; mask: string | null },
  timestamps: {
    createdAt: string;
    updatedAt: string;
    lastTestedAt: string | null;
    lastTestOk: boolean | null;
    /** Optional; a create/config-edit that never tested carries no note. */
    lastTestNote?: string | null;
  },
): ConnectionRecord {
  return {
    id,
    kind: input.kind,
    displayName: input.displayName,
    baseUrl: input.baseUrl,
    authKind: input.authKind,
    config: input.config,
    secretRef: secret.ref,
    secretMask: secret.mask,
    enabled: input.enabled,
    onPrem: input.onPrem,
    isDefault: input.isDefault,
    createdAt: timestamps.createdAt,
    updatedAt: timestamps.updatedAt,
    lastTestedAt: timestamps.lastTestedAt,
    lastTestOk: timestamps.lastTestOk,
    lastTestNote: timestamps.lastTestNote ?? null,
  };
}

/** The outcome of a live test — a boolean and a SHORT message (never the token). */
export interface TestOutcome {
  ok: boolean;
  /**
   * A catalog key describing the outcome (M104), plus params the sentence needs.
   * Never prose, and never anything derived from the token — at most the account
   * name / login the target returned, which is not a secret.
   */
  messageKey: string;
  messageParams?: Record<string, string>;
  /**
   * The authenticated account's stable id, when the probe could read one (Jira's
   * `accountId`). The caller persists it on the connection so a listening rule
   * can offer "the bot" instead of asking for a hand-copied GUID. Never a secret.
   */
  accountId?: string;
  /**
   * The friendly name the probe read for the authenticated account (Jira's
   * `/myself` `displayName`). It is the DEFAULT name for the provisioned bot
   * row, so it is carried out of the probe as data rather than only baked into
   * a message parameter. A name is not a secret; the email that sits beside it
   * in the same response never travels (see `probeFor`).
   */
  identity?: string;
  /**
   * The stored `config.botAccountId` did NOT match the account the token
   * actually belongs to, and was corrected to `accountId`. Carries the DISPLACED
   * value so the panel can name what was wrong; never an email.
   */
  accountIdCorrected?: { from: string };
  /**
   * SECRET-FREE transport diagnostics, set only when the probe's fetch threw.
   * `host` is the target's hostname alone (never the full URL, whose query
   * could carry a key); `causes` is the error's `code` chain (`ENOTFOUND`,
   * `SELF_SIGNED_CERT_IN_CHAIN`, …) — vendor constants that structurally
   * cannot quote a header or a token. The route logs this; it is deliberately
   * NOT part of the HTTP response, which speaks in catalog keys.
   */
  diagnostic?: { host: string; causes: readonly string[] };
  /**
   * The connection's real owner is NOT the account the engine acts as. Both
   * halves are internally consistent — the connection has faithfully learned
   * its own token's owner — but they are two DIFFERENT Jira identities, so a
   * listening rule built from this connection can never match a ticket the
   * engine was assigned. Carries both ids so the operator can see the split;
   * never an email. Advisory: the connection itself still works, so `ok` stays
   * true (see `engineIdentityWarning`).
   */
  engineMismatch?: { connection: string; engine: string };
}

/**
 * Does this connection act as somebody other than the engine?
 *
 * THE INVARIANT: the account a managed Jira connection authenticates as must be
 * the account the engine is assigned work as. When it is not, nothing anywhere
 * throws — and that is exactly the danger. The connection is questioned by
 * nothing, because it is telling the truth about its own token; the engine is
 * questioned by nothing, because it is telling the truth about its own env. The
 * failure appears only much later and much quieter: `/onboarding/jira-connections`
 * serves the connection's id, the setup wizard pre-fills it into a rule's
 * `assigneeAccountId`, and `flow-decision.ts` compares that to an assignee it
 * can never equal. The rule matches nothing, no error is raised, and the run
 * falls back to the deployment default — a silence that is very hard to trace
 * back from "the wizard's rule does nothing".
 *
 * So the comparison is made HERE, at the one moment an operator is looking at
 * this connection's identity on purpose, and reported as a WARNING rather than
 * a failure: a deployment may legitimately be mid-migration between the two
 * accounts, and a test that refused would block the very screen used to fix it.
 *
 * An unconfigured engine account (`""`) means there is nothing to compare, not
 * that the two disagree — an install predating the assignment-based flow must
 * never be told its connection is wrong.
 */
export function engineIdentityWarning(
  connectionAccountId: string | undefined,
  engineAccountId: string,
): { connection: string; engine: string } | undefined {
  const connection = connectionAccountId?.trim() ?? "";
  const engine = engineAccountId.trim();
  if (connection === "" || engine === "" || connection === engine) return undefined;
  return { connection, engine };
}

/** Where each kind's identity/health probe lives, relative to `baseUrl`. */
interface Probe {
  path: string;
  /** How the stored token is presented. */
  header(token: string, config: Record<string, string>): Record<string, string>;
  /** How to read a friendly identity out of a 200 body, if any. */
  identity?(body: unknown): string | undefined;
  /** How to read the authenticated account's stable id (Jira only, for now). */
  accountId?(body: unknown): string | undefined;
  /**
   * This kind's credential is OPTIONAL — a missing token is a configuration to
   * probe, not a reason to refuse. Only `openai_compat` sets it: a self-hosted
   * model server on an internal network commonly has no API key at all, and
   * `runConnectionTest` would otherwise short-circuit to `no_token` and never
   * dial an endpoint that would have answered perfectly well.
   */
  tokenOptional?: boolean;
}

/**
 * Strip a trailing `/v1` from a model server's base URL.
 *
 * THE TRAP THIS DEFUSES. `OpenAiCompatDriver` builds its request as
 * `${baseUrl}/v1/chat/completions` — it appends the version segment itself. So
 * a `baseUrl` that already ends in `/v1` produces `/v1/v1/chat/completions`,
 * and every model call 404s. Both `install.sh` scripts refuse such a value at
 * install time with exactly this explanation, which means the trap is already
 * known and already documented; what was missing was the panel honouring the
 * same rule.
 *
 * The panel NORMALISES rather than refuses, and the asymmetry with `install.sh`
 * is intended. `https://llm.local/v1` is what every vendor's own documentation
 * prints and what an operator will paste from their vLLM console — it is the
 * most likely correct intent, not a typo. An installer runs once and can afford
 * to stop and teach; a form an admin is actively filling in should accept the
 * obvious meaning and then SHOW what it stored, which is what the helper text
 * under the field does. Normalising here also keeps the probe and the eventual
 * driver call addressing the same server, so a test that goes green is evidence
 * about the URL a run will really dial.
 */
export function normalizeOpenAiBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** A stored PAT under HTTP Basic (`email:token`), base64 — Jira Cloud's scheme. */
function basicAuth(user: string, token: string): string {
  return `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}`;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function field(body: unknown, key: string): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  return asString((body as Record<string, unknown>)[key]);
}

/**
 * The probe per kind. `null` = "no live test implemented for this kind yet",
 * reported honestly rather than faked green.
 */
export function probeFor(kind: ConnectionKind): Probe | null {
  switch (kind) {
    case "jira_cloud":
      // Jira Cloud authenticates a PAT with the account email under Basic.
      return {
        path: "/rest/api/3/myself",
        header: (token, config) => ({ authorization: basicAuth(config["email"] ?? "", token) }),
        // `displayName` ONLY. `/myself` also returns `emailAddress`, and the old
        // fallback to it would have rendered the bot's email into the panel and
        // into the stored test note — the response is PII, so only the name and
        // the opaque accountId are ever allowed out of this probe.
        identity: (body) => field(body, "displayName"),
        // The bot's Jira accountId — captured so a listening rule can pre-fill it
        // instead of an operator hand-copying a 40-char GUID from a profile URL.
        accountId: (body) => field(body, "accountId"),
      };
    case "jira_dc":
      // Data Center takes the PAT as a bearer token.
      return {
        path: "/rest/api/2/myself",
        header: (token) => ({ authorization: `Bearer ${token}` }),
        identity: (body) => field(body, "displayName") ?? field(body, "name"),
        // DC identifies a user by `key`/`name`, not the Cloud accountId shape.
        accountId: (body) => field(body, "key") ?? field(body, "name"),
      };
    case "github":
      return {
        path: "/user",
        header: (token) => ({ authorization: `Bearer ${token}`, "user-agent": "maestro" }),
        identity: (body) => field(body, "login"),
      };
    case "openrouter":
    case "anthropic":
      // Both expose a models endpoint that a valid key can list.
      return {
        path: "/models",
        header: (token): Record<string, string> =>
          kind === "anthropic"
            ? { "x-api-key": token, "anthropic-version": "2023-06-01" }
            : { authorization: `Bearer ${token}` },
      };
    case "openai_compat":
      /**
       * A self-hosted, OpenAI-shaped server. `/v1/models` is the probe, and it
       * is chosen over a `chat/completions` round-trip on purpose.
       *
       * WHAT IT PROVES. That something is listening, that it speaks the OpenAI
       * protocol (a bare reverse proxy or a wrong port answers, but not with
       * this shape), that the key is accepted if one is required, and — the
       * part an operator actually needs — WHICH MODELS ARE SERVED. That last
       * fact is the one this screen exists to establish: the commonest
       * on-prem failure is not an unreachable host, it is a `LLM_MODEL` naming
       * a model this server does not load, and a probe that only checked
       * reachability would go green on exactly that deployment.
       *
       * WHY NOT A REAL COMPLETION. A `POST /v1/chat/completions` with
       * `max_tokens: 1` would prove more, and it was rejected for two reasons.
       * It needs a model id to send — which is the very thing being verified,
       * so a wrong id fails the test for a server that is fine — and on a
       * cold-loaded on-prem server the first completion can pull weights for
       * minutes, turning a panel button into a hang. `/models` answers from
       * memory and names the model, which lets an operator FIX the id instead
       * of guessing at a timeout. The model list is compared against the
       * configured id by `modelServedNote` below, so the honest verdict is
       * still reached without paying for inference.
       *
       * The token is presented as a bearer only when there is one; see
       * `tokenOptional`, and `header` below tolerating "".
       */
      return {
        path: "/v1/models",
        // An empty key means this server wants none — sending `Bearer ` with
        // nothing after it makes some servers 401 on a request that would
        // otherwise have succeeded, so the header is omitted entirely instead.
        header: (token): Record<string, string> =>
          token === "" ? {} : { authorization: `Bearer ${token}` },
        tokenOptional: true,
      };
    case "vault":
      // A token-lookup-self call is the health-and-auth probe in one.
      return {
        path: "/v1/auth/token/lookup-self",
        header: (token) => ({ "x-vault-token": token }),
      };
    case "ado":
      // Azure DevOps takes the PAT as Basic with an empty username.
      return {
        path: "/_apis/connectionData?api-version=7.1-preview",
        header: (token) => ({ authorization: basicAuth("", token) }),
        identity: (body) => {
          const authed = (body as { authenticatedUser?: { providerDisplayName?: unknown } } | null)
            ?.authenticatedUser?.providerDisplayName;
          return asString(authed);
        },
      };
    case "smtp":
    case "storage":
      // No HTTP identity probe: SMTP is a socket handshake and object storage
      // needs a signed request per provider. Honestly "not implemented yet"
      // rather than a fabricated green.
      return null;
  }
}

/**
 * The model ids an OpenAI-compatible `/v1/models` answer lists.
 *
 * The shape is `{ data: [{ id: "..." }, …] }` for vLLM, llama.cpp, Ollama's
 * compat endpoint and OpenAI itself. Anything that does not parse yields an
 * empty list rather than throwing: the endpoint answered 200 and the
 * credential was accepted, which is most of what the test set out to learn,
 * and a strict parse would turn a working server with an unusual response into
 * a red connection.
 */
export function modelIdsOf(body: unknown): string[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const ids: string[] = [];
  for (const entry of data) {
    const id = field(entry, "id");
    if (id !== undefined) ids.push(id);
  }
  return ids;
}

/**
 * The verdict on a model server, given what it serves and what was configured.
 *
 * Three outcomes, and the middle one is the reason this function exists. A
 * server that lists the configured model is unambiguously good. A server that
 * lists models but NOT the configured one is the silent failure this probe was
 * built to catch — the connection works, the credential works, and every run
 * will still fail at the first inference call because `LLM_MODEL` names
 * something this server does not load. It is reported as a FAILURE rather than
 * a warning: unlike the Jira identity split (which a mid-migration deployment
 * may legitimately be in), there is no state in which a missing model is
 * working-as-intended.
 *
 * The configured model is compared case-sensitively and exactly. Model ids are
 * opaque strings a server matches literally, so a "close enough" match here
 * would bless an id the server will later reject.
 *
 * Model ids are NOT secrets — they are the vendor's public catalogue names —
 * so naming them in the message is safe and is the whole value of the probe.
 * The list is capped at a handful because the message is rendered in a toast,
 * and an OpenAI-proxying gateway can list hundreds.
 */
export function modelServedNote(
  models: readonly string[],
  configuredModel: string | undefined,
): TestOutcome {
  const shown = models.slice(0, 5).join(", ");
  const wanted = configuredModel?.trim();

  if (wanted !== undefined && wanted !== "" && models.length > 0 && !models.includes(wanted)) {
    return {
      ok: false,
      messageKey: "connections.test.model_missing",
      messageParams: { model: wanted, models: shown, count: String(models.length) },
    };
  }
  if (models.length === 0) {
    // A 200 with no readable list. The server is up and the credential passed,
    // but nothing was learned about the model — said plainly rather than
    // rendered as a green that implies more than was checked.
    return { ok: true, messageKey: "connections.test.ok_no_models" };
  }
  return {
    ok: true,
    messageKey: "connections.test.ok_models",
    messageParams: { models: shown, count: String(models.length) },
  };
}

/**
 * How long the live test waits before calling the target gone (see the
 * `signal` in `runConnectionTest`). Exported so the tests that prove the
 * timeout classification can reason about the budget.
 */
export const PROBE_TIMEOUT_MS = 10_000;

/**
 * A thrown probe fetch, turned into the most specific honest verdict the
 * error's `code` chain supports.
 *
 * Before this existed, every network failure — a typo'd hostname, a closed
 * port, a silent firewall AND an unintroduced corporate root CA — collapsed
 * into one "Adrese ulaşılamadı", and the operator with the on-prem OpenShift
 * model server had nothing to act on. Each kind now gets its own catalog key,
 * with the TLS one carrying this deployment's real fixes (the connection's
 * "TLS doğrulamasını atla" switch, or certs/ + NODE_EXTRA_CA_CERTS — exactly
 * what the ugurdocker and banka docker-compose files already mount and pass
 * through to the bff and worker containers).
 *
 * `unreachable` survives as the LAST RESORT only: an error whose codes this
 * map does not know keeps the old honest message rather than a guess.
 */
export function probeFailure(error: unknown, url: string): TestOutcome {
  const failure = classifyNetworkFailure(error);
  const { host, port } = targetOf(url);
  // Codes + hostname only — what the route's warn log carries. Never the full
  // URL and never anything read off the error's message.
  const diagnostic = { host, causes: failure.codes };
  switch (failure.kind) {
    case "dns":
      return { ok: false, messageKey: "connections.test.dns", messageParams: { host }, diagnostic };
    case "refused":
      return { ok: false, messageKey: "connections.test.refused", messageParams: { host, port }, diagnostic };
    case "timeout":
      return { ok: false, messageKey: "connections.test.timeout", diagnostic };
    case "tls":
      return { ok: false, messageKey: "connections.test.tls", messageParams: { code: failure.code ?? "?" }, diagnostic };
    case null:
      return { ok: false, messageKey: "connections.test.unreachable", diagnostic };
  }
}

/** Hostname + effective port of the probe URL, for messages and the log. */
function targetOf(url: string): { host: string; port: string } {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname,
      port: parsed.port !== "" ? parsed.port : parsed.protocol === "https:" ? "443" : "80",
    };
  } catch {
    // The URL is built from a validated stored baseUrl, so this is unreachable
    // in practice — but a diagnostic helper must never itself throw.
    return { host: "?", port: "?" };
  }
}

/**
 * Run the live test against the STORED connection using the STORED token.
 *
 * The URL is built from `baseUrl` + the kind's probe path — never from anything
 * the caller sent — so a viewer cannot turn the test into an SSRF or an
 * exfiltration channel. A missing token, a non-2xx, a probe that does not exist
 * for this kind, and a thrown fetch are distinct honest outcomes — and the
 * thrown fetch itself fans out by cause (`probeFailure`: DNS, refused,
 * timeout, TLS, or the unreachable last resort); none of them is reported as
 * ok, and none of them puts the token in the message.
 */
export async function runConnectionTest(
  record: ConnectionRecord,
  token: string | null,
  fetchImpl: ConnectorFetch,
  /**
   * The account the ENGINE acts as (`config.engineBotAccountId`), for the
   * identity-split warning. Defaults to "" — "not configured", which skips the
   * check — so every existing caller and test keeps its current behaviour.
   */
  engineAccountId = "",
): Promise<TestOutcome> {
  const probe = probeFor(record.kind);
  if (probe === null) {
    return { ok: false, messageKey: "connections.test.not_implemented", messageParams: { kind: record.kind } };
  }
  // A kind whose credential is optional treats "no token stored" as "this
  // server wants none" and probes anyway; every other kind still refuses, since
  // dialling a cloud vendor with no credential can only ever produce a 401.
  if (token === null && probe.tokenOptional !== true) {
    return { ok: false, messageKey: "connections.test.no_token" };
  }
  const presented = token ?? "";

  // `openai_compat` carries the version segment in its probe path (`/v1/models`)
  // because the DRIVER appends `/v1` too — so the stored base must be trimmed of
  // one if the operator pasted it. Every other kind's `baseUrl` is used as-is.
  const base =
    record.kind === "openai_compat"
      ? normalizeOpenAiBaseUrl(record.baseUrl)
      : record.baseUrl.replace(/\/+$/, "");
  const url = `${base}${probe.path}`;
  /**
   * TLS skip, for EVERY kind, under the same rule the runtime transports
   * apply (wendoc's test=run symmetry): the row's explicit
   * `config.skipTlsVerify` switch, or an address that is demonstrably internal
   * (loopback/RFC1918/`.local`, https only — see `tls.ts` for the trade-off).
   * All kinds, because the corporate-certificate wall is not a model-server
   * specialty — a bank's Azure DevOps Server and Jira DC sit behind the same
   * CA — and the runtime side follows the same rule end to end: the LLM
   * driver through `postJson`, the ado/jira/github adapters through the
   * `tlsAwareFetchWith` transport their composition root injects. The
   * insecure dial must go through undici's own fetch, because the injected
   * `fetchImpl` has no seam a dispatcher could ride through.
   */
  const dial = shouldSkipTlsVerify(url, record.config["skipTlsVerify"] === "true")
    ? insecureFetch
    : fetchImpl;
  let response: Response;
  try {
    response = await dial(url, {
      method: "GET",
      headers: { accept: "application/json", ...probe.header(presented, record.config) },
      // Bounded on purpose. The bare `fetch` this runs on has no timeout of its
      // own, so a host that ACCEPTS and then never answers (a firewall that
      // swallows, a wrong port that happens to listen) used to hang the panel's
      // Test button until undici's multi-minute default gave up. Ten seconds is
      // generous for `/v1/models` — it answers from memory, never pulls weights
      // — and the abort classifies as `timeout` below rather than a hang.
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
  } catch (error) {
    // The error's MESSAGE is still never surfaced — it can carry the URL and,
    // on some runtimes, request headers, which is where the token is. But its
    // `code` chain is walked (`classifyNetworkFailure`): codes are vendor
    // constants that cannot quote a secret, and they are the difference
    // between "unreachable" and the four distinct repairs an operator can
    // actually perform (fix DNS, open the port, widen the firewall, introduce
    // the corporate root CA).
    return probeFailure(error, url);
  }

  if (response.status < 200 || response.status >= 300) {
    return {
      ok: false,
      messageKey: "connections.test.http_error",
      messageParams: { status: String(response.status) },
    };
  }

  // A model server's answer IS the verdict, so it is read here and returned
  // directly rather than falling through to the Jira identity machinery below
  // — none of which applies to a thing that has no `/myself` and no bot.
  if (record.kind === "openai_compat") {
    let models: string[];
    try {
      models = modelIdsOf(await response.json());
    } catch {
      // 200 with a body that is not JSON. Still a reachable, authenticated
      // endpoint; simply nothing learned about the models.
      models = [];
    }
    return modelServedNote(models, record.config["model"]);
  }

  /**
   * A green key is not a green BALANCE.
   *
   * Measured live: an OpenRouter key whose credit had run out listed `/models`
   * happily — the panel went green — and then every chat call came back 403
   * "Key limit exceeded". The run reached step 2 and stopped, with a connection
   * screen insisting the connection was fine. On an air-gapped bank install
   * that gap is worse, because nobody can check the provider's dashboard.
   *
   * The probe is not changed to a real completion (see the reasoning above
   * `/v1/models`); the VERDICT is made honest instead, so the operator knows
   * what this green does and does not cover.
   */
  if (record.kind === "openrouter" || record.kind === "anthropic") {
    return { ok: true, messageKey: "connections.test.key_ok_quota_unknown" };
  }

  let identity: string | undefined;
  let accountId: string | undefined;
  if (probe.identity !== undefined || probe.accountId !== undefined) {
    try {
      const body = await response.json();
      identity = probe.identity?.(body);
      accountId = probe.accountId?.(body);
    } catch {
      identity = undefined;
      accountId = undefined;
    }
  }

  // The identity check. `accountId` is who the TOKEN belongs to, straight from
  // the live `/myself` answer; `config.botAccountId` is what an operator typed.
  // When they disagree the stored value is wrong by definition — a token cannot
  // act as an account it does not belong to — so the test says so out loud
  // instead of returning a bare green that hides a misattribution.
  const claimed = record.config["botAccountId"]?.trim();

  // The engine-split check, layered on top and deliberately ORTHOGONAL to the
  // one above. That one asks "does the stored field match this token?"; this one
  // asks "is this token even the account the engine works as?". Both can be true
  // at once, and the second survives the first being clean — a connection whose
  // stored id is perfectly consistent with its own token is precisely the case
  // that fooled everyone, because there is nothing self-contradictory to find.
  // It is measured against the LIVE `accountId`, never the stored value: the
  // question is who this credential really is, not who it was labelled as.
  const engineMismatch = engineIdentityWarning(accountId, engineAccountId);
  const warn = engineMismatch === undefined ? {} : { engineMismatch };

  if (accountId !== undefined && claimed !== undefined && claimed !== "" && claimed !== accountId) {
    return {
      ok: true,
      messageKey: "connections.test.ok_bot_fixed",
      // Both ids, never an email: the operator needs to SEE which value was
      // replaced, or a silent correction looks like nothing happened.
      messageParams: { was: claimed, now: accountId, ...(identity === undefined ? {} : { who: identity }) },
      accountId,
      ...(identity === undefined ? {} : { identity }),
      accountIdCorrected: { from: claimed },
      ...warn,
    };
  }

  // A split identity REPLACES the plain success message. `ok` stays true — the
  // credential genuinely works — but the operator must not be shown a bare green
  // over a connection whose rules are guaranteed to match nothing.
  if (engineMismatch !== undefined) {
    return {
      ok: true,
      messageKey: "connections.test.ok_engine_mismatch",
      // Account ids and, at most, the display name the probe returned — the same
      // PII rule as every other outcome here: never the `/myself` email.
      messageParams: {
        connection: engineMismatch.connection,
        engine: engineMismatch.engine,
        ...(identity === undefined ? {} : { who: identity }),
      },
      accountId,
      ...(identity === undefined ? {} : { identity }),
      ...warn,
    };
  }

  return identity === undefined
    ? { ok: true, messageKey: "connections.test.ok", accountId }
    : {
        ok: true,
        messageKey: "connections.test.ok_as",
        messageParams: { who: identity },
        accountId,
        // The name the panel should show for the provisioned bot row, when the
        // operator did not supply one. Carried out of the probe here because
        // this is the only place the live `/myself` body is read.
        identity,
      };
}

// ── the bot's Maestro account (provisioning) ─────────────────────────────────

/**
 * The Jira bot needs a Maestro USER ROW, and nothing used to create one.
 *
 * The connection knows the bot's Jira identity — `runConnectionTest` already
 * probes `/rest/api/3/myself` and already writes the answer back onto
 * `config.botAccountId`. But knowing the account is not the same as HAVING one:
 * every surface that resolves an actor goes through `UserDirectory.find`, so a
 * bot with no row is an actor the platform cannot name. On the pilot deployment
 * the row was created BY HAND; on any other install it simply does not exist,
 * and the absence is silent — exactly the class of failure this file already
 * fights elsewhere (see `engineIdentityWarning`).
 *
 * So provisioning rides the mechanism that already learns the identity, rather
 * than becoming a second, competing source of truth about who the bot is.
 */

/**
 * The username (and hence directory key) for a connection's bot account.
 *
 * Derived from the CONNECTION ID, not from the Jira accountId: the account id is
 * a 128-char opaque GUID that would make an unreadable local part, and it
 * CHANGES when an operator re-points the connection at a different bot — which
 * would strand the old row and silently mint a second one. The connection id is
 * stable, already URL-safe by its contract grammar, and unique per connection,
 * so re-testing the same connection always lands on the same row.
 */
export function botUsernameFor(connectionId: string): string {
  return `jira-bot-${connectionId}`;
}

/**
 * The groups a provisioned bot is given: NONE.
 *
 * This is the deliberate part, and it is a reversal of what the pilot did by
 * hand. The hand-made row sat in `maestro-admins`, and that group is not just a
 * label: `ROLE_BY_GROUP` maps it to the `admin` role, and
 * `platform/master-approver.ts` + `workflows/src/impl/gate.ts` both read
 * membership of it as the ONE self-approval exemption in the system. A bot in
 * that group can therefore satisfy four-eyes on its own — an automated account
 * that approves its own work is precisely the finding a bank audit exists to
 * raise, and M32 says approval is a human-only channel.
 *
 * What does the bot actually need? Nothing that a group grants. Trace the flow:
 * it acts on Jira through the connection's stored TOKEN (Jira's own permissions
 * govern that, not Maestro's), and it reaches the platform through the webhook
 * and the engine, neither of which authorises by directory membership. It never
 * holds a Maestro session, so `hasRole` and `canDecideGate` are never asked
 * about it. The row exists so an ACTOR RESOLVES — so the audit trail, the run
 * list and "Kullanıcılar & roller" can put a readable name to the thing that
 * did the work — and resolution needs a row, not a privilege.
 *
 * An empty group list still yields `viewer` through `rolesOf` (the floor, read
 * only), which is the correct authority for an account whose whole job is to be
 * NAMED. If a future flow genuinely needs the bot to hold a role, that should be
 * an explicit, argued change to this constant — which is why the test asserts
 * this exact set rather than merely "not admin".
 */
export const BOT_GROUPS: readonly string[] = [];

/** What a caller must hand `ensureBotUser` — the identity the live probe read. */
export interface BotIdentity {
  /** The bot's Jira `accountId`, from `/myself`. Never invented. */
  accountId: string;
  /** Jira's own `displayName` for the bot — the default when nothing is supplied. */
  jiraDisplayName?: string;
  /** The operator's chosen name from the connection form, when they gave one. */
  operatorDisplayName?: string;
}

/**
 * The name the row carries, in priority order: what the operator typed, then
 * what Jira calls the account, and only then the username as a last resort.
 *
 * The fallback chain never produces an empty string — a blank heading in the
 * users table would read as a broken row rather than an unnamed one.
 */
export function botDisplayName(identity: BotIdentity, username: string): string {
  const operator = identity.operatorDisplayName?.trim();
  if (operator !== undefined && operator !== "") return operator;
  const jira = identity.jiraDisplayName?.trim();
  if (jira !== undefined && jira !== "") return jira;
  return username;
}

/**
 * What `ensureBotUser` did, so the caller can audit it honestly rather than
 * logging "provisioned" over a row it did not touch.
 */
export interface BotProvisionOutcome {
  username: string;
  /** True only when a row was CREATED; false when an existing one was left in place. */
  created: boolean;
  /** The display name now on the row (updated even for an existing account). */
  displayName: string;
}

/**
 * Create the bot's account if it is absent; if it is present, touch only what is
 * safe to touch.
 *
 * THE RULE ON AN EXISTING ROW. An operator may have adjusted this account after
 * it was provisioned — put it in a group deliberately, or deactivated it while
 * investigating something. Re-testing a connection must not undo either. So:
 *
 *  · `groups`/`roles` — NEVER written on an existing row. Whatever authority the
 *    operator granted or removed stands. (This is also why a bot that somebody
 *    already put in `maestro-admins` is not silently demoted here: taking away
 *    an approval right behind an operator's back is as bad as granting one.
 *    The provisioner refuses to be the thing that decides it either way.)
 *  · `active` — NEVER written. A deactivated bot stays deactivated; a test is
 *    not a re-enablement.
 *  · `passwordHash` — NEVER touched. The bot has no interactive login at all;
 *    the row is minted with an unusable hash and that value is preserved.
 *  · `displayName` — DOES get updated. It is pure presentation, it carries no
 *    authority, and it is the one field the operator is explicitly being asked
 *    for on the connection form. A rename that did not take effect would make
 *    the form look broken.
 *
 * Returns `null` when there is nothing to provision — no account id means the
 * probe did not identify anybody, and a row invented without a real identity
 * behind it is worse than no row.
 */
export async function ensureBotUser(
  users: UserDirectory,
  connectionId: string,
  identity: BotIdentity,
  /** `user@corp` for the row's audit actor — built by the caller from `actorDomain`. */
  userId: string,
): Promise<BotProvisionOutcome | null> {
  if (identity.accountId.trim() === "") return null;

  const username = botUsernameFor(connectionId);
  const displayName = botDisplayName(identity, username);
  const existing = await users.find(username);

  if (existing !== null) {
    // Present: only the name may move. Spreading `existing` first is what makes
    // that a guarantee rather than an intention — every other field is carried
    // through verbatim, including any group an operator added by hand.
    if (existing.displayName === displayName) {
      return { username, created: false, displayName };
    }
    await users.upsert({ ...existing, displayName });
    return { username, created: false, displayName };
  }

  const record: UserRecord = {
    username,
    userId,
    // A hash no password can ever produce. bcrypt output is always `$2…` and
    // exactly 60 chars, so this string cannot be the hash of anything a login
    // could supply — the account is unlogin-able by construction rather than by
    // a flag somebody could flip. `LocalIdentityProvider.authenticate` will run
    // its verify against it and fail, which is the intended and only outcome.
    passwordHash: "!bot-no-login",
    groups: [...BOT_GROUPS],
    // Derived the same way every other account's are; with no groups this is the
    // `viewer` floor. Written explicitly rather than left empty so a directory
    // that reads roles off the row (the in-memory one does) agrees with the
    // Prisma one, which re-derives them from groups on every read.
    roles: ["viewer"],
    active: true,
    displayName,
    // Never a bootstrap account: there is no password to change.
    mustChangePassword: false,
  };
  await users.upsert(record);
  return { username, created: true, displayName };
}
