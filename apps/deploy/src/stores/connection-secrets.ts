import type { SecretPort } from "@maestro/ports";
import { EncryptedSecretStore, resolveMasterKey } from "./encrypted-secret.js";

/**
 * The SecretPort that reads what the operator typed into the panel.
 *
 * THE GAP THIS CLOSES. Until now the platform had two credential paths that
 * never met. An admin entered a Jira token in "Ayarlar & bağlantılar", it was
 * enciphered into `ConnectorSecret` and tested live against the real Jira — and
 * then every RUN authenticated with `MAESTRO_SECRET_KV_JIRA__TOKEN` from the
 * `.env` file instead, because `driver-config.ts` hands the drivers a
 * `kv/jira#token` reference and the env-file/Vault driver is what resolves it.
 * The panel stored, tested and displayed a credential that nothing ever used.
 * The operator had no way to see this: both halves were individually telling
 * the truth.
 *
 * So this is a COMPOSITE, not a new driver. It sits in front of the deployment's
 * real SecretPort and answers two families of reference: the handful of shared
 * ones a managed connection can own by KIND (`kv/jira#token`,
 * `kv/github#token`, …), and the per-row `connector:` slots the panel writes —
 * the model resolver names the picked row's slot outright, so the LLM key never
 * goes through a kind scan at all (see `CONNECTION_KIND_FOR_REF` on why).
 * Everything else — and every reference no connection has claimed — falls
 * straight through to the port behind it, so a Vault deployment keeps resolving
 * from Vault and nothing that used to work stops working.
 *
 * ── WHY A SecretPort AND NOT A REWIRE OF THE DRIVERS ────────────────────────
 * Because the drivers already resolve their credentials LAZILY, and that is the
 * property the whole design rests on. `createJiraCloudWorkPort` passes
 * `token: () => deps.secrets.get(config.apiTokenRef)` and the client invokes
 * that thunk on EVERY request (`cloud/client.ts`), never once at boot. Slotting
 * a composite into `deps.secrets` therefore makes a token an operator changes in
 * the panel take effect on the very next API call — no restart, no cache to
 * invalidate, no port to rebuild. A design that resolved credentials at
 * composition time would have had to solve that problem; this one never creates
 * it.
 *
 * It is also the smallest possible change. The ports, the drivers, the registry
 * and the frozen `packages/ports` contract are all untouched: the only thing
 * that changes is WHICH SecretPort the composition root hands them.
 *
 * ── WHAT IS DELIBERATELY NOT MOVED ──────────────────────────────────────────
 * The base URL. `driver-config.ts` reads `JIRA_BASE_URL`/`JIRA_CLOUD_BASE_URL`
 * SYNCHRONOUSLY while composing, and `workDriverFor` picks the Data Center or
 * Cloud driver from which of the two is filled — before any database can be
 * consulted. Serving the address from a connection would mean an async,
 * rebuildable composition root, which is precisely the boot-time rewiring that
 * is not worth the risk. The address stays a deployment fact in `.env`; the
 * CREDENTIAL is what the panel now owns. That split is not a compromise — a
 * token is rotated often and by an admin, an address is chosen once and by
 * whoever installed the stack.
 */

/**
 * The shape of a connection's own secret slot, as the panel's `storeToken`
 * writes it: `connector:<connectionId>:<random>`. A reference with this prefix
 * names one row's credential and nothing else, which is why `get` serves it
 * from the panel's store directly instead of consulting the kind table.
 */
export const CONNECTOR_SECRET_REF_PREFIX = "connector:";

/** What this composite needs of a connection row. Structural, like every store here. */
export interface ConnectionCredentialRow {
  id: string;
  kind: string;
  secretRef: string | null;
  enabled: boolean;
}

/** The `PrismaClient.connection` methods this resolver uses — read-only. */
export interface ConnectionCredentialDelegate {
  findMany(args: { orderBy: { id: "asc" } }): Promise<ConnectionCredentialRow[]>;
}

