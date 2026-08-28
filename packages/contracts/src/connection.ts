import { z } from "zod";
import { IsoDateTime, NonEmpty } from "./common.js";

/**
 * A managed outbound connection (the connector-management surface).
 *
 * This is the EDITABLE counterpart to the settings screen's read-only
 * `ConnectionView` (deployment facts read from the environment). A `Connection`
 * is a row an admin creates from Studio: a URL, an auth kind, some non-secret
 * config, and a REFERENCE (`secretRef`) to an AES-encrypted token held in the
 * secret store. The raw token is NEVER part of this shape — not on the way in,
 * not on the way out. What travels instead is `secretMask` (last four chars,
 * for recognition) and `secretSet` (whether a token exists at all). A console
 * that could display a PAT is a console that could leak it into a screenshot
 * (M9), and the same rule that keeps the read-only view free of secrets keeps
 * this one free of them too.
 */

/** What this connection speaks to — the probe and the auth path both key off it. */
export const ConnectionKind = z.enum([
  "jira_cloud",
  "jira_dc",
  "github",
  "ado",
  "openrouter",
  "anthropic",
  /**
   * A SELF-HOSTED, OpenAI-shaped model server — vLLM, llama.cpp, Ollama, LM
   * Studio, anything serving `/v1/chat/completions`. It is a separate kind from
   * `openrouter`/`anthropic` rather than a flag on them, and that is the whole
   * point: the kind is what the rest of the platform discriminates on.
   * `CONNECTION_KIND_FOR_REF` decides which connection may serve
   * `kv/llm#api-key` by KIND, and `probeFor` picks an auth scheme by KIND — an
   * on-prem server that presented itself as `openrouter` would be probed with
   * OpenRouter's assumptions and would have no way to say "my API key is
   * optional", which is the one thing that is actually different about it.
   */
  "openai_compat",
  "vault",
  "smtp",
  "storage",
]);
export type ConnectionKind = z.infer<typeof ConnectionKind>;

/**
 * How the stored token is presented to the target on a live test.
 * `basic` → Basic auth (email:token), `bearer` → `Authorization: Bearer`,
 * `pat` → a personal-access header the kind decides, `api_key` → a key header.
 */
export const ConnectionAuthKind = z.enum(["basic", "bearer", "pat", "api_key"]);
export type ConnectionAuthKind = z.infer<typeof ConnectionAuthKind>;

/**
 * The connection id grammar — lower-case, dash-separated, e.g. `jira`,
 * `llm-openrouter`. Same shape the DB column stores; it doubles as the URL path
 * segment on `/studio/connections/:id`, so it must be URL-safe with no slashes.
 */
export const ConnectionId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
export type ConnectionId = z.infer<typeof ConnectionId>;

/**
 * Non-secret configuration a connection needs beyond its URL — the Jira account
 * email, a GitHub owner/repo, a project key. Free-form by design (each kind
 * needs different fields), but bounded: string values only, so a token can
 * never be smuggled in here as "config" and then read back out. The keys and
 * values are size-capped so the JSON column stays a config bag, not a payload.
 */
export const ConnectionConfig = z.record(
  z.string().min(1).max(64),
  z.string().max(1024),
);
export type ConnectionConfig = z.infer<typeof ConnectionConfig>;

/**
 * A connection as READ back — never carries the token, only its mask and a flag.
 *
 * `secretMask` is the last four characters of the stored token (or `null` when
 * none is set); it exists so an operator can recognise WHICH credential is
 * stored without the platform ever handing back the credential itself.
 * `lastTestOk` is a tri-state on purpose: `null` = never tested, `true`/`false`
 * = the last live test's honest verdict. A screen must be able to tell "not yet
 * checked" from "checked and broken".
 */
export const Connection = z.object({
  id: ConnectionId,
  kind: ConnectionKind,
  displayName: NonEmpty.max(120),
  baseUrl: z.string().url().max(2048),
  authKind: ConnectionAuthKind,
  config: ConnectionConfig.default({}),
  /** Reference into the secret store — NEVER the token. Absent until one is set. */
  secretRef: NonEmpty.max(256).nullable().default(null),
  /** Last four chars of the stored token, or null. The only glimpse a read gets. */
  secretMask: z.string().max(4).nullable().default(null),
  /** Whether a token is stored at all — drives the "set / not set" affordance. */
  secretSet: z.boolean().default(false),
  enabled: z.boolean().default(true),
  /**
   * Whether this endpoint runs INSIDE the institution (M18).
   *
   * FLAGGED EXCEPTION to the frozen contract, and the second half of the one
   * `openai_compat` already took. The M18 confidential rule needs a per-ROW
   * answer, because an install may hold both an internal server and a cloud
   * vendor and `gizli` must be able to tell them apart. It cannot be inferred
   * from the URL: a private address is evidence about routing, not a claim
   * about custody — a private IP can be a tunnel out, a public hostname can
   * resolve to the basement. So it is something an operator ASSERTS and an
   * auditor reads, and it defaults false so an unanswered question fails closed.
   */
  onPrem: z.boolean().default(false),
  /**
   * Whether this is the model the install dials when a run names none.
   *
   * At most one row may hold it, enforced by a partial unique index rather than
   * by this schema: two enabled rows both claiming it would leave the answering
   * model to row order, which is not something a bank can audit.
   */
  isDefault: z.boolean().default(false),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  lastTestedAt: IsoDateTime.nullable().default(null),
  /** null = never tested; true/false = the last live test's real result. */
  lastTestOk: z.boolean().nullable().default(null),
});
export type Connection = z.infer<typeof Connection>;

