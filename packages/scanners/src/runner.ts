/**
 * Container execution seam. The scanners never shell out themselves: they hand
 * a fully-formed request to an injected runner, which keeps every test offline
 * and deterministic. `@maestro/runners` is expected to supply the production
 * implementation; `RunnerPort.runSession` is deliberately NOT reused because it
 * carries no image field and returns stdout TAILS — neither can express "run
 * this digest-pinned image and give me its complete report" (RAPOR.md).
 */
export interface ContainerRunRequest {
  /** Digest-pinned reference; already validated by the driver (M27). */
  image: string;
  /** Full command line. The runner must override the image entrypoint. */
  argv: readonly string[];
  /** Host path of the workspace to scan. */ workspacePath: string;
  /** Where it appears inside the container — mounted read-only. */ workspaceMountPath: string;
  network: "none" | "internal";
  timeoutSeconds: number;
  env: Readonly<Record<string, string>>;
}

export interface ContainerRunOutput {
  exitCode: number;
  /** Complete stdout. A truncated report is a parse error, never a pass. */
  stdout: string;
  stderr: string;
  /** The runner killed the container at `timeoutSeconds`. */ timedOut: boolean;
}

export interface ContainerRunner {
  run(request: ContainerRunRequest): Promise<ContainerRunOutput>;
}

/** Injected so `startedAt`/`finishedAt` are deterministic in tests. */
export type Clock = () => Date;

export const systemClock: Clock = () => new Date();