/**
 * Which managed connection kind answers for which secret reference.
 *
 * The reference is what the DRIVERS ask for (`driver-config.ts` builds them
 * from `JIRA_TOKEN_REF` and friends); the kind is what the PANEL writes. This
 * table is the whole of the mapping between the two, and it is deliberately
 * explicit rather than derived: a connection kind that is not listed here has
 * no authority over any deployment credential, which is what keeps a future
 * connector kind from silently taking over a reference it was never meant to
 * serve.
 *
 * Both Jira kinds map to the same reference because a deployment speaks to
 * exactly ONE Jira (`assertOneJiraInstance` refuses two), so there is no
 * ambiguity to resolve — whichever kind the operator created is the one that
 * install talks to.
 */
/**
 * ── WHY THE WEBHOOK SECRET IS NOT IN THIS TABLE ─────────────────────────────
 * `kv/jira#webhook` is deliberately absent, and it is the one credential in the
 * bundle that genuinely belongs in `.env` rather than in the panel.
 *
 * It is per-Jira-instance, so by the ordinary reasoning it would sit with the
 * Jira connection. The reason it does not is WHERE it is read. Every other
 * reference here is resolved on an OUTBOUND call the platform itself decided to
 * make — a run authenticating to Jira, to GitHub, to the model endpoint. The
 * webhook secret is resolved on an INBOUND, UNAUTHENTICATED request:
 * `POST /webhooks/jira` calls `deps.work.verifyWebhook` before it parses the
 * body and before anything has established that the caller is Jira at all
 * (`apps/bff/src/routes/webhooks.ts`).
 *
 * Serving it from a connection would therefore put a database read in front of
 * the signature check, on a route with no rate limit, reachable by anyone who
 * can address the host. Every forged delivery would become a query. The
 * verification is fail-closed precisely so that an unauthenticated request
 * costs nothing and proves nothing — and a credential lookup that has to happen
 * BEFORE the request is trusted must not depend on a store the request could be
 * used to hammer.
 *
 * So it stays an environment variable, read from memory, and the bundle keeps
 * one `MAESTRO_SECRET_*` line with that reason written beside it.
 */
export const CONNECTION_KIND_FOR_REF: Readonly<Record<string, readonly string[]>> = {
  "kv/jira#token": ["jira_cloud", "jira_dc"],
  "kv/github#token": ["github"],
  "kv/ado#token": ["ado"],
  /**
   * ── WHY THE MODEL KEY (`kv/llm#api-key`) IS DELIBERATELY ABSENT ───────────
   * It used to be here, mapped to the three LLM kinds, on the claim that a
   * deployment dials exactly one model endpoint. Migration 0021 made that
   * claim false: an install may hold SEVERAL model rows (an on-prem
   * `openai_compat` next to an OpenRouter one), and this table's row scan
   * answered the shared reference from the FIRST row with a token — while the
   * model resolver picked its row by `isDefault`. Two independent picks meant
   * the run could dial one row's endpoint with ANOTHER row's credential: a
   * cloud vendor's real key sent as a Bearer header to an on-prem server, or
   * an on-prem row's deliberately empty key 401-ing a cloud vendor forever.
   *
   * The model's credential therefore travels WITH the picked row now:
   * `connectionModelFrom` puts the row's own `connector:` slot into
   * `ResolvedModel.apiKeyRef`, and this port serves such slots directly (see
   * `get`). `kv/llm#api-key` still exists, but it belongs to the `.env`
   * fallback alone — asked only when no panel row answers the model, or when
   * the picked row never stored a token — and it now falls straight through
   * to the deployment's own port. Re-adding it to this table would resurrect
   * the row scan, and with it the mismatch.
   */
};

export interface ConnectionSecretPortOptions {
  /** The managed connections an admin created in the panel. */
  readonly connections: ConnectionCredentialDelegate;
  /**
   * Where the enciphered token actually lives — the `EncryptedSecretStore`
   * keyed by `CONNECTOR_MASTER_KEY`. A connection's `secretRef` is a slot name
   * in THIS store, never in Vault: the panel writes here and Vault stays a
   * mount only the operator manages (see `bin/bff.ts`).
   */
  readonly connectorSecrets: SecretPort;
  /**
   * The deployment's own SecretPort — Vault in prod, `MAESTRO_SECRET_*` in dev.
   * Everything this composite does not own falls through to it unchanged.
   */
  readonly fallback: SecretPort;
  /**
   * Where the precedence note goes. A silent precedence rule is how an operator
   * ends up saying "I changed it and nothing happened", so the shadowing is
   * announced rather than assumed.
   */
  readonly log?: (message: string) => void;
}

