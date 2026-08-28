import { registerAdoDrivers } from "@maestro/adapter-ado";
import { registerGithubDrivers } from "@maestro/adapter-github";
import { registerJiraDrivers } from "@maestro/adapter-jira";
import { registerLlmDrivers } from "@maestro/llm-gateway";
import { registerNotifyDrivers } from "@maestro/notify";
import { PortRegistry, type CiPort, type ScanPort, type SecretPort, type WorkPort } from "@maestro/ports";
import { registerPublishDrivers } from "@maestro/publish";
import { registerScanDrivers } from "@maestro/scanners";
import { registerRunnerDrivers } from "@maestro/runners";
import { registerSecretDrivers } from "@maestro/secrets";
import { registerStorageDrivers } from "@maestro/storage";
import { NOT_CONFIGURED_DRIVER } from "./profile.js";
import { notConfiguredCiPort, notConfiguredScanPort, notConfiguredWorkPort } from "./stores/unavailable-ports.js";
import type { PublishDeps } from "@maestro/publish";
import type { ScanDeps } from "@maestro/scanners";
import type { NotifyDeps } from "@maestro/notify";
import type { LlmGatewayDeps } from "@maestro/llm-gateway";

/**
 * THE composition root's registration half (M44).
 *
 * This module — and only this module — imports driver packages. Everything
 * under `packages/*` resolves its collaborators by port name through the
 * `PortRegistry`; the import list above is the complete, auditable set of
 * concrete technologies this platform can speak to.
 *
 * Registration is split from resolution on purpose. Registering a driver
 * promises nothing: it says "this deployment CAN speak S3", not "this
 * deployment uses S3". The profile decides which of them is actually built,
 * and `resolveDeployment` is where a wrong answer becomes a startup failure.
 */

/**
 * Collaborators no declarative config can carry. Each corresponds to a `deps`
 * parameter one of the `register*` functions demands; grouping them here keeps
 * the call site below a flat list rather than ten ad-hoc object literals.
 */
export interface RegistrationDeps {
  /**
   * Resolves secret REFERENCES for the drivers that need a value at call time
   * (Jira's PAT, ADO's PAT and webhook secret). Built first — the secret port
   * is the one driver that cannot be resolved through the registry, because
   * everything else needs it to exist already.
   */
  readonly secrets: SecretPort;
  /**
   * The work port, built before this registry (see `bootPlatform`). Two
   * drivers register ON TOP of another port rather than on a driver:
   * `notify/jira` and `publish/jira` both post through it, and both demand it
   * at registration time.
   */
  readonly work: WorkPort;
  readonly llm: LlmGatewayDeps;
  readonly notify: NotifyDeps;
  readonly publish: PublishDeps;
  readonly scan: ScanDeps;
  /**
   * The TLS-aware transport for the SCM/CI adapters (ado, github) —
   * `tlsAwareFetchWith`, built by `bootPlatform`. An Azure DevOps Server or
   * GitHub Enterprise behind the bank's own CA is then dialled under the same
   * skip rule the panel's connection probe tested green with (the internal-
   * address auto rule plus the per-connection `skipTlsVerify` switch).
   * Absent, the adapters keep the global fetch exactly as before.
   */
  readonly workFetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

/**
 * Build the registry every service shares.
 *
 * The order is not arbitrary: `registerSecretDrivers` comes first because the
 * secret port is what the caller had to resolve to build `deps.secrets` at all,
 * and registering it here means the same registry can answer for it later
 * (`PortSelection` includes `secret`, and the worker resolves it like any
 * other port rather than being handed a privileged instance).
 */
export function buildRegistry(deps: RegistrationDeps): PortRegistry {
  const registry = new PortRegistry();

  registerSecretDrivers(registry);
  registerJiraDrivers(registry);
  registerAdoDrivers(registry, {
    // The ADO package deliberately takes callbacks rather than a SecretPort,
    // so that it never imports `@maestro/secrets`. Binding them is this
    // module's job (M44/M80).
    resolveToken: (tokenRef) => deps.secrets.get(tokenRef),
    issueSecret: (scope, ttlSeconds) => deps.secrets.issueShortLived(scope, ttlSeconds),
    // The TLS-aware transport (see `RegistrationDeps.workFetch`) — bound here
    // for the same layering reason as the secret callbacks: the adapter must
    // not know where the rule comes from.
    ...(deps.workFetch === undefined ? {} : { fetch: deps.workFetch }),
  });
  // GitHub speaks the `scm` port for every deployment (see `profile.ts`). Same
  // callback shape as ADO and for the same reason: the adapter must not import
  // `@maestro/secrets`, so binding the SecretPort is this module's job
  // (M44/M80). `resolveToken` is called lazily — at the first API call, not at
  // registration — which is what lets a deployment with no GitHub credential
  // boot and run the analysis line.
  registerGithubDrivers(registry, {
    resolveToken: (tokenRef) => deps.secrets.get(tokenRef),
    issueSecret: (scope, ttlSeconds) => deps.secrets.issueShortLived(scope, ttlSeconds),
    // Same TLS-aware transport as ADO: a GitHub Enterprise Server behind the
    // corporate CA hits the identical wall, and the rule must not differ by
    // vendor. Cloud github.com never matches the skip rule, so it is inert
    // for the default deployment.
    ...(deps.workFetch === undefined ? {} : { fetch: deps.workFetch }),
  });
  registerStorageDrivers(registry);
  registerLlmDrivers(registry, deps.llm);
  registerNotifyDrivers(registry, deps.notify);
  registerPublishDrivers(registry, deps.publish);
  registerScanDrivers(registry, deps.scan);
  registerRunnerDrivers(registry);

  // `ci` and `scan` when nothing has configured them yet: every method rejects
  // with a named, catchable error. Registered here next to the real drivers,
  // because a port with no driver at all is refused by `assertProfileComplete`
  // before boot — see `stores/unavailable-ports.ts` for why a port that says
  // "not configured" beats one that is simply absent.
  //
  // There is deliberately NO entry for `scm`. It used to have one, and that is
  // what made a deployment decide whether the product could write code at all:
  // the wizard offered "Hata düzeltme", the run reached the engineering step,
  // and the port refused because of a profile string. The GitHub driver
  // registered above is now the answer for every deployment, and the question
  // "can this install actually reach a repository" belongs to the connection
  // an admin adds in the UI.
  //
  // `work` joins them for a narrower reason: a fresh stack has named no Jira
  // yet, and it must still boot — the wizard is how a Jira gets configured, so
  // a process that refused to start without one could never be configured
  // through its own panel. Which Jira driver a CONFIGURED install uses is
  // derived from its URLs (`workDriverFor`), never from this entry.
  registry.register<WorkPort>("work", NOT_CONFIGURED_DRIVER, () => notConfiguredWorkPort());
  registry.register<CiPort>("ci", NOT_CONFIGURED_DRIVER, () => notConfiguredCiPort());
  registry.register<ScanPort>("scan", NOT_CONFIGURED_DRIVER, () => notConfiguredScanPort());

  return registry;
}
