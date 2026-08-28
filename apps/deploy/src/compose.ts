import type { CiPort, PortRegistry, SecretPort } from "@maestro/ports";
import { resolvePorts, type PortBundle, type PortSelection } from "@maestro/workflows";
import {
  adoConfig,
  githubConfig,
  jiraCloudConfig,
  jiraConfig,
  llmConfig,
  notifyConfig,
  publishConfig,
  scanConfig,
  secretConfig,
  storageConfig,
} from "./driver-config.js";
import type { DeployEnv } from "./env.js";
import {
  ALL_PORT_KEYS,
  assertOneJiraInstance,
  assertProfileComplete,
  driversFor,
  JIRA_CLOUD_DRIVER,
  NOT_CONFIGURED_DRIVER,
  workDriverFor,
  type DriverMap,
  type PortKey,
} from "./profile.js";

/**
 * The composition root's resolution half.
 *
 * `buildPortSelection` answers "which driver, built from which config, serves
 * which port" as one data structure; `resolveDeployment` turns it into live
 * instances and refuses to return a partial one. Between them there is no path
 * that yields an `undefined` port: `PortRegistry.resolve` throws for an unknown
 * driver, and `assertAllPortsPresent` throws for a driver that returned nothing.
 */

export interface DeploymentInputs {
  readonly env: DeployEnv;
  readonly registry: PortRegistry;
  readonly secrets: SecretPort;
  /** `s3-compat` signs with key material, so the values are resolved up front. */
  readonly s3Credentials?: { accessKeyId: string; secretAccessKey: string };
  /** `pg-blob` writes through this; the dev profile passes the Postgres client. */
  readonly sql?: unknown;
  readonly fetchImpl?: unknown;
  /**
   * The TLS-aware transport for the WORK adapters (`tlsAwareFetchWith` —
   * built by `bootPlatform`), so a Jira DC behind the bank's own CA is
   * dialled under the same skip rule the panel's probe tested green with.
   * Deliberately separate from `fetchImpl`, which belongs to the storage
   * driver: a test stubbing storage traffic must not hijack Jira's.
   */
  readonly workFetch?: unknown;
}

export interface PortChoice {
  readonly driver: string;
  readonly config: unknown;
}

/**
 * The full selection, including `ci` — which `@maestro/workflows`'s
 * `PortSelection` does not carry, because the worker never parses a build
 * webhook. The BFF does, so the deployment tracks it here and hands the worker
 * the eight keys it knows.
 */
export type DeploymentSelection = Readonly<Record<PortKey, PortChoice>>;

export function buildPortSelection(inputs: DeploymentInputs): DeploymentSelection {
  const { env, secrets } = inputs;
  const profile = env.profile;
  const drivers: DriverMap = driversFor(profile);
  assertProfileComplete(drivers, profile);

  // Both configs are built ONLY when a driver that reads them is selected.
  //
  // `adoConfig` demands `ADO_BASE_URL` and refuses without it — correct for a
  // deployment that opens pull requests, wrong for one whose scm/ci ports are
  // the refusing stubs of the analysis-only release. Building it unconditionally
  // made that release impossible to boot over a port nothing in it calls.
  //
  // Same for Jira: Cloud authenticates with an e-mail and an API token, Data
  // Center with a PAT, and asking for the Data Center shape while the Cloud
  // driver is selected fails on a variable the operator was right not to set.
  const usesAdo = drivers.scm === "ado" || drivers.ci === "ado";
  const ado = usesAdo ? adoConfig(env) : {};
  // Cloud or Data Center is a property of the Jira this install talks to, read
  // off the URL the operator named rather than off the profile — see
  // `workDriverFor`. Refused by name when both are set, because a tie-break
  // would silently point a bank's tickets at the wrong Jira.
  assertOneJiraInstance(env.source);
  const workChoice = workDriverFor(env.source);
  // A fresh install names no Jira. The port still composes — the wizard is how
  // one is configured, so boot cannot demand it — and refuses on first use.
  const workDriver = workChoice.problem === "neither" ? NOT_CONFIGURED_DRIVER : workChoice.driver;
  const work =
    workChoice.problem === "neither"
      ? {}
      : workDriver === JIRA_CLOUD_DRIVER
        ? jiraCloudConfig(env, secrets, inputs.workFetch)
        : jiraConfig(env, secrets, inputs.workFetch);
  // The scm port is GitHub by default and ADO only where a deployment says so.
  // `githubConfig` demands nothing of the operator (see it for why), which is
  // what lets the engineering ports COMPOSE on an install that has not been
  // pointed at a repository yet — the wizard, not the boot sequence, is where
  // that gap is supposed to be reported.
  const scmConfig = drivers.scm === "github" ? githubConfig(env) : ado;
  return {
    work: { driver: workDriver, config: work },
    scm: { driver: drivers.scm, config: scmConfig },
    ci: { driver: drivers.ci, config: ado },
    llm: { driver: drivers.llm, config: llmConfig(env) },
    scan: { driver: drivers.scan, config: scanConfig(env, drivers.scan) },
    storage: {
      driver: drivers.storage,
      config: storageConfig(env, profile, inputs.s3Credentials, inputs.sql, inputs.fetchImpl),
    },
    secret: { driver: drivers.secret, config: secretConfig(env, profile, { secrets }) },
    notify: { driver: drivers.notify, config: notifyConfig(profile) },
    publish: { driver: drivers.publish, config: publishConfig(profile) },
  };
}

