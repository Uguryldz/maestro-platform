import { CapabilityNotSupportedError } from "@maestro/ports";
import { describe, expect, it } from "vitest";
import {
  ScanConfigError,
  createFortifyScanPort,
  createSonarQubeScanPort,
  createXrayScanPort,
  parseFortify,
  parseSonarQube,
} from "../src/index.js";
import { WORKSPACE, fakeClock, fixture, stubFetch } from "./helpers.js";

const FORTIFY = { baseUrl: "https://ssc.bank.example/ssc", projectVersionId: 42 };
const SONAR = { baseUrl: "https://sonar.bank.example", projectKey: "ugurpay" };

describe("fortify driver (M77 — the bank already owns this one)", () => {
  it("refuses to exist until it is configured", () => {
    expect(() => createFortifyScanPort(undefined)).toThrow(CapabilityNotSupportedError);
    expect(() => createFortifyScanPort({})).toThrow(CapabilityNotSupportedError);
  });

  it("refuses a configured driver with no token or a plain-http SSC", () => {
    expect(() => createFortifyScanPort(FORTIFY)).toThrow(/deps.token/);
    expect(() => createFortifyScanPort({ ...FORTIFY, baseUrl: "http://ssc.bank.example" }, { token: "t" })).toThrow(
      /not https/,
    );
    expect(() => createFortifyScanPort({ baseUrl: "https://ssc" }, { token: "t" })).toThrow(ScanConfigError);
  });

  it("pulls the issue list of the configured project version with FortifyToken auth", async () => {
    const fetch = stubFetch({ body: fixture("fortify-issues") });
    const port = createFortifyScanPort(FORTIFY, { token: "ssc-token", fetchImpl: fetch.fetchImpl, clock: fakeClock() });

    const result = await port.run("fortify", WORKSPACE);

    expect(fetch.calls[0]?.url).toContain("/api/v1/projectVersions/42/issues");
    expect(fetch.calls[0]?.url).toContain("showsuppressed=false");
    expect((fetch.calls[0]?.init?.headers as Record<string, string>).Authorization).toBe("FortifyToken ssc-token");
    expect(result.outcome).toBe("fail");
    expect(result.imageDigest).toBe("fortify-ssc:projectVersion/42");
  });

  it("maps Fortify priority order onto contract severities", () => {
    const findings = parseFortify(fixture("fortify-issues")).findings;

    expect(findings[0]).toMatchObject({
      tool: "fortify",
      severity: "critical",
      ruleId: "SQL Injection",
      file: "src/main/java/com/bank/pay/PayDao.java",
      line: 88,
    });
    expect(findings[1]?.severity).toBe("medium");
  });

  it("errors — never passes — when SSC refuses or answers with rubbish", async () => {
    const cases = [{ status: 401, body: "" }, { body: "<html>proxy error</html>" }, new Error("ECONNRESET")];

    for (const response of cases) {
      const fetch = stubFetch(response);
      const port = createFortifyScanPort(FORTIFY, { token: "t", fetchImpl: fetch.fetchImpl, clock: fakeClock() });

      expect((await port.run("fortify", WORKSPACE)).outcome).toBe("error");
    }
  });

  it("errors when SSC answers 200 with a non-200 responseCode", async () => {
    const fetch = stubFetch({ body: JSON.stringify({ data: [], responseCode: 500 }) });
    const port = createFortifyScanPort(FORTIFY, { token: "t", fetchImpl: fetch.fetchImpl, clock: fakeClock() });

    expect((await port.run("fortify", WORKSPACE)).outcome).toBe("error");
  });

  it("refuses valid-but-unrelated JSON instead of reporting a clean project (B5)", () => {
    for (const body of ["{}", '{"count":0}', '{"data":null}', '{"responseCode":200}']) {
      expect(() => parseFortify(body)).toThrow(/schema/);
    }
  });

  it("reads every page instead of deciding on the first one (B4)", async () => {
    const page = (start: number, size: number, count: number): { body: string } => ({
      body: JSON.stringify({
        count,
        responseCode: 200,
        data: Array.from({ length: size }, (_, index) => ({
          issueName: `Issue ${start + index}`,
          friority: start + index === 250 ? "Critical" : "Low",
          fullFileName: "src/A.java",
          lineNumber: 1,
        })),
      }),
    });
    const fetch = stubFetch(page(0, 200, 300), page(200, 100, 300));
    const port = createFortifyScanPort(FORTIFY, { token: "t", fetchImpl: fetch.fetchImpl, clock: fakeClock() });

    const result = await port.run("fortify", WORKSPACE);

    expect(fetch.calls).toHaveLength(2);
    expect(fetch.calls[0]?.url).toContain("start=0");
    expect(fetch.calls[1]?.url).toContain("start=200");
    expect(result.findings).toHaveLength(300);
    // The Critical sits on page 2; deciding on page 1 alone reported a pass.
    expect(result.outcome).toBe("fail");
  });

  it("errors rather than deciding on a truncated report (B4)", async () => {
    // SSC says 5000 issues exist and hands back 200 — then stops answering.
    const first = JSON.stringify({
      count: 5000, responseCode: 200,
      data: Array.from({ length: 200 }, () => ({ issueName: "Low thing", friority: "Low" })),
    });
    const empty = JSON.stringify({ count: 5000, responseCode: 200, data: [] });
    const fetch = stubFetch({ body: first }, { body: empty });
    const port = createFortifyScanPort(FORTIFY, { token: "t", fetchImpl: fetch.fetchImpl, clock: fakeClock() });

    const result = await port.run("fortify", WORKSPACE);

    expect(result.outcome).toBe("error");
    expect(result.findings[0]?.message).toMatch(/paging stalled/);
  });

  it("refuses a token smuggled in through declarative configuration (B11)", () => {
    // Declarative config is versioned in the DB and visible in Studio (M71);
    // a credential must not be able to live there.
    expect(() => createFortifyScanPort({ ...FORTIFY, deps: { token: "leaked" } })).toThrow(/credentials are runtime/);
  });
});

