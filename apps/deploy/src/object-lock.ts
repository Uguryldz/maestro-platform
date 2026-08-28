import { RETENTION_YEARS_DEFAULT } from "@maestro/storage";
import type { DeployEnv } from "./env.js";
import type { Profile } from "./profile.js";

/**
 * The WORM retention every storage driver is deployed with (M56/M57).
 *
 * ONE definition, read by both composition sites: `storageConfig` (the registry's
 * StoragePort) and `buildStorageSink` (the publish sink the `docx`/`pdf` targets
 * write through). They used to be wired separately and BOTH omitted objectLock,
 * which is why a completed analysis produced no attachment: the drivers refused
 * the locked put — correctly, per M57 fail-closed — and the fail-soft publish
 * path recorded "belge üretilemedi" instead of silently storing an unprotected
 * record. The fix is to configure the lock, never to stop asking for it.
 */

/**
 * Ten years, from M56 ("Audit + kanıt paketi saklama: **10 yıl**"). The same
 * number reaches the row through `contracts`' `EvidencePackageRow.retentionYears`
 * (default 10) and through `@maestro/storage`'s `RETENTION_YEARS_DEFAULT`, so a
 * document's stored retention and the evidence package that cites it agree.
 *
 * Not re-declared here as a literal: it is imported from the storage package so
 * the three cannot drift apart silently.
 */
export const RETENTION_YEARS = RETENTION_YEARS_DEFAULT;

/**
 * COMPLIANCE, from M57 ("s3-compat sürücüsüne `object_lock: compliance` konfigü").
 *
 * The stronger of the two S3 modes and the only one that means what a bank's
 * auditor reads it to mean: under GOVERNANCE a holder of the bypass permission
 * may shorten or lift the retention, under COMPLIANCE no one can — not the root
 * account, not for the duration. An evidence record that a privileged operator
 * can quietly delete is not evidence, so the platform does not offer the weaker
 * mode as a deployment default.
 */
export const OBJECT_LOCK_MODE = "COMPLIANCE" as const;

export interface ObjectLockConfig {
  readonly mode: typeof OBJECT_LOCK_MODE;
  readonly years: number;
}

/**
 * What every profile gets. It does not vary by profile TODAY and that is
 * deliberate rather than an oversight: dev and `analiz` write the same evidence
 * documents a bank's prod does, and a dev deployment whose retention is weaker
 * would exercise a different code path than the one being certified — the class
 * of bug where "it worked in dev" is precisely the problem.
 *
 * The function shape (rather than a bare constant) is what keeps a future
 * per-profile or per-institution override to one edit.
 */
export function objectLockConfig(_env: DeployEnv, _profile: Profile): ObjectLockConfig {
  return { mode: OBJECT_LOCK_MODE, years: RETENTION_YEARS };
}
