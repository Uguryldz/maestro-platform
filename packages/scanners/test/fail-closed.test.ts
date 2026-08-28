import { ScanResult, isScanBlocking } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { SCAN_ERROR_RULE_ID, WRAPPER_EXIT, createContainerScanPort, scanGateDecision } from "../src/index.js";
import { WORKSPACE, configFor, fakeClock, fixture, stubRunner } from "./helpers.js";
import type { ContainerRunOutput } from "../src/index.js";

/**
 * M27 is the reason this package exists: a security scan that did not produce a
 * trustworthy verdict must stop the flow. Every case below is a way a scan can
 * go wrong; every one of them must end as `error`, and `error` must block.
 */
function portFor(output: Partial<ContainerRunOutput> | Error, overrides = {}) {
  const stub = stubRunner(output);
  return createContainerScanPort("gitleaks", configFor("gitleaks", overrides), {
    runner: stub.runner,
    clock: fakeClock(),
  });
}

const FAILURES: [string, Partial<ContainerRunOutput> | Error][] = [
  ["the runner throws (image cannot be pulled)", new Error("no such image: manifest unknown")],
  ["the container times out", { timedOut: true, stdout: "[]" }],
  ["the tool crashes with its error exit code", { exitCode: 2, stderr: "fatal: unable to read repo" }],
  ["the tool crashes but still prints a clean report", { exitCode: 2, stdout: "[]" }],
  ["the tool exits with an unknown code", { exitCode: 137, stdout: "[]" }],
  ["stdout is empty", { exitCode: 0, stdout: "" }],
  ["stdout is not JSON", { exitCode: 0, stdout: "gitleaks: command not found" }],
  ["stdout is truncated JSON", { exitCode: 0, stdout: '[{"RuleID":"aws-acce' }],
  ["the report does not match the tool's schema", { exitCode: 0, stdout: '[{"File":"a.ts"}]' }],
  ["the runner returns something unusable", { exitCode: undefined as unknown as number }],
  ["the workspace mount is missing inside the container", { exitCode: WRAPPER_EXIT.missingWorkspace, stdout: "" }],
  ["the workspace mount is empty inside the container", { exitCode: WRAPPER_EXIT.emptyWorkspace, stdout: "" }],
  ["the tool wrote no report file", { exitCode: WRAPPER_EXIT.missingReport, stdout: "" }],
];

