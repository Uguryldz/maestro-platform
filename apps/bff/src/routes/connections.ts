import { randomBytes } from "node:crypto";
import {
  type ConnectionConfig,
  ConnectionId,
  ConnectionInput,
  missingConfigKeys,
} from "@maestro/contracts";
import { noteWithParams } from "../connection-note.js";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { sessionActor } from "../actor.js";
import { authGuard, requireAnyRole, sessionOf } from "../auth/guard.js";
import type { ConnectionRecord, ConnectionStore } from "../connection-store.js";
import {
  botUsernameFor,
  ensureBotUser,
  maskToken,
  runConnectionTest,
  toConnectionRecord,
  toConnectionView,
} from "../connection-service.js";
import { toActor } from "../actor.js";
import type { ResolvedDeps } from "../deps.js";
import { badRequest, notFound } from "../errors.js";
import type { SecretPort } from "@maestro/ports";
import { assertWritable } from "../platform/propose.js";
import { unwired } from "./unwired.js";

/**
 * The connector-management surface (installable-product wiring).
 *
 * The platform's outbound connections (Jira, GitHub, the LLM, Vault) become
 * admin-editable here: an admin enters a URL + token, tests it LIVE, and the
 * token is stored AES-encrypted and only ever read back as a four-character
 * mask. Everything that could leak a secret is designed against:
 *
 *  · A raw token appears only on the INBOUND `ConnectionInput.token`; no GET
 *    returns it, because the read shape (`Connection`) has no token field.
 *  · The live test uses the STORED credential, never one on the test request:
 *    a viewer cannot hand a token to `/test` and have it POSTed to a URL they
 *    chose. (They also cannot reach the route — it is admin-gated.)
 *  · Every write/test/delete is admin-only at the BFF (M86), independent of
 *    what Studio shows.
 *  · Reads are admin + tech-lead, the same audience as the settings screen.
 *
 * A test failure is reported as a failure — there is no shape here that fakes a
 * green light, and `lastTestOk` is recorded from the real outcome.
 */

const READ_ROLES = ["admin", "tech-lead"] as const;
const WRITE_ROLES = ["admin"] as const;

/** The `:id` path param — the same grammar the contract's `ConnectionId` uses. */
const IdParam = z.object({ id: ConnectionId });

/**
 * Both halves the connector routes need, or neither. The store persists the
 * connection; the SecretPort enciphers the token. A deployment that wired one
 * but not the other could store a connection it can never decrypt a token for,
 * so the routes demand the pair and otherwise refuse by name.
 */
function connectorDeps(deps: ResolvedDeps): { store: ConnectionStore; secrets: SecretPort } {
  if (deps.connections === undefined || deps.connectorSecrets === undefined) unwired("connections");
  return { store: deps.connections, secrets: deps.connectorSecrets };
}

/**
 * Refuse a row whose kind cannot work with the config it carries.
 *
 * `ConnectionInput` validates `config` only as a size-capped string bag, so a
 * `jira_cloud` row with no `email` used to save happily and then fail its live
 * test with a 401 — which reads as a bad token and sends the operator to
 * re-issue a credential that was fine. The kind knows what it needs
 * (`CONNECTION_KIND_SPECS`); this is the one place that enforces it, and the
 * form marks the same fields from the same table.
 */
function assertNotWorse(existing: { config: ConnectionConfig }, next: ConnectionInput): void {
  const before = new Set(missingConfigKeys(next.kind, existing.config));
  const opened = missingConfigKeys(next.kind, next.config).filter((key) => !before.has(key));
  if (opened.length > 0) throw badRequest("missing_config", { fields: opened });
}

function assertConfigComplete(input: ConnectionInput): void {
  const missing = missingConfigKeys(input.kind, input.config);
  // A stable code plus the field names as DETAILS, rather than a code built by
  // string concatenation: the catalogue key stays greppable and the client can
  // mark the exact boxes instead of parsing a colon out of an error code.
  if (missing.length > 0) throw badRequest("missing_config", { fields: missing });
}

