import type { PortRegistry, RunnerPort } from "@maestro/ports";
import { DEFAULT_API_VERSION, DOCKER_LINUX_DRIVER, DockerRunnerConfig, RUNNER_PORT } from "./config.js";
import type { AuditSink, Clock, DockerTransport, IdSource, Timer } from "./deps.js";
import { DockerClient } from "./docker-client.js";
import { DockerLinuxRunner } from "./docker-runner.js";
import { RunnerConfigError } from "./errors.js";
import { createUnixSocketTransport } from "./unix-transport.js";

/**
 * M44 clean-room DI: the core resolves `RunnerPort` by driver name and never
 * imports this module. Runtime collaborators arrive as the second argument —
 * `registerRunnerDrivers(registry, deps)` — because a declarative config
 * cannot carry a socket, a clock or an audit sink.
 */
export interface RunnerDeps {
  /**
   * Byte pipe to the Docker daemon. Omitted in production, where the driver
   * opens the configured unix socket itself; injected by every test, which is
   * why the default suite never touches Docker.
   */
  transport?: DockerTransport;
  clock?: Clock;
  timer?: Timer;
  newId?: IdSource;
  audit?: AuditSink;
}

export function createDockerLinuxRunner(input: unknown, deps: RunnerDeps = {}): DockerLinuxRunner {
  const parsed = DockerRunnerConfig.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new RunnerConfigError(`${DOCKER_LINUX_DRIVER}: ${issues}`);
  }
  const config = parsed.data;
  const transport = deps.transport ?? createUnixSocketTransport(config.socketPath);
  return new DockerLinuxRunner(config, { ...deps, transport });
}

export function registerRunnerDrivers(registry: PortRegistry, deps: RunnerDeps = {}): void {
  registry.register<RunnerPort>(RUNNER_PORT, DOCKER_LINUX_DRIVER, (config) => createDockerLinuxRunner(config, deps));
}

/**
 * Turns a mutable reference (`node:22-alpine`) into the content-addressed one
 * the config demands (M27). Deployment tooling calls this once and writes the
 * result into the config; the driver itself never resolves a tag, because a
 * tag resolved at run time is exactly the moving target digest pinning exists
 * to remove.
 */
export async function resolvePinnedImage(
  reference: string,
  options: { transport: DockerTransport; apiVersion?: string; requestTimeoutMs?: number },
): Promise<string> {
  const client = new DockerClient({
    transport: options.transport,
    apiVersion: options.apiVersion ?? DEFAULT_API_VERSION,
    requestTimeoutMs: options.requestTimeoutMs ?? 30_000,
  });
  const image = await client.inspectImage(reference);
  return image.repoDigests[0] ?? image.id;
}
