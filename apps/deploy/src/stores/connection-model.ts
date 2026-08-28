import type { ResolvedModel } from "@maestro/llm-gateway";

/**
 * The model the panel says this install should dial, read fresh on every call.
 *
 * THE OTHER HALF OF `connection-secrets.ts`. That file closed the gap for the
 * model's API KEY: an admin typed one into "Ayarlar & bağlantılar", and until it
 * existed the runs kept authenticating with `MAESTRO_SECRET_KV_LLM__API__2D_KEY`
 * from `.env` instead. This file closes the same gap for the three facts that
 * decide WHICH MODEL ANSWERS — the address, the model id, and whether the server
 * is inside the building.
 *
 * The panel has collected all three since the `openai_compat` kind was added.
 * `ConnectorsPanel` renders an address field, a model-name field and an optional
 * key; `runConnectionTest` dials `/v1/models` and refuses to go green when the
 * server does not serve the named model. All of that was already true and none
 * of it reached a run, because `llmConfig` read `LLM_BASE_URL`/`LLM_MODEL`
 * synchronously while composing the port. The screen said so in its own helper
 * text. This is what that text was apologising for.
 *
 * ── WHY A THUNK AND NOT A REBUILT PORT ──────────────────────────────────────
 * Same reasoning, deliberately, as the credential seam next door. Every adapter
 * resolves its token through a function invoked per request rather than a value
 * captured at boot, which is exactly why a token rotated in the panel takes
 * effect on the next call with no restart. The endpoint and the model id are
 * facts of the same kind, so they get the same treatment: `buildPortSelection`
 * stays synchronous, the registry and the frozen `packages/ports` contract stay
 * untouched, and no boot sequence learns to await a database. The alternative —
 * an async, rebuildable composition root — is the boot-time rewiring that was
 * judged too risky twice before, and it is still not performed here.
 *
 * ── NO CACHE, ON PURPOSE ────────────────────────────────────────────────────
 * Every resolution re-reads the rows. A model changed in the panel is therefore
 * live on the next call, and the alternative is the exact class of bug this
 * whole seam exists to end: an operator fixes a setting, sees nothing change,
 * and cannot tell whether they fixed the wrong thing or the platform simply did
 * not notice. It is one query on a table with a handful of rows, on a path that
 * is already about to make a network call to an inference server.
 */

/** What this resolver needs of a connection row. Structural, like every store here. */
export interface ConnectionModelRow {
  id: string;
  kind: string;
  baseUrl: string;
  secretRef: string | null;
  enabled: boolean;
  onPrem: boolean;
  isDefault: boolean;
  configJson: unknown;
}

/** The `PrismaClient.connection` methods this resolver uses — read-only. */
export interface ConnectionModelDelegate {
  findMany(args: { orderBy: { id: "asc" } }): Promise<ConnectionModelRow[]>;
}

/**
 * Connection kinds that name an inference endpoint.
 *
 * The same three the credential table already maps to `kv/llm#api-key`, and for
 * the same reason: all three speak the OpenAI protocol on the wire, which is
 * the only protocol the `openai-compat` transport can carry. A kind absent from
 * this list has no authority over which model a run dials, which is what stops
 * a future connector kind from silently becoming the platform's model.
 */
export const MODEL_CONNECTION_KINDS: readonly string[] = ["openai_compat", "openrouter", "anthropic"];

/**
 * The ENV FALLBACK's SecretPort reference — and that is the only thing it is.
 *
 * A resolved panel row carries its OWN slot instead (`row.secretRef`, the
 * `connector:<id>:<rand>` reference the panel's `storeToken` wrote), so the
 * endpoint, the model id, the on-prem flag AND the key are all facts of the
 * same row. This shared reference appears in exactly two situations: the
 * static `.env` configuration, which has no row to carry a slot, and a row
 * whose operator never stored a token (`secretRef` null) — the honest "the
 * key still lives wherever the deployment keeps it" case.
 *
 * It USED to be the reference every resolved row named, with
 * `ConnectionSecretPort` scanning the connection table to answer it. Since
 * migration 0021 an install may hold SEVERAL model rows, and two independent
 * scans — one picking the model by `isDefault`, one picking the key by row
 * order — could disagree, sending one row's real cloud key as a Bearer header
 * to another row's server. Carrying the picked row's own slot is what makes
 * that disagreement unrepresentable.
 */
export const LLM_API_KEY_REF = "kv/llm#api-key";

