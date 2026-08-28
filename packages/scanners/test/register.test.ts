import { CapabilityNotSupportedError, PortRegistry, type ScanPort } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import { ContainerScanPort, SCAN_PORT, ScanConfigError, registerScanDrivers } from "../src/index.js";
import * as publicApi from "../src/index.js";
import { IMAGES, WORKSPACE, configFor, fakeClock, stubRunner } from "./helpers.js";

function registry(deps: Parameters<typeof registerScanDrivers>[1] = {}) {
  const port = new PortRegistry();
  registerScanDrivers(port, deps);
  return port;
}

describe("driver registration (M44)", () => {
  it("registers the mandatory trio and the optional org drivers", () => {
    expect(registry().drivers(SCAN_PORT).sort()).toEqual([
      "fortify",
      "gitleaks",
      "semgrep",
      "sonarqube",
      "trivy",
      "xray",
    ]);
  });

  it("resolves a core driver into a working ScanPort", async () => {
    const stub = stubRunner({ stdout: "[]" });
    const factory = registry({ runner: stub.runner, clock: fakeClock() }).resolve<ScanPort>(SCAN_PORT, "gitleaks");

    const port = factory(configFor("gitleaks"));

    expect(port).toBeInstanceOf(ContainerScanPort);
    expect((await port.run("gitleaks", WORKSPACE)).outcome).toBe("pass");
  });

  it("lets a per-driver deps object override the registration-time runner", async () => {
    const registered = stubRunner({ stdout: "[]" });
    const override = stubRunner({ stdout: "[]" });
    const factory = registry({ runner: registered.runner }).resolve<ScanPort>(SCAN_PORT, "gitleaks");

    await factory({ ...configFor("gitleaks"), deps: { runner: override.runner } }).run("gitleaks", WORKSPACE);

    expect(override.requests).toHaveLength(1);
    expect(registered.requests).toHaveLength(0);
  });

  it("refuses a credential handed over through declarative config (B11)", () => {
    const port = registry({ runner: stubRunner().runner });

    expect(() =>
      port.resolve<ScanPort>(SCAN_PORT, "gitleaks")({ ...configFor("gitleaks"), deps: { token: "leaked" } }),
    ).toThrow(/credentials are runtime material/);
    expect(() =>
      port.resolve<ScanPort>(SCAN_PORT, "gitleaks")({ ...configFor("gitleaks"), deps: { tokens: { fortify: "x" } } }),
    ).toThrow(ScanConfigError);
  });

  it("ignores anything in deps that is not a runtime collaborator (B11)", async () => {
    const override = stubRunner({ stdout: "[]" });
    const factory = registry().resolve<ScanPort>(SCAN_PORT, "gitleaks");

    const port = factory({
      ...configFor("gitleaks"),
      deps: { runner: override.runner, blockLevel: "info", somethingElse: 1 },
    });

    expect((await port.run("gitleaks", WORKSPACE)).outcome).toBe("pass");
  });

  it("refuses an unknown driver rather than silently doing nothing", () => {
    expect(() => registry().resolve(SCAN_PORT, "checkmarx")).toThrow(/no driver "checkmarx"/);
  });

  it("refuses to build a core driver without a runner or with a floating image", () => {
    const port = registry();

    expect(() => port.resolve<ScanPort>(SCAN_PORT, "trivy")(configFor("trivy"))).toThrow(ScanConfigError);
    expect(() =>
      port.resolve<ScanPort>(SCAN_PORT, "trivy")({ image: "aquasec/trivy:latest", deps: { runner: stubRunner().runner } }),
    ).toThrow(/digest-pinned/);
  });

  it("refuses an unconfigured optional driver with CapabilityNotSupportedError (M77)", () => {
    const port = registry();

    for (const driver of ["fortify", "sonarqube", "xray"]) {
      expect(() => port.resolve<ScanPort>(SCAN_PORT, driver)({})).toThrow(CapabilityNotSupportedError);
    }
  });

  it("keeps the digest of the image it was configured with", () => {
    const factory = registry({ runner: stubRunner().runner }).resolve<ScanPort>(SCAN_PORT, "semgrep");

    expect((factory(configFor("semgrep")) as ContainerScanPort).imageDigest).toBe(`sha256:${"2".repeat(64)}`);
    expect(IMAGES.semgrep).toContain(`sha256:${"2".repeat(64)}`);
  });
});

describe("public API surface", () => {
  it("exports what a composition root needs", () => {
    expect(Object.keys(publicApi)).toEqual(
      expect.arrayContaining(["registerScanDrivers", "SCAN_PORT", "scanGateDecision", "scanEvidenceArtifacts"]),
    );
  });

  it("does not export the raw HTTP config parser as a way around validation", () => {
    expect(Object.keys(publicApi)).not.toContain("parseConfig");
  });
});