export async function connectionRoutes(app: FastifyInstance, deps: ResolvedDeps): Promise<void> {
  const readHandler = [authGuard(deps), requireAnyRole(...READ_ROLES)];
  const writeHandler = [authGuard(deps), requireAnyRole(...WRITE_ROLES)];

  /** List every connection, masked. Never a token — only the mask + a set flag. */
  app.get("/studio/connections", { preHandler: readHandler }, async (_request, reply) => {
    const { store } = connectorDeps(deps);
    const rows = await store.list();
    return reply.code(200).send({ connections: rows.map(toConnectionView) });
  });

/**
 * Make this row the only default, by demoting whichever row held it.
 *
 * WHY THE ROUTE AND NOT THE DATABASE. The partial unique index
 * (`Connection_one_default_model`) is the guarantee that two rows can never
 * BOTH be default — it is the backstop that makes "at most one" a fact rather
 * than a convention. But an index can only REFUSE a second default, and
 * refusing is the wrong behaviour for this action: an admin pressing
 * "Varsayılan yap" on a second model plainly means "this one instead", not
 * "fail because another one already is". So the demotion happens here, before
 * the write, and the index stands behind it to catch anything that bypasses
 * this path.
 *
 * Only rows of the SAME kind family are demoted — a default Jira connection, if
 * that ever means anything, is a different question from which model answers.
 */
async function clearOtherDefaults(
  store: ConnectionStore,
  clock: ResolvedDeps["clock"],
  keepId: string,
): Promise<void> {
  for (const row of await store.list()) {
    if (row.id === keepId || !row.isDefault) continue;
    await store.put({ ...row, isDefault: false, updatedAt: clock.now().toISOString() });
  }
}

  /** Create a connection. Zod-validated; a new token is enciphered, never stored raw. */
    app.post("/studio/connections", { preHandler: writeHandler }, async (request, reply) => {
    await assertWritable(deps);
    const { store, secrets } = connectorDeps(deps);

    const id = ConnectionId.safeParse((request.body as { id?: unknown } | null)?.id);
    if (!id.success) throw badRequest("invalid_connection_id");
    const body = ConnectionInput.safeParse(request.body);
    if (!body.success) throw badRequest("invalid_connection_body");
    assertConfigComplete(body.data);

    if ((await store.get(id.data)) !== null) throw badRequest("connection_exists");

    const now = deps.clock.now().toISOString();
    const secret = await storeToken(secrets, id.data, body.data.token, null);
    const record = toConnectionRecord(id.data, body.data, secret, {
      createdAt: now,
      updatedAt: now,
      lastTestedAt: null,
      lastTestOk: null,
    });
    // A row created AS the default demotes the previous one first, so the
    // partial unique index never has to refuse a legitimate intent.
    if (record.isDefault) await clearOtherDefaults(store, deps.clock, record.id);
    await store.put(record);

    // Provision the bot's account at CREATE too, not only at test.
    //
    // The operator's mental model is "I connected Jira" — they do not
    // necessarily press Test afterwards, and a bot that only exists once
    // somebody remembers to is the same silent gap this whole change closes. So
    // the create path probes the identity the same way the test does: the row is
    // still only ever minted from a LIVE `/myself` answer, never from what the
    // form claimed. A connection created without a working token simply
    // provisions nothing, and the operator's later Test provisions it then.
    const created = await provisionFromProbe(deps, record, body.data.token ?? null);
    await audit(deps, request, id.data, "created", botMeta(created));
    return reply.code(201).send({
      connection: toConnectionView(record),
      ...(created === null
        ? {}
        : {
            botUser: {
              username: created.username,
              displayName: created.displayName,
              created: created.created,
            },
          }),
    });
  });

  /** Update a connection. A new token replaces the old ref; an absent token keeps it. */
  app.put("/studio/connections/:id", { preHandler: writeHandler }, async (request, reply) => {
    await assertWritable(deps);
    const { store, secrets } = connectorDeps(deps);

    const params = IdParam.safeParse(request.params);
    if (!params.success) throw badRequest("invalid_connection_id");
    const body = ConnectionInput.safeParse(request.body);
    if (!body.success) throw badRequest("invalid_connection_body");

    const existing = await store.get(params.data.id);
    if (existing === null) throw notFound("no_such_connection");
    assertNotWorse(existing, body.data);

    const secret = await storeToken(secrets, params.data.id, body.data.token, existing);
    // A learned `botAccountId` SURVIVES an edit that does not carry one. The
    // panel's modal round-trips `config` verbatim, so a plain rename or URL fix
    // would otherwise write back whatever the form was opened with — which is
    // how a hand-typed wrong id outlived every correction the test made. A body
    // that DOES carry the key still wins; this only refuses to lose the value.
    const merged = mergeLearnedIdentity(body.data, existing);
    const record = toConnectionRecord(params.data.id, merged, secret, {
      createdAt: existing.createdAt,
      updatedAt: deps.clock.now().toISOString(),
      // An edit does not un-test the connection; the test result (and its note)
      // stand until a new test overwrites them.
      lastTestedAt: existing.lastTestedAt,
      lastTestOk: existing.lastTestOk,
      lastTestNote: existing.lastTestNote,
    });
    if (record.isDefault) await clearOtherDefaults(store, deps.clock, record.id);
    await store.put(record);
    await audit(deps, request, params.data.id, "updated");
    return reply.code(200).send({ connection: toConnectionView(record) });
  });

  /**
   * The LIVE test. Reads the STORED token (never one from the request), calls
   * the target, records the honest outcome, and returns ok/fail + a catalog key.
   */
  app.post("/studio/connections/:id/test", { preHandler: writeHandler }, async (request, reply) => {
    const { store, secrets } = connectorDeps(deps);

    const params = IdParam.safeParse(request.params);
    if (!params.success) throw badRequest("invalid_connection_id");
    const record = await store.get(params.data.id);
    if (record === null) throw notFound("no_such_connection");

    // The token is fetched here and passed to the test; it is never logged and
    // never returned. A connection with no secretRef tests as "no token".
    const token = record.secretRef === null ? null : await readToken(secrets, record.secretRef);
    const outcome = await runConnectionTest(
      record,
      token,
      deps.connectorFetch,
      deps.config.engineBotAccountId,
    );

    const at = deps.clock.now().toISOString();

    // EVERY failed probe leaves a server-side trace. The response deliberately
    // speaks in secret-free catalog keys, and before this line that discipline
    // meant the operator's "Adrese ulaşılamadı" had NO counterpart in the BFF
    // log at all — nothing to grep, nothing for support to read. The warn
    // carries what the response may not: the cause-code chain the transport
    // reported (`ENOTFOUND`, `SELF_SIGNED_CERT_IN_CHAIN`, …). Still under the
    // same secrecy rule — the target's HOSTNAME only (never the full URL or a
    // header), codes only (never an error message that could quote either).
    if (!outcome.ok) {
      request.log.warn(
        {
          connection: record.id,
          kind: record.kind,
          host: outcome.diagnostic?.host ?? hostOf(record.baseUrl),
          causes: outcome.diagnostic?.causes ?? [],
          note: outcome.messageKey,
        },
        "connection test failed",
      );
    }

    // A successful Jira test learned the bot's own accountId. Persist it in the
    // connection's (non-secret) config so a listening rule can offer "the bot"
    // by name instead of asking an operator to hand-copy a 40-char GUID. Only on
    // success and only when it changed, so a failed test never wipes a good value.
    //
    // This is the SELF-HEAL, and it is deliberately automatic: the live answer
    // is authoritative (the token's own owner), whereas the stored value is a
    // hand-typed 36-char id — believing the keyboard over the API would keep a
    // known-wrong account in place. What changed is never silent, though: the
    // outcome carries `ok_bot_fixed` so the panel names both ids, and the audit
    // row records the replacement rather than a plain "test_ok".
    //
    // It runs BEFORE `recordTest`: `put` writes the whole row from the record
    // read at the top of the handler, which still carries the PREVIOUS test
    // result — healing afterwards would erase the verdict just recorded.
    if (outcome.ok && outcome.accountId && record.config["botAccountId"] !== outcome.accountId) {
      await store.put({
        ...record,
        config: { ...record.config, botAccountId: outcome.accountId },
        updatedAt: at,
      });
    }

    // The bot's own Maestro account. A successful probe has just told us who
    // this token is; that identity is worth a directory ROW, because every
    // surface that resolves an actor goes through `UserDirectory.find` and a bot
    // without a row is an actor nothing can name. It rides the same success-and-
    // accountId condition as the self-heal above for exactly that reason: both
    // are things we may only claim when the live answer told us so.
    //
    // Deliberately NOT fatal. Provisioning is a convenience on top of a test
    // whose real job is to say whether the credential works; a directory that
    // refuses a write must not turn a green connection into a red one. The
    // failure is recorded in the audit meta instead of thrown.
    const provisioned =
      outcome.ok && outcome.accountId !== undefined
        ? await provisionBot(deps, record, outcome.accountId, outcome.identity)
        : null;

    // `outcome.messageKey` is a catalog KEY (e.g. "connection.test.unauthorized"),
    // never raw text — safe to persist as the row's secret-free test note.
    //
    // The PARAMS travel with it. Six of the most useful diagnostics interpolate
    // one ("Sunucu adı çözülemedi (DNS): {host}"), and the panel re-renders the
    // stored note after a reload with no params — so the operator's best clue
    // turned into the literal string `{host}` the moment they refreshed. The
    // column is a 128-char string, so they ride along in it rather than in a
    // new column: see `noteWithParams`.
    await store.recordTest(record.id, {
      at,
      ok: outcome.ok,
      note: noteWithParams(outcome.messageKey, outcome.messageParams),
    });
    const verb = outcome.ok
      ? outcome.accountIdCorrected === undefined
        ? "test_ok"
        : "test_ok_bot_corrected"
      : "test_fail";
    await audit(deps, request, record.id, verb, {
      // The displaced id and its replacement — opaque account ids, never an
      // email, so the audit trail can answer "whose account was this?" later.
      ...(outcome.accountIdCorrected === undefined
        ? {}
        : { botAccountIdWas: outcome.accountIdCorrected.from, botAccountIdNow: outcome.accountId }),
      // A split identity is recorded even though the test passed: it is the
      // condition under which every rule built from this connection is dead, so
      // the trail must show WHEN it started and when it stopped, not just that
      // somebody once tested the connection successfully.
      ...(outcome.engineMismatch === undefined
        ? {}
        : {
            engineMismatchConnection: outcome.engineMismatch.connection,
            engineMismatchEngine: outcome.engineMismatch.engine,
          }),
      // A minted account is a governance event: an account that can appear as an
      // actor came into existence, and the trail has to say when and under whose
      // hand. An account that was already there is recorded too, as `existing` —
      // "we looked and did not need to" is a different fact from "we never
      // looked", and only one of them means the bot has a row.
      ...botMeta(provisioned),
    });

    return reply.code(200).send({
      ok: outcome.ok,
      messageKey: outcome.messageKey,
      ...(outcome.messageParams === undefined ? {} : { messageParams: outcome.messageParams }),
      testedAt: at,
      // Account ids only — `/myself` also returns an email, which never travels.
      ...(outcome.accountIdCorrected === undefined || outcome.accountId === undefined
        ? {}
        : { botAccountCorrected: { from: outcome.accountIdCorrected.from, to: outcome.accountId } }),
      // The identity split, as structured data beside the sentence — the panel
      // renders it as a warning without having to parse the message.
      ...(outcome.engineMismatch === undefined ? {} : { engineMismatch: outcome.engineMismatch }),
      // The bot's account, so the panel can say "this connection acts as
      // <name>" and point at a row that now demonstrably exists. A username and
      // a display name only — no groups, because the answer to "what may this
      // bot do" is a directory question the users screen owns, not a line item
      // on a connection test.
      ...(provisioned === null
        ? {}
        : {
            botUser: {
              username: provisioned.username,
              displayName: provisioned.displayName,
              created: provisioned.created,
            },
          }),
    });
  });

  /** Delete a connection and its secret. */
  app.delete("/studio/connections/:id", { preHandler: writeHandler }, async (request, reply) => {
    await assertWritable(deps);
    const { store, secrets } = connectorDeps(deps);

    const params = IdParam.safeParse(request.params);
    if (!params.success) throw badRequest("invalid_connection_id");

    const removed = await store.remove(params.data.id);
    if (removed === null) throw notFound("no_such_connection");
    // Drop the enciphered secret too — a connection deleted with its token left
    // behind is an orphaned credential nobody can see but that still exists.
    if (removed.secretRef !== null) await deleteToken(secrets, removed.secretRef);
    await audit(deps, request, params.data.id, "deleted");
    return reply.code(204).send();
  });
}