/** The eight keys `@maestro/workflows` resolves, projected out of the selection. */
export function workerSelection(selection: DeploymentSelection): PortSelection {
  const { ci: _ci, ...rest } = selection;
  return rest;
}

export class CompositionError extends Error {
  /**
   * The cause is kept as a property rather than passed to `Error`'s options
   * bag: `lib` is ES2023 here and the two-argument constructor is not in the
   * type surface, so this is the portable way to keep the original driver
   * error attached for a debugger without stringifying it into the message.
   */
  constructor(
    message: string,
    readonly reason?: unknown,
  ) {
    super(message);
    this.name = "CompositionError";
  }
}

export interface Deployment {
  readonly ports: PortBundle;
  /** Only the BFF uses it: build results arrive on an HTTP endpoint, not a task queue. */
  readonly ci: CiPort;
  readonly selection: DeploymentSelection;
  readonly registry: PortRegistry;
}

/**
 * Build every port, or throw.
 *
 * This is the moment a misconfigured deployment is supposed to die. A driver
 * that cannot be built — a bad URL, a missing allow-list, an unreachable
 * secret mount — throws out of its own factory, and the error travels up with
 * the port name attached rather than surfacing three hours later as a null
 * dereference in the middle of a ticket.
 */
export function resolveDeployment(inputs: DeploymentInputs): Deployment {
  const selection = buildPortSelection(inputs);
  const registry = inputs.registry;

  const ports = attribute("the worker port bundle", () =>
    resolvePorts(registry, workerSelection(selection)),
  );
  const ci = attribute("ci", () =>
    registry.resolve<CiPort>("ci", selection.ci.driver)(selection.ci.config),
  );

  assertAllPortsPresent(ports, ci);
  return { ports, ci, selection, registry };
}

/**
 * Name the port in the failure.
 *
 * `resolvePorts` builds eight drivers in one call and a Zod error out of one of
 * them says only "baseUrl: invalid url" — true, and useless when the operator
 * has three base URLs configured. Wrapping keeps the cause intact (it is the
 * cause, not a stringified copy) while stating which port was being built.
 */
function attribute<T>(what: string, build: () => T): T {
  try {
    return build();
  } catch (cause) {
    throw new CompositionError(`failed to build ${what}: ${messageOf(cause)}`, cause);
  }
}

function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The explicit guard against a silently undefined port.
 *
 * `PortRegistry.resolve` already throws for an unknown driver, so this cannot
 * fire on a typo'd driver name. What it catches is the other half: a
 * registered factory that returns `undefined` (or a stub that lost a method in
 * a refactor). A port object that exists but cannot do anything is worse than
 * a missing one, because it fails at the first ticket rather than at boot.
 */
export function assertAllPortsPresent(ports: PortBundle, ci: CiPort): void {
  const built: Record<string, unknown> = { ...ports, ci };
  const empty = ALL_PORT_KEYS.filter((key) => {
    // `PortBundle` calls the secret port `secrets`; the selection calls it
    // `secret`. Map the one difference rather than renaming a frozen interface.
    const value = built[key === "secret" ? "secrets" : key];
    return value === undefined || value === null || typeof value !== "object";
  });
  if (empty.length > 0) {
    throw new CompositionError(
      `port(s) ${empty.join(", ")} resolved to nothing — a registered driver returned no instance (M6/M44)`,
    );
  }
}

/**
 * What got wired, for the boot log.
 *
 * Config is deliberately NOT included. It holds resolved S3 key material in
 * the prod profile, and a boot log is the last place a credential should be
 * recoverable from — the sandbox round found exactly that shape of leak.
 */
export function describeWiring(selection: DeploymentSelection): { port: string; driver: string }[] {
  return ALL_PORT_KEYS.map((port) => ({ port, driver: selection[port].driver }));
}
