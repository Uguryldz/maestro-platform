import type { Profile } from "../profile.js";

/**
 * Which BFF stores are allowed to be process-local, and in which profile.
 *
 * Some of `BffDeps` is in-memory today because the Postgres implementation does
 * not exist yet. That is a known gap, and for most of these stores it is a
 * tolerable one — a dropped session means a re-login. For the kill switch it is
 * not, and the difference is worth naming precisely, because the two look
 * identical in a dependency list and are not the same kind of missing.
 *
 * The kill switch is the platform's emergency brake (M58). `InMemoryKillSwitchStore`
 * starts at `KILL_SWITCH_OFF`, and the `bff` service runs under
 * `restart: unless-stopped`. Compose those two facts: an operator sets the
 * switch to `all` during an incident, the container restarts for any reason at
 * all, and the brake is RELEASED — silently, with the write paths open again
 * and nothing in the operator's face to say so. "The platform is stopped" would
 * be a belief, not a fact, at exactly the moment it has to be a fact.
 *
 * The rest of this composition root already refuses rather than guesses: the
 * twelve read models refuse by name instead of rendering an empty page, because
 * "nothing found" and "nothing wired" are the same lie in different shapes.
 * `unbridgedReadModels` got that care and the kill switch did not. This module
 * applies the same rule to it — and the rule is the stricter one, because a read
 * model that lies makes a screen wrong while a kill switch that lies makes a
 * stopped platform keep working.
 *
 * So: in the `prod` profile a non-durable kill switch is a boot failure, named,
 * before the socket opens. In `dev` it is allowed and SAID OUT LOUD at boot,
 * because the offline stack has no Postgres store to point at and an operator
 * running it should still know the brake will not survive a restart.
 *
 * Dalga E update: the composition root now supplies a DURABLE kill switch
 * (`PrismaKillSwitchStore` over the `KillSwitch` table) and durable sessions, so
 * neither appears in its `VOLATILE_STORES` any more and this guard passes for
 * them. The machinery below is UNCHANGED on purpose — `FATAL_IF_VOLATILE` still
 * names the kill switch, so a future regression that fed a volatile one back in
 * would still be refused at boot. The guard did not stop being needed; the
 * deployment stopped tripping it.
 */

/** A store the BFF composition root supplies, and whether it survives a restart. */
export interface StoreDurability {
  readonly name: string;
  readonly durable: boolean;
  /** What a restart costs, in the operator's words. */
  readonly onRestart: string;
}

/**
 * Stores that must be durable before this deployment may serve a bank.
 *
 * Only the kill switch is fatal. `params` is listed as a warning rather than a
 * refusal: losing M71 parameters and pending four-eyes proposals on restart is
 * bad and it is recoverable — the definitions carry defaults and a proposal can
 * be filed again. Losing the kill switch is not recoverable by re-doing it,
 * because nobody is told it needs re-doing.
 */
export const FATAL_IF_VOLATILE = ["killSwitch"] as const;

export class DurabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DurabilityError";
  }
}

/**
 * Refuse a production boot whose emergency brake cannot survive a restart.
 *
 * Called before the server listens, so the failure is a start-up failure an
 * operator sees rather than a property nobody discovers until the incident
 * that needed the switch. The message names the store and says what the
 * deployment must supply, in the same shape `unbridgedReadModels` uses.
 */
export function assertStoresDurable(
  profile: Profile,
  stores: readonly StoreDurability[],
): void {
  const volatile = stores.filter(
    (store) => !store.durable && (FATAL_IF_VOLATILE as readonly string[]).includes(store.name),
  );
  if (volatile.length === 0) return;

  if (profile !== "prod") return;

  const detail = volatile
    .map((store) => `${store.name} (in-memory — ${store.onRestart})`)
    .join("; ");
  throw new DurabilityError(
    `profile "prod": refusing to start — ${detail}. The kill switch is the platform's ` +
      "emergency brake (M58) and this process runs under `restart: unless-stopped`, so a " +
      "process-local switch means a restart RELEASES the brake with nobody told. A store " +
      "that silently reverts to `off` is worse than no switch, because the operator " +
      "believes the platform is stopped. Supply a durable KillSwitchStore (Postgres) or " +
      "run the dev profile, which permits this and says so at boot.",
  );
}

/**
 * The line the dev profile prints instead of refusing.
 *
 * A warning rather than silence: the dev stack legitimately has no Postgres
 * kill-switch store, but an operator testing an incident drill on it must not
 * conclude from a successful `stop_all` that the same thing would hold in
 * production.
 */
export function volatileStoreWarning(stores: readonly StoreDurability[]): string | null {
  const volatile = stores.filter((store) => !store.durable);
  if (volatile.length === 0) return null;
  const rows = volatile.map((store) => `    ${store.name.padEnd(12)} → ${store.onRestart}`);
  return (
    "[maestro] WARNING: these stores are process-local and do NOT survive a restart:\n" +
    `${rows.join("\n")}\n` +
    "[maestro] the kill switch among them means a restart releases the brake — dev profile only"
  );
}
