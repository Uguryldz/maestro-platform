import type { ScanResult, ScanTool } from "@maestro/contracts";

export interface ScanTarget {
  workspacePath: string;
  diffBaseRef?: string;
}

/**
 * Scan port (M27 fail-closed / M77 optional org drivers). A driver error is
 * an "error" outcome — the workflow treats it as blocking, never skips.
 */
export interface ScanPort {
  run(tool: ScanTool, target: ScanTarget): Promise<ScanResult>;
}
