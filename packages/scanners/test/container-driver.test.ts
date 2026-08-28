import { ScanResult } from "@maestro/contracts";
import { describe, expect, it } from "vitest";
import { ScanConfigError, WRAPPER_EXIT, createContainerScanPort } from "../src/index.js";
import { IMAGES, WORKSPACE, configFor, fakeClock, fixture, stubRunner } from "./helpers.js";

function driver(tool: "gitleaks" | "semgrep" | "trivy", output: Record<string, unknown>, overrides = {}) {
  const stub = stubRunner(output);
  const port = createContainerScanPort(tool, configFor(tool, overrides), {
    runner: stub.runner,
    clock: fakeClock(),
  });
  return { port, stub };
}

/** The tool command as it appears after the `sh -c <script> sh` preamble. */
function toolArgv(argv: readonly string[] | undefined): string[] {
  return [...(argv ?? [])].slice(4);
}

function script(argv: readonly string[] | undefined): string {
  return argv?.[2] ?? "";
}

describe("container invocation", () => {
  it("runs the pinned image read-only, offline, with the configured timeout", async () => {
    const { port, stub } = driver("trivy", { stdout: fixture("trivy-clean") }, { timeoutSeconds: 300 });

    await port.run("trivy", WORKSPACE);

    expect(stub.requests[0]).toMatchObject({
      image: IMAGES.trivy,
      workspacePath: WORKSPACE.workspacePath,
      workspaceMountPath: "/workspace",
      network: "none",
      timeoutSeconds: 300,
    });
  });

  it("guards every tool with a workspace-scope preamble (B3)", async () => {
    for (const tool of ["gitleaks", "semgrep", "trivy"] as const) {
      const { port, stub } = driver(tool, { stdout: "{}" });

      await port.run(tool, WORKSPACE);

      const argv = stub.requests[0]?.argv;
      expect(argv?.slice(0, 2)).toEqual(["sh", "-c"]);
      expect(argv?.[3]).toBe("sh");
      expect(script(argv)).toContain(`exit ${WRAPPER_EXIT.missingWorkspace}`);
      expect(script(argv)).toContain(`exit ${WRAPPER_EXIT.emptyWorkspace}`);
      // The tool command is passed as "$@", never spliced into the script.
      expect(script(argv)).toContain('"$@"');
    }
  });

  it("makes gitleaks write its report to a FILE and reads it back (B1)", async () => {
    // `--report-path /dev/stdout` writes nothing at all: verified live on
    // v8.30.1, a tree with two secrets exits 1 with zero bytes on stdout.
    const { port, stub } = driver("gitleaks", { stdout: "[]" });

    await port.run("gitleaks", WORKSPACE);

    const report = "/tmp/maestro-gitleaks-report.json";
    expect(toolArgv(stub.requests[0]?.argv)).toEqual([
      "gitleaks", "dir", "/workspace", "--report-format", "json", "--report-path", report,
    ]);
    expect(script(stub.requests[0]?.argv)).toContain(`cat '${report}'`);
    expect(stub.requests[0]?.argv.join(" ")).not.toContain("/dev/stdout");
  });

  it("errors when gitleaks exits without writing its report", async () => {
    const { port } = driver("gitleaks", { exitCode: WRAPPER_EXIT.missingReport, stdout: "" });

    const result = await port.run("gitleaks", WORKSPACE);

    expect(result.outcome).toBe("error");
    expect(result.findings[0]?.message).toMatch(/without writing its report file/);
  });

  it("scopes gitleaks to a commit range when a diff base is given", async () => {
    const { port, stub } = driver("gitleaks", { stdout: "[]" });

    await port.run("gitleaks", { ...WORKSPACE, diffBaseRef: "origin/main" });

    const argv = toolArgv(stub.requests[0]?.argv);
    expect(argv.slice(0, 4)).toEqual(["gitleaks", "git", "/workspace", "--log-opts"]);
    expect(argv).toContain("origin/main..HEAD");
    expect(argv).not.toContain("dir");
  });

  it("passes semgrep a locally pinned ruleset and no metrics", async () => {
    const { port, stub } = driver("semgrep", { stdout: fixture("semgrep-clean") });

    await port.run("semgrep", { ...WORKSPACE, diffBaseRef: "release/2026.08" });

    expect(toolArgv(stub.requests[0]?.argv)).toEqual([
      "semgrep", "scan", "--json", "--quiet", "--metrics=off", "--disable-version-check",
      "--config", "/rules/bank-ruleset.yaml",
      "--baseline-commit", "release/2026.08", "/workspace",
    ]);
  });

  it("asks trivy for vulnerabilities of the mounted filesystem", async () => {
    const { port, stub } = driver("trivy", { stdout: fixture("trivy-clean") });

    await port.run("trivy", WORKSPACE);

    expect(toolArgv(stub.requests[0]?.argv)).toEqual([
      "trivy", "fs", "--format", "json", "--quiet", "--scanners", "vuln", "/workspace",
    ]);
  });

  it("appends configured extra arguments", async () => {
    const { port, stub } = driver("trivy", { stdout: fixture("trivy-clean") }, { extraArgs: ["--parallel", "2"] });

    await port.run("trivy", WORKSPACE);

    expect(toolArgv(stub.requests[0]?.argv).join(" ")).toContain("--parallel 2");
  });
});