/**
 * A `SecretPort` that prefers the panel's connection over the `.env` file.
 *
 * ── PRECEDENCE: THE CONNECTION WINS ─────────────────────────────────────────
 * When a managed connection holds a token for a reference AND the environment
 * also defines one, the connection's is used. That direction is chosen, not
 * inherited, and it is the one that matches what an operator just did: they
 * opened the panel, typed a credential, pressed Test and watched it go green.
 * A `.env` value quietly outranking that would make the panel a decoration —
 * which is the exact failure this file exists to end. The env value keeps
 * serving every install that has not created a connection yet, which is what
 * makes this safe to switch on for a stack that is already running.
 *
 * The losing value is never silent: the first time a reference is served from a
 * connection while the environment also had one, a line is logged naming the
 * reference and the connection that won. It is logged once per reference rather
 * than per call, because this is resolved on every outbound request and a
 * per-call line would be a log flood that hides the thing it is trying to say.
 *
 * ── FRESHNESS: NO CACHE, ON PURPOSE ─────────────────────────────────────────
 * Every `get` re-reads the connection row. A token rotated in the panel is
 * therefore live on the next API call with no restart — and that is worth the
 * query, because the alternative is the class of bug where an operator fixes a
 * credential, sees no change, and has no way to tell whether they fixed the
 * wrong thing or the platform simply did not notice. The read is a single
 * indexed `findMany` on a table with a handful of rows, on a path that is
 * already making a network call to Jira or GitHub.
 */
export class ConnectionSecretPort implements SecretPort {
  readonly #connections: ConnectionCredentialDelegate;
  readonly #connectorSecrets: SecretPort;
  readonly #fallback: SecretPort;
  readonly #log: (message: string) => void;
  /** References already announced as shadowing an env value — see the class note. */
  readonly #announced = new Set<string>();

  constructor(options: ConnectionSecretPortOptions) {
    this.#connections = options.connections;
    this.#connectorSecrets = options.connectorSecrets;
    this.#fallback = options.fallback;
    this.#log = options.log ?? ((message: string) => console.info(message));
  }

  /**
   * Resolve a reference, preferring a managed connection's token.
   *
   * A connection is consulted only for the references it can legitimately own
   * (`CONNECTION_KIND_FOR_REF`) and only when it is ENABLED and actually holds a
   * token. Anything else — an unknown reference, a disabled connection, a
   * connection created without a credential — falls through to the deployment's
   * own port, which is what keeps this change invisible to every install that
   * has not adopted it.
   */
  async get(key: string): Promise<string> {
    /**
     * A `connector:` reference IS a row's own slot, named by the caller — the
     * model resolver hands the driver the picked row's `secretRef`, so the
     * credential provably belongs to the same row that supplied the endpoint.
     * It is served from the panel's store directly, and there is deliberately
     * NO fallback: a per-row slot has no `.env` equivalent, and answering a
     * failed decrypt with some other source's credential would attach a key
     * from a different place to this row's server — the exact cross-wiring
     * the per-row reference exists to make impossible. A slot that will not
     * decrypt (master key rotated) fails the call loudly instead, and the
     * panel already shows that row failing its test.
     */
    if (key.startsWith(CONNECTOR_SECRET_REF_PREFIX)) return this.#connectorSecrets.get(key);

    const kinds = CONNECTION_KIND_FOR_REF[key];
    if (kinds === undefined) return this.#fallback.get(key);

    const ref = await this.#connectionRefFor(kinds);
    if (ref === null) return this.#fallback.get(key);

    let token: string;
    try {
      token = await this.#connectorSecrets.get(ref);
    } catch {
      /**
       * The connection names a secret slot that will not decrypt — a row whose
       * ciphertext was written under a DIFFERENT `CONNECTOR_MASTER_KEY`, most
       * often because the key was rotated or restored from a backup without it.
       *
       * Falling back to the environment here is deliberate and it is the
       * conservative choice: the alternative is that rotating the master key
       * takes down a stack that still has a perfectly good `.env` credential.
       * The operator has to re-enter the token in the panel either way, and the
       * panel already shows them a connection that fails its test.
       */
      return this.#fallback.get(key);
    }

    // The env value that just lost, named once. See the class note on why this
    // is announced at all and why only once.
    if (!this.#announced.has(key)) {
      this.#announced.add(key);
      let shadowed = false;
      try {
        await this.#fallback.get(key);
        shadowed = true;
      } catch {
        // Nothing in the environment for this reference — the normal case on a
        // stack configured entirely from the panel, and nothing to report.
      }
      if (shadowed) {
        this.#log(
          `[maestro] "${key}": panelden tanımlı bağlantının jetonu kullanılıyor; ` +
            "ortam değişkenindeki (.env) değer YOK SAYILIYOR. Bağlantıyı Ayarlar & " +
            "bağlantılar ekranından yönetin, .env satırını silebilirsiniz.",
        );
      }
    }