/**
 * Run the identity probe and provision from what it found — the CREATE path's
 * version of what the test route does inline.
 *
 * It deliberately runs the same `runConnectionTest` rather than a lighter,
 * bespoke `/myself` call: one mechanism decides who a connection is, and a
 * second one would be free to disagree with it. The outcome is thrown away
 * except for the identity, because a create is not a test — the row's
 * `lastTestOk` stays `null` ("never tested"), which is the honest state.
 */
async function provisionFromProbe(
  deps: ResolvedDeps,
  record: ConnectionRecord,
  token: string | null,
): Promise<Awaited<ReturnType<typeof ensureBotUser>>> {
  if (record.kind !== "jira_cloud" && record.kind !== "jira_dc") return null;
  if (token === null) return null;
  let outcome;
  try {
    outcome = await runConnectionTest(record, token, deps.connectorFetch, deps.config.engineBotAccountId);
  } catch {
    // A create must not fail because the target was unreachable. The connection
    // is stored either way; the bot gets its row on the first successful test.
    return null;
  }
  if (!outcome.ok || outcome.accountId === undefined) return null;
  return provisionBot(deps, record, outcome.accountId, outcome.identity);
}

/** The audit meta a provisioning outcome contributes, or nothing at all. */
function botMeta(
  provisioned: Awaited<ReturnType<typeof ensureBotUser>>,
): Record<string, string> {
  return provisioned === null
    ? {}
    : {
        botUser: provisioned.username,
        botUserState: provisioned.created ? "created" : "existing",
        botUserDisplayName: provisioned.displayName,
      };
}