describe("sonarqube driver (M77)", () => {
  it("refuses to exist until it is configured", () => {
    expect(() => createSonarQubeScanPort(undefined)).toThrow(CapabilityNotSupportedError);
  });

  it("reads open issues of the project with bearer auth", async () => {
    const fetch = stubFetch({ body: fixture("sonarqube-issues") });
    const port = createSonarQubeScanPort(SONAR, { token: "sq", fetchImpl: fetch.fetchImpl, clock: fakeClock() });

    const result = await port.run("sonarqube", WORKSPACE);

    expect(fetch.calls[0]?.url).toContain("/api/issues/search?componentKeys=ugurpay");
    expect(fetch.calls[0]?.url).toContain("resolved=false");
    expect((fetch.calls[0]?.init?.headers as Record<string, string>).Authorization).toBe("Bearer sq");
    expect(result.outcome).toBe("fail");
  });

  it("maps sonar severities and strips the project prefix from the component", () => {
    const findings = parseSonarQube(fixture("sonarqube-issues")).findings;

    expect(findings[0]).toMatchObject({
      tool: "sonarqube",
      severity: "high",
      ruleId: "java:S2077",
      file: "src/main/java/com/bank/pay/PayDao.java",
      line: 88,
    });
    expect(findings[1]?.severity).toBe("low");
  });

  it("errors when the server is unreachable", async () => {
    const fetch = stubFetch(new Error("ETIMEDOUT"));
    const port = createSonarQubeScanPort(SONAR, { token: "sq", fetchImpl: fetch.fetchImpl, clock: fakeClock() });

    expect((await port.run("sonarqube", WORKSPACE)).outcome).toBe("error");
  });

  it("refuses valid-but-unrelated JSON instead of reporting a clean project (B5)", () => {
    for (const body of ["{}", '{"total":0}', '{"issues":null}']) {
      expect(() => parseSonarQube(body)).toThrow(/schema/);
    }
  });

  it("walks the pages when total exceeds the page size (B4)", async () => {
    const page = (count: number, total: number, critical = false): { body: string } => ({
      body: JSON.stringify({
        total,
        issues: Array.from({ length: count }, (_, index) => ({
          rule: `java:S${index}`,
          severity: critical && index === 0 ? "BLOCKER" : "INFO",
          component: "ugurpay:src/A.java",
          line: 1,
          message: "m",
        })),
      }),
    });
    const fetch = stubFetch(page(500, 700), page(200, 700, true));
    const port = createSonarQubeScanPort(SONAR, { token: "sq", fetchImpl: fetch.fetchImpl, clock: fakeClock() });

    const result = await port.run("sonarqube", WORKSPACE);

    expect(fetch.calls.map((call) => call.url.match(/&p=(\d+)/)?.[1])).toEqual(["1", "2"]);
    expect(result.findings).toHaveLength(700);
    expect(result.outcome).toBe("fail");
  });

  it("stops at one page when the server accounted for everything", async () => {
    const fetch = stubFetch({ body: fixture("sonarqube-issues") });
    const port = createSonarQubeScanPort(SONAR, { token: "sq", fetchImpl: fetch.fetchImpl, clock: fakeClock() });

    await port.run("sonarqube", WORKSPACE);

    expect(fetch.calls).toHaveLength(1);
  });
});

describe("xray driver (M77 — which Xray is unresolved)", () => {
  it("refuses even when configuration is supplied, rather than guessing an API", () => {
    expect(() => createXrayScanPort()).toThrow(CapabilityNotSupportedError);
    expect(() => createXrayScanPort({ baseUrl: "https://xray.bank.example" })).toThrow(CapabilityNotSupportedError);
  });
});
