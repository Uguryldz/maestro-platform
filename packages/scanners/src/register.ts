import type { ScanTool } from "@maestro/contracts";
import type { PortRegistry } from "@maestro/ports";
import { CORE_SCAN_TOOLS, ContainerScanConfig, SCAN_PORT, type CoreScanTool } from "./config.js";
import { ContainerScanPort } from "./container-driver.js";
import { ScanConfigError } from "./errors.js";
import { createFortifyScanPort } from "./optional/fortify.js";
import { depsOf, parseConfig, type FetchLike } from "./optional/http-scan.js";
import { createSonarQubeScanPort } from "./optional/sonarqube.js";
import { createXrayScanPort } from "./optional/xray.js";
import type { Clock, ContainerRunner } from "./runner.js";
import { TOOL_SPECS } from "./tools.js";

/** Runtime collaborators config cannot carry (M44); a config-level `deps` wins. */
export interface ScanDeps {
  /** Required by the container drivers — this package never spawns a process. */
  runner?: ContainerRunner;
  clock?: Clock;
  /** Optional org drivers (M77). */
  fetchImpl?: FetchLike;
  tokens?: Partial<Record<ScanTool, string>>;
}

export function createContainerScanPort(
  tool: CoreScanTool,
  input: unknown,
  deps: ScanDeps = {},
): ContainerScanPort {
  const merged: ScanDeps = { ...deps, ...depsOf<ScanDeps>(input) };
  const config = parseConfig(tool, ContainerScanConfig, input);
  if (!merged.runner) throw new ScanConfigError(`${tool}: deps.runner is required — scanners only run through an injected runner`);
  return new ContainerScanPort({ spec: TOOL_SPECS[tool], config, runner: merged.runner, clock: merged.clock });
}

/**
 * Register every ScanPort driver (M44 clean-room DI): the mandatory trio (M27)
 * plus the optional org drivers (M77). The optional factories throw
 * `CapabilityNotSupportedError` until configured, so registering promises nothing.
 */
export function registerScanDrivers(registry: PortRegistry, deps: ScanDeps = {}): void {
  for (const tool of CORE_SCAN_TOOLS) {
    registry.register(SCAN_PORT, tool, (config) => createContainerScanPort(tool, config, deps));
  }
  registry.register(SCAN_PORT, "fortify", (config) =>
    createFortifyScanPort(config, { token: deps.tokens?.fortify, fetchImpl: deps.fetchImpl, clock: deps.clock }),
  );
  registry.register(SCAN_PORT, "sonarqube", (config) =>
    createSonarQubeScanPort(config, { token: deps.tokens?.sonarqube, fetchImpl: deps.fetchImpl, clock: deps.clock }),
  );
  registry.register(SCAN_PORT, "xray", (config) => createXrayScanPort(config));
}