/**
 * Give the connection's bot a Maestro account, if its kind has one.
 *
 * ONLY the Jira kinds. The bot account exists because Jira is where Maestro is
 * ASSIGNED work and where its comments and transitions appear under a name — a
 * GitHub token or an LLM key is a credential the platform uses, not an identity
 * that acts inside it, and minting directory rows for those would fill the users
 * table with accounts that never appear as an actor anywhere.
 *
 * The display name is the operator's, from the connection's own config bag
 * (`config.botDisplayName` — a non-secret field like `email` and `botAccountId`
 * beside it), falling back to the name Jira itself reports. A deployment that
 * has not wired a user directory provisions nothing rather than failing.
 */
async function provisionBot(
  deps: ResolvedDeps,
  record: ConnectionRecord,
  accountId: string,
  jiraDisplayName: string | undefined,
): Promise<Awaited<ReturnType<typeof ensureBotUser>>> {
  if (record.kind !== "jira_cloud" && record.kind !== "jira_dc") return null;
  try {
    return await ensureBotUser(
      deps.users,
      record.id,
      {
        accountId,
        ...(jiraDisplayName === undefined ? {} : { jiraDisplayName }),
        // Absent/blank means "no preference" — `botDisplayName` then falls
        // through to Jira's own name, which is the documented default.
        ...(record.config["botDisplayName"] === undefined
          ? {}
          : { operatorDisplayName: record.config["botDisplayName"] }),
      },
      toActor(botUsernameFor(record.id), deps.config.actorDomain),
    );
  } catch {
    // See the call site: a directory write that fails must not turn a green
    // credential test red. The connection genuinely works; the row can be
    // provisioned by the next test or created by hand.
    return null;
  }
}