/**
 * A create/update payload — what Studio SENDS.
 *
 * `token` is the one place a raw secret appears, and it appears only inbound:
 * it is write-only, optional (a config-only edit omits it), and never echoed
 * back. Absent means "leave the stored token as it is"; present means "encrypt
 * this and replace the reference". The read side (`Connection`) has no `token`
 * field at all, which is what makes "a GET can never return the secret" a
 * property of the type rather than of a careful handler.
 */
export const ConnectionInput = z.object({
  kind: ConnectionKind,
  displayName: NonEmpty.max(120),
  baseUrl: z.string().url().max(2048),
  authKind: ConnectionAuthKind,
  config: ConnectionConfig.default({}),
  enabled: z.boolean().default(true),
  /** See `Connection.onPrem` — the operator's assertion about where this runs. */
  onPrem: z.boolean().default(false),
  /** See `Connection.isDefault` — which model answers when a run names none. */
  isDefault: z.boolean().default(false),
  /**
   * Write-only. Present = set/replace the token; absent = keep the existing one.
   *
   * The minimum length is ZERO, and that is a deliberate widening for
   * `openai_compat`. A self-hosted model server on an internal network very
   * often has no authentication at all — vLLM without `--api-key`, a default
   * llama.cpp or Ollama — so "" is a real credential state an operator must be
   * able to express, not a mistake to reject. The distinction the whole shape
   * rests on is therefore between ABSENT (`undefined` — leave whatever is
   * stored alone) and PRESENT-BUT-EMPTY (`""` — this server wants no key), and
   * those are two different instructions that must not collapse into one.
   * Cloud kinds are not weakened by this: an empty key against OpenRouter or
   * Jira simply fails its live test, which is the honest outcome and a better
   * teacher than a form-level refusal.
   */
  token: z.string().max(4096).optional(),
});
export type ConnectionInput = z.infer<typeof ConnectionInput>;

/**
 * What a connection of each KIND actually needs — one table, read by everything.
 *
 * The kind list had grown four copies (this enum, Studio's `KINDS` array,
 * `ManagedConnectionKind`, and `probeFor`'s switch), and the form rendered the
 * same three boxes for all ten. Two real failures came out of that:
 *
 *  · **Jira Cloud could not be configured from Studio at all.** Its probe
 *    builds Basic auth from `config.email` (`connection-service.ts`), and the
 *    form had no field for it — every new row sent `basicAuth("", token)` and
 *    got a 401 that pointed at the token.
 *  · **`authKind` was a control that did nothing.** The operator picked one of
 *    four values; `probeFor` hardcodes the scheme per kind and never read it.
 *    A picker that cannot change the outcome is worse than no picker.
 *
 * So the kind decides, and it says so here: which family it belongs to (the
 * grouping the screen shows), the auth scheme it really uses, an example URL,
 * and the non-secret fields it needs — each with the label key and hint key the
 * form renders. `probeless` marks the kinds that have no live test yet, so the
 * screen can say so instead of offering a button whose only outcome is red.
 */
export const ConnectionFamily = z.enum(["issue_tracker", "scm", "model", "infra"]);
export type ConnectionFamily = z.infer<typeof ConnectionFamily>;

/** One non-secret config field a kind needs, as the form should render it. */
export interface ConnectionFieldSpec {
  /** The `config` key this writes — the same key the probe reads. */
  readonly key: string;
  /** Message-catalog key for the label (`connections.cfg.<key>`). */
  readonly labelKey: string;
  /** Message-catalog key for the hint under the box; absent = no hint. */
  readonly hintKey?: string;
  /** A refusal, not a warning: the kind cannot work without it. */
  readonly required: boolean;
  /** Shown greyed inside the empty box. Never a real value. */
  readonly placeholder?: string;
}

export interface ConnectionKindSpec {
  readonly family: ConnectionFamily;
  /**
   * The scheme the probe genuinely uses. Carried so the form can SHOW it
   * (read-only) rather than ask for it — see the note above.
   */
  readonly authKind: ConnectionAuthKind;
  /** A real, typeable example of this kind's base URL. */
  readonly urlExample: string;
  readonly fields: readonly ConnectionFieldSpec[];
  /** True when no live probe exists yet, so the screen must not promise one. */
  readonly probeless?: boolean;
  /** True for the kinds that can serve as the active model (M18 routing). */
  readonly model?: boolean;
}