describe("outcome of a scan that ran", () => {
  it("passes a clean scan and stamps the image digest and clock", async () => {
    const { port } = driver("gitleaks", { stdout: "[]" });

    const result = await port.run("gitleaks", WORKSPACE);

    expect(result.outcome).toBe("pass");
    expect(result.findings).toEqual([]);
    expect(result.imageDigest).toBe(`sha256:${"1".repeat(64)}`);
    expect(result.startedAt).toBe("2026-08-08T10:00:00.000Z");
    expect(result.finishedAt).toBe("2026-08-08T10:00:01.000Z");
    expect(ScanResult.safeParse(result).success).toBe(true);
  });

  it("fails when a finding reaches the block level", async () => {
    // gitleaks exits 1 when it finds leaks — a completed run, not an error.
    const { port } = driver("gitleaks", { exitCode: 1, stdout: fixture("gitleaks-report") });

    const result = await port.run("gitleaks", WORKSPACE);

    expect(result.outcome).toBe("fail");
    expect(result.findings).toHaveLength(2);
  });

  it("reports findings below the threshold without failing", async () => {
    const { port } = driver("trivy", { stdout: fixture("trivy-fs") }, { blockLevel: "critical" });

    const result = await port.run("trivy", WORKSPACE);

    // One CRITICAL in the live report — so `critical` still fails; `info` on a
    // report with nothing critical is the honest "below threshold" case.
    expect(result.outcome).toBe("fail");
    expect(result.findings).toHaveLength(9);
  });

  it("fails the same scan once the threshold is lowered", async () => {
    const { port } = driver("trivy", { stdout: fixture("trivy-fs") }, { blockLevel: "medium" });

    expect((await port.run("trivy", WORKSPACE)).outcome).toBe("fail");
  });

  it("passes a real report whose findings all sit below the threshold", async () => {
    const report = JSON.stringify({
      SchemaVersion: 2, ArtifactName: "/workspace",
      Results: [{ Target: "package-lock.json", Vulnerabilities: [{ VulnerabilityID: "CVE-1", Severity: "LOW" }] }],
    });
    const { port } = driver("trivy", { stdout: report }, { blockLevel: "high" });

    const result = await port.run("trivy", WORKSPACE);

    expect(result.outcome).toBe("pass");
    expect(result.findings).toHaveLength(1);
  });
});

describe("configuration is refused at wiring time, not at scan time", () => {
  const runner = stubRunner().runner;

  it("refuses an image that is not digest-pinned", () => {
    expect(() => createContainerScanPort("trivy", { image: "aquasec/trivy:latest" }, { runner })).toThrow(
      ScanConfigError,
    );
  });

  it("refuses semgrep without a locally pinned ruleset", () => {
    expect(() => createContainerScanPort("semgrep", { image: IMAGES.semgrep }, { runner })).toThrow(/rulesRef/);
  });

  it("refuses a driver with no container runner", () => {
    expect(() => createContainerScanPort("trivy", configFor("trivy"), {})).toThrow(/deps.runner/);
  });

  it("refuses extraArgs that would decide the gate instead of the threshold (B8)", () => {
    const forbidden = [
      ["--severity", "NONE"], ["--severity=HIGH"], ["--skip-dirs", "/workspace"], ["--exit-code", "0"],
      ["--ignore-unfixed"], ["--exclude-rules", "x"], ["--baseline-path", "/tmp/b.json"], ["--no-git"],
      ["--report-path", "/dev/null"], ["--format", "table"], ["-c", "/tmp/evil.toml"],
    ];

    for (const extraArgs of forbidden) {
      expect(() => createContainerScanPort("trivy", configFor("trivy", { extraArgs }), { runner })).toThrow(
        /extraArgs/,
      );
    }
  });

  it("still allows arguments that only change how the tool runs", () => {
    expect(() =>
      createContainerScanPort("trivy", configFor("trivy", { extraArgs: ["--parallel", "4", "--timeout", "10m"] }), { runner }),
    ).not.toThrow();
  });
});