/**
 * Carry a learned `botAccountId` across an edit that omits it.
 *
 * The value is not operator data — it is what the live `/myself` probe read back
 * from the token itself. An edit whose `config` simply has no such key must not
 * be read as "clear it"; only a body that actually names the key may change it.
 */
function mergeLearnedIdentity(input: ConnectionInput, existing: ConnectionRecord): ConnectionInput {
  const learned = existing.config["botAccountId"];
  if (learned === undefined || input.config["botAccountId"] !== undefined) return input;
  return { ...input, config: { ...input.config, botAccountId: learned } };
}

/**
 * Encipher a new token, returning the reference + mask to store on the row.
 *
 * `undefined` token = "leave the existing secret alone" (a config-only edit):
 * the previous ref/mask are carried forward. A present token is enciphered
 * under a fresh reference (rotating the secret) and masked to its last four
 * chars. The plaintext is never stored on the connection and never logged.
 *
 * AN EMPTY STRING IS A TOKEN, not an omission. A self-hosted model server
 * (`openai_compat`) commonly requires no API key, and an operator saying so
 * explicitly is different from an operator not touching the field. `""` is
 * therefore enciphered into a real slot like any other value — AES-GCM handles
 * a zero-length plaintext fine — so the row gets a `secretRef` and reads back
 * as `secretSet: true` with an empty mask. That combination is the honest
 * encoding of "a credential is configured and it is deliberately blank", and it
 * is what lets `ConnectionSecretPort` serve the empty key to the driver instead
 * of falling through to a `.env` value the operator thought they had replaced.
 */
