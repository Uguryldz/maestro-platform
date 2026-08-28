import type { PortRegistry, SecretPort } from "@maestro/ports";
import type { FetchLike } from "./client.js";
import { JIRA_CLOUD_DRIVER, JiraCloudConfig } from "./cloud/config.js";
import { JiraCloudWorkPort } from "./cloud/work-port.js";
import { JIRA_DC_DRIVER, JiraDcConfig, WORK_PORT } from "./config.js";
import { JiraConfigError } from "./errors.js";
import { JiraDcWorkPort } from "./work-port.js";

/**
 * Runtime collaborators the factory cannot get from declarative config.
 * DriverFactory is `(config: unknown) => P`, so the composition root passes
 * them inside the same object under `deps` (see RAPOR.md — interface request).
 */
export interface JiraDcDeps {
  secrets: SecretPort;
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

export interface JiraDcDriverInput extends Record<string, unknown> {
  deps: JiraDcDeps;
}

/** Build a driver instance from a validated config object plus deps. */
export function createJiraDcWorkPort(input: unknown): JiraDcWorkPort {
  const parsed = JiraDcConfig.safeParse(input);
  if (!parsed.success) {
    throw new JiraConfigError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const config = parsed.data;
  const deps = extractDeps(input);

  return new JiraDcWorkPort({
    config,
    token: () => deps.secrets.get(config.tokenRef),
    webhookSecret: () => deps.secrets.get(config.webhookSecretRef),
    fetchImpl: deps.fetchImpl,
    sleep: deps.sleep,
  });
}

/**
 * Build a Cloud driver instance from a validated config object plus deps.
 * No sleep: the Cloud client never retries in-process.
 *
 * `webhookSecretRef` is passed through only when the deployment declared one.
 * A Cloud site with no registered webhook has no secret, and handing the driver
 * a resolver for a reference that does not exist would turn a missing
 * configuration into a SecretPort error at delivery time. Leaving it absent
 * makes the driver refuse such a delivery by name (`missing_secret`) instead.
 */
export function createJiraCloudWorkPort(input: unknown): JiraCloudWorkPort {
  const parsed = JiraCloudConfig.safeParse(input);
  if (!parsed.success) {
    throw new JiraConfigError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  }
  const config = parsed.data;
  const deps = extractDeps(input);
  const webhookSecretRef = config.webhookSecretRef;

  return new JiraCloudWorkPort({
    config,
    token: () => deps.secrets.get(config.apiTokenRef),
    ...(webhookSecretRef === undefined ? {} : { webhookSecret: () => deps.secrets.get(webhookSecretRef) }),
    fetchImpl: deps.fetchImpl,
  });
}

function extractDeps(input: unknown): JiraDcDeps {
  const deps = (input as { deps?: unknown } | null)?.deps;
  const secrets = (deps as { secrets?: unknown } | undefined)?.secrets;
  if (typeof secrets !== "object" || secrets === null || typeof (secrets as SecretPort).get !== "function") {
    throw new JiraConfigError("deps.secrets (SecretPort) is required to resolve tokenRef/webhookSecretRef");
  }
  return deps as JiraDcDeps;
}

/**
 * Register the Jira drivers on the port registry (M44 clean-room DI): the
 * core never imports this module, the composition root calls this once.
 */
export function registerJiraDrivers(registry: PortRegistry): void {
  registry.register(WORK_PORT, JIRA_DC_DRIVER, createJiraDcWorkPort);
  registry.register(WORK_PORT, JIRA_CLOUD_DRIVER, createJiraCloudWorkPort);
}
