import { z } from "zod";

/**
 * Deployment profiles.
 *
 * A profile is the ONE place that answers "which driver serves which port".
 * It is data, not code: `wiring.ts` turns it into registrations, and
 * `assertProfileComplete` refuses a profile with a hole in it before a single
 * connection is opened (M6 fail-closed).
 *
 * WHAT A PROFILE IS ALLOWED TO DECIDE, since Dalga E: infrastructure only.
 *
 * A profile used to answer two different questions at once, and the second one
 * was never its business. "Where do secrets live" (Vault or the env file) and
 * "where do blobs live" (S3 or Postgres) are facts of the machine the stack was
 * installed on — nobody picks Vault from a web form, and the answer cannot
 * change without a redeploy. But "does this install write code" was ALSO a
 * profile answer, and that one is a per-ticket decision an operator makes in
 * the wizard: the same bank has "analyse this" tickets and "fix this bug"
 * tickets in one Jira project.
 *
 * The `analiz` profile expressed the second question by wiring `scm`, `ci` and
 * `scan` to drivers that REFUSE. The result was a product that offered "Hata
 * düzeltme" in the wizard, accepted the rule, started the run, wrote the
 * analysis, took a human's approval — and only then died at the engineering
 * step, because the server had been configured to be unable. The UI promised
 * what the deployment forbade, and no screen could see the contradiction.
 *
 * So the capability question left the profile entirely. `scm` is the real
 * GitHub driver, always; whether a given install can actually reach a
 * repository is now a question about a CONNECTION, which the wizard reads and
 * reports BEFORE the operator commits (`/onboarding/scm-connections`). `ci` and
 * `scan` stay honestly unconfigured until someone configures them — see
 * `stores/unavailable-ports.ts` for why "not configured yet" is a different
 * sentence from "this release does not do that".
 *
 * `work` LEFT FOR THE SAME REASON, and it left because deleting `analiz`
 * without moving it took a live site down. That profile was the only one naming
 * `jira-cloud`, so "which Jira instance is this" had been smuggled in as a side
 * effect of "what may this install do". With the profile gone the deployment
 * fell through to the Data Center driver and died at boot with
 * `JIRA_BASE_URL: the work port has no default instance` — a message that never
 * mentions Cloud, which is the axis that was actually wrong. Cloud vs Data
 * Center is a property of the Jira this install talks to, exactly the same
 * class of fact as which GitHub org, so it is DERIVED from which Jira URL was
 * configured (`workDriverFor`) instead of being named per profile.
 *
 * What is left is `prod` vs `dev`: Vault + S3 against env-file + Postgres.
 * Neither is a subset of the other — `dev` is not "prod with things missing",
 * it is a different set of infrastructure drivers, which is why the choice
 * stays explicit rather than a chain of `NODE_ENV` checks through the wiring.
 */

export const PROFILES = ["prod", "dev"] as const;
export type Profile = (typeof PROFILES)[number];

export const ProfileName = z.enum(PROFILES);

/**
 * The eight ports `@maestro/workflows`'s `PortSelection` demands, plus `ci`,
 * which only the BFF resolves (the worker never parses a build webhook).
 *
 * The keys are the worker's `PORT_NAMES` keys verbatim — `wiring.ts` builds a
 * `PortSelection` straight out of this, and `test/profile.test.ts` pins the two
 * key sets against each other so a port added upstream cannot be silently
 * dropped here.
 */
export const WORKER_PORT_KEYS = [
  "work",
  "scm",
  "llm",
  "scan",
  "storage",
  "secret",
  "notify",
  "publish",
] as const;
export type WorkerPortKey = (typeof WORKER_PORT_KEYS)[number];

/** Every port this deployment names a driver for. */
export const ALL_PORT_KEYS = [...WORKER_PORT_KEYS, "ci"] as const;
export type PortKey = (typeof ALL_PORT_KEYS)[number];

