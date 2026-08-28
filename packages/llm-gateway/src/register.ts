import type { PortRegistry } from "@maestro/ports";
import { LLM_GATEWAY_DRIVER, LLM_PORT } from "./config.js";
import { createLlmGateway, type LlmGateway, type LlmGatewayDeps } from "./gateway.js";

/**
 * Register the gateway on the port registry (M44 clean-room DI): the core never
 * imports this module, the composition root calls this once. `DriverFactory` is
 * `(config: unknown) => P`, so runtime collaborators (SecretPort, fetch, clock,
 * agent runner) are bound here at registration time — see RAPOR.md request #3.
 */
export function registerLlmDrivers(registry: PortRegistry, deps: LlmGatewayDeps): void {
  registry.register<LlmGateway>(LLM_PORT, LLM_GATEWAY_DRIVER, (config) => createLlmGateway(config, deps));
}
