import { CapabilityNotSupportedError, type ScanPort } from "@maestro/ports";
import { SCAN_PORT } from "../config.js";

/**
 * Xray placeholder (M77) — unresolved on purpose. M77 lists Xray under TEST
 * MANAGEMENT ("Xray/Zephyr") while `ScanTool` lists `xray` as a scanner, which
 * reads like JFrog Xray; the two products share nothing but the name. Guessing
 * a client would produce an integration that can return `pass` without ever
 * having scanned — the one thing M27 forbids. So the factory refuses whether or
 * not configuration is supplied, until the orchestrator decides (RAPOR.md).
 */
export function createXrayScanPort(_input?: unknown): ScanPort {
  throw new CapabilityNotSupportedError(SCAN_PORT, "xray");
}