async function storeToken(
  secrets: SecretPort,
  connectionId: string,
  token: string | undefined,
  existing: ConnectionRecord | null,
): Promise<{ ref: string | null; mask: string | null }> {
  if (token === undefined) {
    return existing === null
      ? { ref: null, mask: null }
      : { ref: existing.secretRef, mask: existing.secretMask };
  }
  // A RANDOM suffix, not a timestamp: two rotations in the same millisecond
  // would collide on a `Date.now()` ref and the second write would overwrite the
  // first secret's slot instead of taking a new one. `randomBytes` makes each
  // rotation a fresh, unguessable slot.
  const ref = `connector:${connectionId}:${randomBytes(6).toString("hex")}`;
  await secrets.set(ref, token);
  return { ref, mask: maskToken(token) };
}

/** Decrypt the stored token for a live test. Its value never leaves this call. */
async function readToken(secrets: SecretPort, ref: string): Promise<string | null> {
  try {
    return await secrets.get(ref);
  } catch {
    // A ref with no secret (a hand-broken row) tests as "no token" rather than
    // taking the endpoint down.
    return null;
  }
}

/**
 * Hostname of a stored base URL, for the failed-test log line when the outcome
 * carries no transport diagnostic (no-token, HTTP status, missing model). The
 * hostname alone — a URL's path/query never reaches the log.
 */
function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "?";
  }
}

/** Best-effort secret removal on delete. */
async function deleteToken(secrets: SecretPort, ref: string): Promise<void> {
  const candidate = secrets as SecretPort & { delete?: (key: string) => Promise<void> };
  if (typeof candidate.delete === "function") await candidate.delete(ref);
}

/**
 * The audit row for a connector change. Uses `PARAM_CHANGED` — a connector is
 * platform configuration in the same governance category — and carries the
 * connection id and the verb, never the token or the URL's credentials.
 */
async function audit(
  deps: ResolvedDeps,
  request: Parameters<typeof sessionOf>[0],
  connectionId: string,
  verb: string,
  extra: Record<string, string> = {},
): Promise<void> {
  await deps.audit.append({
    actor: sessionActor(sessionOf(request)),
    action: "PARAM_CHANGED",
    subject: `connection:${connectionId}`,
    at: deps.clock.now(),
    meta: { surface: "connections", verb, ...extra },
  });
}