/** Strip a trailing `/v1`: the driver appends the version segment itself. */
function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/** The model id an operator typed, out of the row's non-secret config bag. */
function modelIdOf(configJson: unknown): string | null {
  if (typeof configJson !== "object" || configJson === null) return null;
  const model = (configJson as Record<string, unknown>)["model"];
  return typeof model === "string" && model.trim() !== "" ? model.trim() : null;
}

/**
 * The row's "skip TLS certificate verification" switch, from the same
 * non-secret config bag as the model id. Stored as the STRING `"true"`
 * because `ConnectionConfig` is a string→string record by contract; anything
 * else — absent, `"false"`, junk — reads as off, so an unanswered question
 * fails closed onto full verification.
 */
function skipTlsVerifyOf(configJson: unknown): boolean {
  if (typeof configJson !== "object" || configJson === null) return false;
  return (configJson as Record<string, unknown>)["skipTlsVerify"] === "true";
}

/**
 * Which row serves this install, or `null` when none does.
 *
 * A row qualifies only when it is ENABLED, names a model KIND, and carries a
 * model id — a connection created without one has not been finished, and
 * treating it as the active model would dial a server with no model name and
 * fail at the provider instead of here.
 *
 * Among the qualifying rows the DEFAULT wins; failing that, the first by id.
 * Ordering by id and taking the first is what makes the answer deterministic
 * when an install has several — a resolver that could pick differently between
 * two calls would produce a stack whose answering model depends on row order,
 * which is precisely what the partial unique index on `isDefault` exists to
 * prevent at the other end.
 */
export function pickModelRow(rows: readonly ConnectionModelRow[]): ConnectionModelRow | null {
  const usable = rows.filter(
    (row) => row.enabled && MODEL_CONNECTION_KINDS.includes(row.kind) && modelIdOf(row.configJson) !== null,
  );
  return usable.find((row) => row.isDefault) ?? usable[0] ?? null;
}

/**
 * Build the gateway's `resolveModel` thunk from a database client.
 *
 * Both entrypoints wire it through this one function for the same reason they
 * share `connectionSecretsFrom`: the BFF and the worker must resolve the model
 * IDENTICALLY, or the endpoint an admin tests green in the panel is not the one
 * the run dials — which is the whole split this seam was built to close.
 */
export function connectionModelFrom(db: {
  connection: ConnectionModelDelegate;
}): () => Promise<ResolvedModel | null> {
  return async () => {
    let rows: readonly ConnectionModelRow[];
    try {
      rows = await db.connection.findMany({ orderBy: { id: "asc" } });
    } catch {
      /**
       * The database is unreachable, or the table has not been migrated on a
       * stack that predates this change. Neither is a reason to fail a call the
       * ENVIRONMENT can still answer: returning null hands the decision back to
       * the static config — the gateway's `#activeModel` treats a null from
       * this resolver as "the panel has no answer" and falls back to the
       * `.env`-derived binding, so a deployment that still names `LLM_BASE_URL`
       * keeps running exactly as before, a transient outage included. An
       * install configured only from the panel reaches the not-configured
       * refusal instead, which is the honest answer for it: with the rows
       * unreadable and no environment endpoint there is nothing to dial.
       */
      return null;
    }

    const row = pickModelRow(rows);
    if (row === null) return null;
    const model = modelIdOf(row.configJson);
    if (model === null) return null;

    return {
      baseUrl: normalizeBaseUrl(row.baseUrl),
      model,
      /**
       * On-prem standing comes from the ROW, never from the URL. M18 makes this
       * the only thing between the confidential class and an outside endpoint,
       * so it must be something an operator asserted and an auditor can read.
       */
      onPrem: row.onPrem,
      /**
       * THE PICKED ROW answers for its own key. `secretRef` is the slot the
       * panel's `storeToken` enciphered this row's token into — empty string
       * included, which the driver reads as "send no Authorization header at
       * all". Naming the row's slot here, rather than the shared reference, is
       * what guarantees the credential and the endpoint come from the SAME
       * row: the shared `kv/llm#api-key` fallback is reserved for a row that
       * never stored a token, and it resolves from the environment only —
       * never by scanning other rows (see `LLM_API_KEY_REF` above).
       */
      apiKeyRef: row.secretRef ?? LLM_API_KEY_REF,
      /**
       * The handshake follows the row too: the probe honoured this switch
       * when the panel's test went green, and the run must perform the same
       * handshake or the green is evidence about nothing (test=run symmetry).
       */
      skipTlsVerify: skipTlsVerifyOf(row.configJson),
    };
  };
}