    return token;
  }

  /**
   * The connection's secret slot for these kinds, or null when none qualifies.
   *
   * Ordered by id and the FIRST qualifying row wins, which makes the answer
   * deterministic when an install has created more than one connection of a
   * kind. Determinism is the property that matters here: a resolver that could
   * pick a different credential between two calls would produce a stack whose
   * authentication depends on row order.
   */
  async #connectionRefFor(kinds: readonly string[]): Promise<string | null> {
    let rows: readonly ConnectionCredentialRow[];
    try {
      rows = await this.#connections.findMany({ orderBy: { id: "asc" } });
    } catch {
      // The database is unreachable, or the table does not exist yet on a stack
      // that has not migrated. Neither is a reason to fail a credential lookup
      // the environment can still answer.
      return null;
    }
    for (const row of rows) {
      if (!row.enabled || row.secretRef === null) continue;
      if (kinds.includes(row.kind)) return row.secretRef;
    }
    return null;
  }

  /**
   * Writes go to the deployment's port, never to a connection.
   *
   * A connection's token is written by the panel through the
   * `EncryptedSecretStore` and nowhere else. Letting a driver `set` its way into
   * a connection row would give a workflow the power to rewrite the credential
   * an admin manages, which is a different thing entirely from reading it.
   */
  set(key: string, value: string): Promise<void> {
    return this.#fallback.set(key, value);
  }

  /**
   * Short-lived credentials (M31) stay with the deployment's port.
   *
   * These are MINTED — a Vault-issued push credential with a TTL — not stored,
   * and a managed connection holds a long-lived token that cannot serve the
   * same purpose. Answering one with the other would hand out a permanent
   * credential where a scoped, expiring one was required.
   */
  issueShortLived(scope: string, ttlSeconds: number): Promise<{ secret: string; expiresAt: string }> {
    return this.#fallback.issueShortLived(scope, ttlSeconds);
  }
}

/**
 * The `BootOptions.connectionSecrets` callback, built from a database client.
 *
 * Both entrypoints wire it the same way and through this one function on
 * purpose: the BFF and the worker must resolve a credential IDENTICALLY, or the
 * connection an admin tests green in the panel is not the one the run
 * authenticates with — which is the exact split this whole seam was built to
 * close. One factory means there is no second place for the rule to drift.
 *
 * The master key is resolved here rather than passed in because it is the same
 * key the panel enciphered the token under; reading it from anywhere else would
 * make "the panel wrote it" and "the run reads it" two independent claims.
 */
export function connectionSecretsFrom(
  db: {
    connection: ConnectionCredentialDelegate;
    connectorSecret: ConstructorParameters<typeof EncryptedSecretStore>[1];
  },
  log?: (message: string) => void,
): (fallback: SecretPort, env: { profile: string }) => SecretPort {
  return (fallback, env) =>
    new ConnectionSecretPort({
      connections: db.connection,
      connectorSecrets: new EncryptedSecretStore(
        resolveMasterKey({
          envValue: process.env["CONNECTOR_MASTER_KEY"],
          isProduction: env.profile === "prod",
        }),
        db.connectorSecret,
      ),
      fallback,
      ...(log === undefined ? {} : { log }),
    });
}