export type DriverMap = Readonly<Record<PortKey, string>>;

/**
 * Driver ids exactly as each package registers them. They are duplicated here
 * as literals for the same reason `@maestro/workflows` duplicates the port
 * names: naming a driver must not drag its package into this module's import
 * graph. `test/profile.test.ts` pins each id against the exporting package's
 * own constant, so a rename fails the suite rather than the deployment.
 */
/**
 * The driver id for a port that is WIRED but not yet CONFIGURED.
 *
 * `ci` and `scan` both need something an operator has to supply before they can
 * do anything — a build-definition allow-list (M12), a digest-pinned scanner
 * image (M27) — and neither has a default that would be safe to invent. Until
 * that arrives the port answers with a named, catchable "not configured yet"
 * (`stores/unavailable-ports.ts`), which is a different claim from "this
 * product cannot do that" and is fixed from a different place.
 *
 * The distinction matters because the old sentence sent operators the wrong
 * way. `scm` was wired to this same refusal and told them to change
 * `MAESTRO_PROFILE` — a deployment-time answer to what is now a connection
 * question. `scm` no longer uses it at all: the real GitHub driver is always
 * composed, and an install with no repository connection learns that in the
 * wizard, before it commits to a flow.
 */
export const NOT_CONFIGURED_DRIVER = "not-configured";

/** The two Jira drivers, as `@maestro/adapter-jira` registers them. */
export const JIRA_CLOUD_DRIVER = "jira-cloud";
export const JIRA_DC_DRIVER = "jira-dc";

/** What `workDriverFor` decided, and why — the reason travels for the error. */
export interface WorkDriverChoice {
  readonly driver: string;
  /** `null` when a real Jira was named; otherwise why no instance was chosen. */
  readonly problem: "both" | "neither" | null;
}

/**
 * Which Jira driver this installation talks to, derived from what it named.
 *
 * The two URLs are ALREADY the way this codebase distinguishes the instances —
 * `packages/config/src/env.ts` declares both as separately-blankable, and the
 * two drivers take different auth (`Bearer <PAT>` for Data Center, Basic
 * `email:token` for Cloud) against different API roots. So the fact is already
 * collected; it was simply never read as the answer. Reading it here means the
 * one thing an operator actually types decides the driver, and there is no
 * second switch that can disagree with it.
 *
 * `WORK_DRIVER` used to be that second switch, and it was worse than
 * redundant: the bank compose passed `${WORK_DRIVER:-jira-dc}`, so it MASKED
 * the profile on every bundle install, and `boot.ts` honoured it while
 * `compose.ts` did not — two code paths that could compose different Jira
 * clients from one environment. It is gone.
 *
 * The two degenerate answers are kept apart on purpose, because they need
 * different sentences:
 *
 *   both    → a conflict only the operator can settle. Guessing one would send
 *             a bank's tickets to whichever Jira the tie-break happened to
 *             favour, so this is refused BY NAME at boot.
 *   neither → a fresh install. It must still BOOT: the wizard is how a Jira
 *             gets configured, and a stack that refuses to start until it is
 *             configured can never be configured through its own panel. The
 *             port composes as the Cloud driver and fails on first USE with a
 *             named message, exactly like `ci`/`scan`.
 */
export function workDriverFor(source: Record<string, string | undefined>): WorkDriverChoice {
  const named = (name: string): boolean => (source[name] ?? "").trim() !== "";
  const cloud = named("JIRA_CLOUD_BASE_URL");
  const dc = named("JIRA_BASE_URL");
  if (cloud && dc) return { driver: JIRA_CLOUD_DRIVER, problem: "both" };
  if (cloud) return { driver: JIRA_CLOUD_DRIVER, problem: null };
  if (dc) return { driver: JIRA_DC_DRIVER, problem: null };
  return { driver: JIRA_CLOUD_DRIVER, problem: "neither" };
}

