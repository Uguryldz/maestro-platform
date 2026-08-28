export * from "./agent-protocol.js";
export * from "./agent-registry.js";
export * from "./config.js";
export * from "./deps.js";
export * from "./docker-runner.js";
export * from "./errors.js";
export * from "./http.js";
export * from "./pool.js";
export * from "./provision.js";
export * from "./register.js";
export * from "./sandbox.js";
export * from "./unix-transport.js";
export * from "./workspace.js";

/**
 * `DockerClient` is exported as a TYPE only, on purpose. It can create a
 * container from ANY spec, which means handing it to a caller would hand out a
 * way around the hardened profile this package exists to enforce (M23/M24) —
 * the same reasoning that keeps `VaultClient` type-only in `@maestro/secrets`.
 * Everything a composition root needs is reachable through
 * `registerRunnerDrivers` / `createDockerLinuxRunner` / `resolvePinnedImage`.
 */
export type { ContainerSpec, DockerClient, DockerClientOptions, StreamTails } from "./docker-client.js";
export { demultiplex, tail } from "./docker-client.js";