export const CONNECTION_KIND_SPECS: Readonly<Record<ConnectionKind, ConnectionKindSpec>> = {
  jira_cloud: {
    family: "issue_tracker",
    authKind: "basic",
    urlExample: "https://sirket.atlassian.net",
    fields: [
      {
        key: "email",
        labelKey: "connections.cfg.email",
        hintKey: "connections.cfg.email_hint",
        required: true,
        placeholder: "bot@sirket.com",
      },
    ],
  },
  jira_dc: {
    family: "issue_tracker",
    authKind: "bearer",
    urlExample: "https://jira.sirket.local",
    fields: [],
  },
  github: {
    family: "scm",
    authKind: "bearer",
    urlExample: "https://api.github.com",
    fields: [],
  },
  ado: {
    family: "scm",
    authKind: "basic",
    urlExample: "https://dev.azure.com/sirket",
    fields: [],
  },
  openrouter: {
    family: "model",
    authKind: "bearer",
    urlExample: "https://openrouter.ai/api/v1",
    model: true,
    fields: [
      {
        key: "model",
        labelKey: "connections.cfg.model",
        hintKey: "connections.cfg.model_hint",
        /**
         * Optional, deliberately. The model id is what a RUN asks for, not what
         * the connection test needs: `probeFor` lists `/models` with the token
         * alone. Requiring it here would refuse a perfectly good credential
         * because its owner had not yet decided which model to run — and would
         * break every stored connection that was created before this field
         * existed. The resolver refuses an unnamed model at use time, where the
         * operator can see which run wanted it.
         */
        required: false,
        placeholder: "openai/gpt-4o-mini",
      },
    ],
  },
  anthropic: {
    family: "model",
    authKind: "api_key",
    urlExample: "https://api.anthropic.com/v1",
    model: true,
    fields: [
      {
        key: "model",
        labelKey: "connections.cfg.model",
        hintKey: "connections.cfg.model_hint",
        /**
         * Optional, deliberately. The model id is what a RUN asks for, not what
         * the connection test needs: `probeFor` lists `/models` with the token
         * alone. Requiring it here would refuse a perfectly good credential
         * because its owner had not yet decided which model to run — and would
         * break every stored connection that was created before this field
         * existed. The resolver refuses an unnamed model at use time, where the
         * operator can see which run wanted it.
         */
        required: false,
        placeholder: "claude-sonnet-4-5",
      },
    ],
  },
  openai_compat: {
    family: "model",
    authKind: "bearer",
    urlExample: "http://10.0.0.5:8000/v1",
    model: true,
    fields: [
      {
        key: "model",
        labelKey: "connections.cfg.model",
        hintKey: "connections.cfg.model_hint",
        /**
         * Optional, deliberately. The model id is what a RUN asks for, not what
         * the connection test needs: `probeFor` lists `/models` with the token
         * alone. Requiring it here would refuse a perfectly good credential
         * because its owner had not yet decided which model to run — and would
         * break every stored connection that was created before this field
         * existed. The resolver refuses an unnamed model at use time, where the
         * operator can see which run wanted it.
         */
        required: false,
        placeholder: "Qwen/Qwen2.5-32B-Instruct",
      },
    ],
  },
  vault: {
    family: "infra",
    authKind: "pat",
    urlExample: "https://vault.sirket.local:8200",
    fields: [],
  },
  smtp: {
    family: "infra",
    authKind: "basic",
    urlExample: "smtp://posta.sirket.local:587",
    probeless: true,
    fields: [
      {
        key: "from",
        labelKey: "connections.cfg.from",
        hintKey: "connections.cfg.from_hint",
        required: true,
        placeholder: "maestro@sirket.com",
      },
    ],
  },
  storage: {
    family: "infra",
    authKind: "api_key",
    urlExample: "https://s3.sirket.local",
    probeless: true,
    fields: [
      {
        key: "bucket",
        labelKey: "connections.cfg.bucket",
        required: true,
        placeholder: "maestro-belgeler",
      },
      { key: "region", labelKey: "connections.cfg.region", required: false, placeholder: "tr-1" },
    ],
  },
};

/** The kinds in one family, in the order the screen should list them. */
export function kindsInFamily(family: ConnectionFamily): readonly ConnectionKind[] {
  return ConnectionKind.options.filter((k) => CONNECTION_KIND_SPECS[k].family === family);
}

/**
 * Which required config fields a connection is missing.
 *
 * Empty means "this row can work". The BFF refuses on a non-empty result and
 * the form marks the boxes — one rule, so a connection cannot be saved from
 * Studio in a state the probe is guaranteed to fail on.
 */
export function missingConfigKeys(
  kind: ConnectionKind,
  config: ConnectionConfig,
): readonly string[] {
  return CONNECTION_KIND_SPECS[kind].fields
    .filter((f) => f.required && (config[f.key] ?? "").trim() === "")
    .map((f) => f.key);
}