/**
 * The conflict, refused by name.
 *
 * Called where the port is actually built. The message names BOTH variables
 * and says what to do, because the operator who set both did so believing one
 * of them was inert — which is precisely the belief that makes a silent
 * tie-break dangerous.
 */
export function assertOneJiraInstance(source: Record<string, string | undefined>): void {
  if (workDriverFor(source).problem !== "both") return;
  throw new ProfileError(
    "JIRA_BASE_URL ve JIRA_CLOUD_BASE_URL birlikte tanımlı — bu ikisi İKİ AYRI Jira " +
      "sürücüsünü besler (Data Center `Bearer <PAT>`, Cloud `Basic e-posta:jeton`) ve " +
      "hangisinin kullanılacağı tahmin EDİLMEZ. Bu kurulumun konuştuğu Jira hangisiyse " +
      "yalnızca onun adresini bırakın, diğerini silin.",
  );
}

const PROD_DRIVERS: DriverMap = {
  // A placeholder, not a decision: the real answer is `workDriverFor`, which
  // reads the Jira URLs. It stays in the map because `assertProfileComplete`
  // demands every port name a driver, and `buildPortSelection` overwrites it.
  work: JIRA_DC_DRIVER,
  // The real driver, in both profiles and unconditionally. Whether this install
  // can reach a repository is decided by a Connection an admin adds in the UI,
  // never by which profile the machine was installed with.
  scm: "github",
  ci: NOT_CONFIGURED_DRIVER,
  llm: "gateway",
  scan: NOT_CONFIGURED_DRIVER,
  storage: "s3-compat",
  secret: "vault",
  notify: "multi",
  publish: "multi",
};

const DEV_DRIVERS: DriverMap = {
  // Same placeholder as above; `workDriverFor` is the answer.
  work: JIRA_DC_DRIVER,
  scm: "github",
  ci: NOT_CONFIGURED_DRIVER,
  llm: "gateway",
  scan: NOT_CONFIGURED_DRIVER,
  storage: "pg-blob",
  // No Vault in the dev stack: the env-file driver reads `MAESTRO_SECRET_*`.
  // The driver itself refuses to serve when NODE_ENV is production (M80), so
  // this choice cannot leak into a bank deployment by way of a stale profile.
  secret: "env-file",
  notify: "jira",
  publish: "multi",
};

export const PROFILE_DRIVERS: Readonly<Record<Profile, DriverMap>> = {
  prod: PROD_DRIVERS,
  dev: DEV_DRIVERS,
};

export function driversFor(profile: Profile): DriverMap {
  return PROFILE_DRIVERS[profile];
}

export class ProfileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProfileError";
  }
}

/**
 * Refuse a driver map with a missing or blank entry.
 *
 * The map is typed `Record<PortKey, string>`, so this can only fire on a value
 * that arrived at runtime — a profile built from configuration rather than from
 * the constants above. That is exactly the case worth guarding: a port left
 * `undefined` resolves to `registry.resolve(port, undefined)`, and the error a
 * developer would eventually see names the driver, not the port that has none.
 */
export function assertProfileComplete(drivers: DriverMap, profile: string): void {
  const missing = ALL_PORT_KEYS.filter((key) => {
    const driver: unknown = drivers[key];
    return typeof driver !== "string" || driver.trim() === "";
  });
  if (missing.length > 0) {
    throw new ProfileError(
      `profile "${profile}": no driver named for port(s) ${missing.join(", ")} — ` +
        "every port must be filled at composition time (M6/M44)",
    );
  }
}

/** Parse a profile name, naming the alternatives rather than just refusing. */
export function parseProfile(value: string | undefined): Profile {
  const parsed = ProfileName.safeParse(value);
  if (!parsed.success) {
    throw new ProfileError(
      `MAESTRO_PROFILE: "${value ?? "(unset)"}" is not a deployment profile — expected one of ${PROFILES.join(", ")}`,
    );
  }
  return parsed.data;
}
