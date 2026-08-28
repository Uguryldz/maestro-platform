/**
 * The value rules the settings screen's connection rows are built from.
 *
 * Split out of `settings-env.ts` because these three are the parts with a
 * decision inside them — which of two variable names wins, what a DSN may show,
 * how a model id reaches a screen — and each one deserves a test that names the
 * failure it prevents rather than a test of the whole reader.
 */

/**
 * The LLM wiring, which lives in `apps/deploy`'s schema rather than in
 * `@maestro/config`'s.
 *
 * Passed to the reader instead of read off `Env` on purpose: `LLM_BASE_URL`,
 * `LLM_MODEL` and `LLM_API_KEY_REF` are declared by `DeployEnvSchema`, and
 * `secret-names.test.ts` derives the `MAESTRO_SECRET_*` variable names from
 * that file's `*_REF` defaults. Restating them in the base schema would give
 * the platform two schemas for one variable, and the day their defaults
 * diverged the settings screen would report an endpoint nothing dials.
 */
export interface LlmWiring {
  /** `LLM_BASE_URL` — where inference is dialled. */
  readonly baseUrl: string | undefined;
  /** `LLM_MODEL` — WHICH model answers, which is half the question. */
  readonly model: string | undefined;
  /** `LLM_API_KEY_REF` — a SecretPort key, never the key itself. */
  readonly apiKeyRef: string | undefined;
}

/**
 * The first of several variable names that is actually set.
 *
 * Blank counts as absent, not as configured: Docker Compose interpolates an
 * unset variable to an EMPTY STRING, so `JIRA_CLOUD_BASE_URL=""` reaches the
 * process as a present-but-empty value. Treating that as "set" would pick the
 * empty name over the populated fallback and report a working connection as
 * unconfigured.
 */
export function firstConfigured(...candidates: readonly (string | undefined)[]): string | undefined {
  for (const candidate of candidates) {
    if (candidate !== undefined && candidate.trim() !== "") return candidate;
  }
  return undefined;
}

/**
 * A connection string with its credentials removed.
 *
 * A DSN is `scheme://user:password@host:port/db`, and the whole point of
 * showing it is the HOST — which database this platform is pointed at. The
 * password is not part of that answer and must never be, because this string
 * is rendered in a browser, screenshotted into tickets and shipped to whatever
 * log aggregator sits behind them. So the userinfo is rewritten rather than
 * filtered: the user survives (it names the role, and an operator needs it),
 * the secret becomes `***`.
 *
 * Parsing is structural, via `URL`, and not a regular expression over the text.
 * A password may legally contain `@`, `/` and `:`, and a regex written against
 * the happy path silently passes the tail of such a password through. Anything
 * `URL` refuses to parse is withheld ENTIRELY rather than shown as-is: a value
 * whose shape we cannot establish is the last one to display on a guess.
 */
export function maskEndpointCredentials(dsn: string | undefined): string | undefined {
  if (dsn === undefined || dsn.trim() === "") return undefined;
  let url: URL;
  try {
    url = new URL(dsn);
  } catch {
    return "(set; unreadable form withheld)";
  }
  if (url.password === "") return dsn;
  url.password = "***";
  return url.toString();
}

/**
 * The LLM row's endpoint: where inference is dialled AND which model answers.
 *
 * Both facts in one field because `ConnectionView` has one, and the base URL
 * alone does not answer the question being asked. An OpenRouter or a vLLM
 * endpoint serves dozens of models, and "which model reviewed this bank's
 * change request" is an audit question rather than a curiosity.
 *
 * Undefined when there is no base URL, so the row reports `unconfigured`: a
 * model name with nowhere to send it is not a configured connection. The model
 * id is a non-secret deployment fact (`anthropic/claude-sonnet-4.5`), never the
 * key that reaches it.
 */
export function llmEndpoint(llm: LlmWiring): string | undefined {
  const baseUrl = firstConfigured(llm.baseUrl);
  if (baseUrl === undefined) return undefined;
  const model = firstConfigured(llm.model);
  return model === undefined ? baseUrl : `${baseUrl} (${model})`;
}