describe("fail-closed: every failure blocks (M27)", () => {
  for (const [name, output] of FAILURES) {
    it(`errors and blocks when ${name}`, async () => {
      const result = await portFor(output).run("gitleaks", WORKSPACE);

      expect(result.outcome).toBe("error");
      expect(isScanBlocking(result.outcome)).toBe(true);
      expect(ScanResult.safeParse(result).success).toBe(true);
    });
  }

  it("never throws out of run() — the caller cannot mistake a crash for a skip", async () => {
    for (const [, output] of FAILURES) {
      await expect(portFor(output).run("gitleaks", WORKSPACE)).resolves.toBeDefined();
    }
  });

  it("carries the reason as a namespaced finding, so the error is visible in evidence", async () => {
    const result = await portFor({ timedOut: true }).run("gitleaks", WORKSPACE);

    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.ruleId).toBe(SCAN_ERROR_RULE_ID);
    expect(result.findings[0]?.severity).toBe("critical");
    expect(result.findings[0]?.message).toMatch(/timed out/);
  });

  it("keeps tool stderr out of the result unless explicitly opted in", async () => {
    const secretish = "line: token=hunter2-not-a-real-secret";
    const quiet = await portFor({ exitCode: 2, stderr: secretish }).run("gitleaks", WORKSPACE);
    const loud = await portFor({ exitCode: 2, stderr: secretish }, { includeStderrInError: true }).run(
      "gitleaks",
      WORKSPACE,
    );

    expect(JSON.stringify(quiet)).not.toContain("hunter2");
    expect(JSON.stringify(loud)).toContain("hunter2");
  });

  it("errors when a driver is asked to run another tool", async () => {
    const result = await portFor({ stdout: "[]" }).run("trivy", WORKSPACE);

    expect(result.outcome).toBe("error");
    expect(result.findings[0]?.message).toMatch(/wired for "gitleaks"/);
  });

  it("errors on an empty workspace path instead of scanning nothing", async () => {
    const result = await portFor({ stdout: "[]" }).run("gitleaks", { workspacePath: "  " });

    expect(result.outcome).toBe("error");
  });

  it("errors on a relative workspace path, which resolves against nothing in particular", async () => {
    const result = await portFor({ stdout: "[]" }).run("gitleaks", { workspacePath: "ws/UGURPAY-500" });

    expect(result.outcome).toBe("error");
    expect(result.findings[0]?.message).toMatch(/not an absolute path/);
  });

  it("errors — never passes — when a tool scanned an empty workspace (B3)", async () => {
    // These are live captures against an empty mount: exit 0, zero findings.
    const semgrepStub = stubRunner({ exitCode: 0, stdout: fixture("semgrep-empty-workspace") });
    const semgrep = createContainerScanPort("semgrep", configFor("semgrep"), {
      runner: semgrepStub.runner, clock: fakeClock(),
    });
    const trivyStub = stubRunner({ exitCode: 0, stdout: JSON.stringify({ SchemaVersion: 2, ArtifactName: "/elsewhere" }) });
    const trivy = createContainerScanPort("trivy", configFor("trivy"), {
      runner: trivyStub.runner, clock: fakeClock(),
    });

    expect((await semgrep.run("semgrep", WORKSPACE)).outcome).toBe("error");
    expect((await trivy.run("trivy", WORKSPACE)).outcome).toBe("error");
  });

  it("still returns a result when the injected clock itself throws (B13)", async () => {
    const stub = stubRunner({ stdout: "[]" });
    const port = createContainerScanPort("gitleaks", configFor("gitleaks"), {
      runner: stub.runner,
      clock: () => {
        throw new Error("clock skew guard tripped");
      },
    });

    const result = await port.run("gitleaks", WORKSPACE);

    expect(result.outcome).toBe("error");
    expect(result.findings[0]?.message).toMatch(/clock skew guard tripped/);
    expect(ScanResult.safeParse(result).success).toBe(true);
  });

  it("errors on a diff base that could be read as a flag", async () => {
    const result = await portFor({ stdout: "[]" }).run("gitleaks", {
      ...WORKSPACE,
      diffBaseRef: "--exec=rm -rf /",
    });

    expect(result.outcome).toBe("error");
    expect(result.findings[0]?.message).toMatch(/diffBaseRef/);
  });

  it("blocks on an error no matter how permissive the threshold is", async () => {
    const result = await portFor({ timedOut: true }, { blockLevel: "critical" }).run("gitleaks", WORKSPACE);

    expect(result.outcome).toBe("error");
    expect(isScanBlocking(result.outcome)).toBe(true);
  });

  it("cannot be talked into a pass by a tool that reported an internal error", async () => {
    const stub = stubRunner({ exitCode: 1, stdout: fixture("semgrep-fatal") });
    const semgrep = createContainerScanPort("semgrep", configFor("semgrep"), {
      runner: stub.runner,
      clock: fakeClock(),
    });

    const result = await semgrep.run("semgrep", WORKSPACE);

    expect(result.outcome).toBe("error");
    expect(result.findings[0]?.message).toMatch(/semgrep reported/);
  });
});

describe('"the scan never ran" cannot open the gate', () => {
  it("blocks when a mandatory tool produced no result at all", async () => {
    const passed = await portFor({ stdout: "[]" }).run("gitleaks", WORKSPACE);

    const decision = scanGateDecision([passed]);

    expect(decision.blocking).toBe(true);
    expect(decision.missing).toEqual(["semgrep", "trivy"]);
  });

  it("blocks on an empty result set — no scans at all is not a pass", () => {
    expect(scanGateDecision([]).blocking).toBe(true);
  });

  it("blocks when the required set itself is empty (B6)", async () => {
    // A failed parameter lookup or a mis-wired gate hands over `[]`. Answering
    // "not blocking" there opens the gate with zero scans.
    const passed = await portFor({ stdout: "[]" }).run("gitleaks", WORKSPACE);

    expect(scanGateDecision([passed], []).blocking).toBe(true);
    expect(scanGateDecision([], []).blocking).toBe(true);
    expect(scanGateDecision([passed], []).reasons.join(" ")).toMatch(/no required scan set/);
  });
});
