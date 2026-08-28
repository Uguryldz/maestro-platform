import type { ConnectionKind } from "@maestro/contracts";
import type { SecretPort } from "@maestro/ports";
import { noteWithParams } from "./connection-note.js";
import { runConnectionTest, type ConnectorFetch } from "./connection-service.js";
import type { ConnectionRecord, ConnectionStore } from "./connection-store.js";
import type { HealthReader, ServiceHealth } from "./read-models.js";

/**
 * Health rows for the platform's EXTERNAL dependencies — the model provider,
 * the work tracker and the SCM — read from the managed-connection rows
 * (Ayarlar > Bağlantılar) instead of from a second, hand-wired probe set.
 *
 * WHY THIS EXISTS. `/studio/health` used to answer with Postgres and Temporal
 * only — the two things a deployment is least likely to lose — while the two
 * things a bank most needs to see fail, the LLM key and the Jira credential,
 * appeared nowhere. The probes for them already exist (`runConnectionTest`,
 * including the `/v1/models` model-served check), and the connection row
 * already remembers the last verdict (`lastTestedAt`/`lastTestOk`/
 * `lastTestNote`); this reader is the missing bridge between that machinery
 * and the health screen.
 *
 * THREE HONEST STATES per dependency:
 *  · `healthy`        — the last live test passed.
 *  · `down`           — the last live test failed; `note` carries its catalog
 *                       key, so the screen can say WHY (401, model missing…).
 *  · `not_configured` — no enabled connection of this family exists. Not a
 *                       fault: the fix is the settings screen, not a pager.
 *
 * NO PROBE STORM, by construction. The health screen polls every minute and
 * this endpoint must not turn that into a minute-by-minute hammering of
 * OpenRouter and Jira. A verdict younger than `ttlMs` is served STRAIGHT from
 * the row — the external service is not contacted at all, and the row's own
 * `lastTestedAt` is reported as `checkedAt` so the screen never claims a
 * fresher check than actually ran. Only a stale (or never-tested) connection
 * triggers one real `runConnectionTest`, whose verdict is written back through
 * `recordTest` — the SAME field the connections panel shows, so the two
 * screens can never disagree about the last test. An in-flight map coalesces
 * concurrent polls onto one probe per connection.
 */

/** Which connection kinds answer for which health row. Order = preference. */
const FAMILIES: readonly { service: string; kinds: readonly ConnectionKind[] }[] = [
  { service: "llm", kinds: ["openrouter", "anthropic", "openai_compat"] },
  { service: "jira", kinds: ["jira_cloud", "jira_dc"] },
  { service: "scm", kinds: ["github", "ado"] },
];

/** How long a stored verdict counts as fresh. Five minutes: an operator who
 * just fixed a key sees the change on the next poll after the TTL — or
 * immediately, because the panel's own "Test" button writes the same row. */
export const CONNECTION_HEALTH_TTL_MS = 5 * 60_000;

export interface ConnectionHealthOptions {
  readonly store: ConnectionStore;
  /** The connector secret store — the token never leaves the probe call. */
  readonly secrets: SecretPort;
  readonly fetchImpl: ConnectorFetch;
  readonly now?: () => Date;
  readonly ttlMs?: number;
}

export function connectionHealthReader(options: ConnectionHealthOptions): HealthReader {
  const now = options.now ?? ((): Date => new Date());
  const ttlMs = options.ttlMs ?? CONNECTION_HEALTH_TTL_MS;
  /**
   * Probes already running, by connection id. Two polls arriving inside the
   * same stale window must share one outbound request — without this, the very
   * cache meant to protect the provider would still let a refresh burst
   * through N times.
   */
  const inFlight = new Map<string, Promise<ServiceHealth>>();

  async function rowFor(record: ConnectionRecord, at: Date): Promise<ServiceHealth> {
    const fresh =
      record.lastTestedAt !== null &&
      record.lastTestOk !== null &&
      at.getTime() - new Date(record.lastTestedAt).getTime() <= ttlMs;
    if (fresh) return fromStored(record);

    const running = inFlight.get(record.id);
    if (running !== undefined) return running;

    const probe = (async (): Promise<ServiceHealth> => {
      // Same semantics as the panel's test endpoint: a broken secretRef reads
      // as "no token", never as an exception that takes the health page down.
      const token =
        record.secretRef === null ? null : await options.secrets.get(record.secretRef).catch(() => null);
      const outcome = await runConnectionTest(record, token, options.fetchImpl);
      const testedAt = now().toISOString();
      // Persisted so the connections panel and this screen tell one story —
      // best-effort, because a read model that cannot write must still report.
      //
      // Through the same encoder the panel's own probe uses. Writing the bare
      // key here would have overwritten a note that already carried its params
      // (`?host=…`) with one that does not, so a refresh of THIS page silently
      // degraded the other screen's diagnostic to a literal `{host}`.
      await options.store
        .recordTest(record.id, {
          at: testedAt,
          ok: outcome.ok,
          note: noteWithParams(outcome.messageKey, outcome.messageParams),
        })
        .catch(() => undefined);
      return {
        service: record.kind,
        state: outcome.ok ? "healthy" : "down",
        version: record.kind,
        checkedAt: testedAt,
        note: outcome.messageKey,
      };
    })().finally(() => inFlight.delete(record.id));

    inFlight.set(record.id, probe);
    return probe;
  }

  function fromStored(record: ConnectionRecord): ServiceHealth {
    return {
      service: record.kind,
      state: record.lastTestOk === true ? "healthy" : "down",
      version: record.kind,
      // The row's own timestamp, honestly: the screen must show when the
      // verdict was actually established, not when it was last read.
      checkedAt: record.lastTestedAt ?? "",
      note: record.lastTestNote,
    };
  }

  return {
    async services(): Promise<readonly ServiceHealth[]> {
      const at = now();
      const connections = await options.store.list();
      const rows: ServiceHealth[] = [];

      for (const family of FAMILIES) {
        // The default connection is THE answer for its family — it is the one
        // runs actually use. Without a default, the first enabled row stands
        // in, deterministically (the store lists ordered by id).
        const candidates = connections.filter(
          (record) => record.enabled && family.kinds.includes(record.kind),
        );
        const chosen = candidates.find((record) => record.isDefault) ?? candidates[0];

        if (chosen === undefined) {
          rows.push({
            service: family.service,
            state: "not_configured",
            version: family.service,
            checkedAt: at.toISOString(),
            note: "health.note.not_configured",
          });
          continue;
        }
        const row = await rowFor(chosen, at);
        // The family name is the stable row id the screen keys and labels by;
        // the kind survives in `version` so the operator can see WHICH
        // connection answered ("jira · jira_cloud").
        rows.push({ ...row, service: family.service });
      }
      return rows;
    },
  };
}

/**
 * One health surface from several readers, in order. Used to lay the
 * connection-backed rows beside the infrastructure probes without either side
 * learning the other exists — and `allSettled` on the reader level is not
 * needed: both inputs already isolate their own failures.
 */
export function compositeHealthReader(readers: readonly HealthReader[]): HealthReader {
  return {
    async services(): Promise<readonly ServiceHealth[]> {
      const all = await Promise.all(readers.map((reader) => reader.services()));
      return all.flat();
    },
  };
}
