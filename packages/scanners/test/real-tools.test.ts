import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createContainerScanPort, scanGateDecision } from "../src/index.js";
import { dockerRunner, makeGitWorkspace, makeWorkspace } from "./docker-runner.js";

/**
 * REAL-TOOL SMOKE TEST — opt-in with `MAESTRO_SCANNERS_IT=1`.
 *
 * 104 offline tests passed while every gitleaks scan errored in production,
 * because a stub runner will happily return whatever stdout the test author
 * expects. Only a real container proves the command line works. Requires
 * docker and the three images (pull commands in RAPOR.md §3); trivy also needs
 * a seeded DB cache in `MAESTRO_SCANNERS_IT_TRIVY_CACHE` — without one the
 * offline run is asserted to FAIL CLOSED instead.
 */
const ENABLED = process.env.MAESTRO_SCANNERS_IT === "1";

const IMAGES = {
  gitleaks: process.env.MAESTRO_SCANNERS_IT_GITLEAKS
    ?? "zricethezav/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f",
  semgrep: process.env.MAESTRO_SCANNERS_IT_SEMGREP
    ?? "semgrep/semgrep@sha256:bdf7013b2c3634a487671158da77c554f531742326b543a9464d2adf6c433ac8",
  trivy: process.env.MAESTRO_SCANNERS_IT_TRIVY
    ?? "aquasec/trivy@sha256:7cced7cae583819fc7806d4cbc0dbbc7cad18b99f7d3e235192e6da8c091045c",
};
const TRIVY_CACHE = process.env.MAESTRO_SCANNERS_IT_TRIVY_CACHE;

const RULES = `rules:
  - id: bank.python.os-system
    patterns:
      - pattern: os.system(...)
    message: os.system() with a built string is a command injection risk
    languages: [python]
    severity: ERROR
    metadata:
      severity: HIGH
`;

const DIRTY = {
  ".maestro-rules.yaml": RULES,
  "src/settings.js": 'const GITHUB_TOKEN = "ghp_1234567890abcdefghijklmnopqrstuvwx12";\n',
  "src/deploy.py": 'import os\n\n\ndef deploy(target):\n    os.system("kubectl apply -f " + target)\n',
  "package-lock.json": JSON.stringify({
    name: "it", version: "1.0.0", lockfileVersion: 3, requires: true,
    packages: {
      "": { name: "it", version: "1.0.0", dependencies: { minimist: "1.2.0" } },
      "node_modules/minimist": { version: "1.2.0" },
    },
  }, null, 2),
};

/**
 * The clean tree must contain a file in a language the ruleset covers.
 * semgrep only counts files a loaded rule can apply to, so a Python-only
 * ruleset over a JavaScript-only tree reports `paths.scanned: []` — which this
 * package treats as "scanned nothing", not as a pass. That is deliberate: it
 * means the pinned ruleset does not cover the repository (RAPOR.md §4).
 */
const CLEAN = {
  ".maestro-rules.yaml": RULES,
  "src/app.js": "export const answer = 42;\n",
  "src/ok.py": "import subprocess\n\n\ndef deploy(target):\n    subprocess.run([\"kubectl\", \"apply\", \"-f\", target], check=True)\n",
};

function port(tool: "gitleaks" | "semgrep" | "trivy", overrides: Record<string, unknown> = {}) {
  return createContainerScanPort(
    tool,
    {
      image: IMAGES[tool],
      timeoutSeconds: 300,
      ...(tool === "semgrep" ? { rulesRef: "/workspace/.maestro-rules.yaml" } : {}),
      ...overrides,
    },
    { runner: dockerRunner({ mounts: tool === "trivy" && TRIVY_CACHE ? [`${TRIVY_CACHE}:/root/.cache/trivy:ro`] : [] }) },
  );
}

describe.runIf(ENABLED)("real scanner images (MAESTRO_SCANNERS_IT=1)", () => {
  const dirty = { workspacePath: makeWorkspace(DIRTY) };
  const clean = { workspacePath: makeWorkspace(CLEAN) };
  const empty = { workspacePath: mkdtempSync(join(tmpdir(), "maestro-scan-it-empty-")) };

  describe("gitleaks", () => {
    it("returns findings from a real run — the report is never empty stdout (B1)", async () => {
      const result = await port("gitleaks").run("gitleaks", dirty);

      expect(result.outcome).toBe("fail");
      expect(result.findings.map((finding) => finding.ruleId)).toContain("github-pat");
      expect(result.findings[0]?.file).toBe("src/settings.js");
      expect(result.findings[0]?.message).not.toContain("ghp_");
    }, 300_000);

    it("passes a real clean tree", async () => {
      expect((await port("gitleaks").run("gitleaks", clean)).outcome).toBe("pass");
    }, 300_000);

    it("errors on an empty workspace instead of passing it (B3)", async () => {
      const result = await port("gitleaks").run("gitleaks", empty);

      expect(result.outcome).toBe("error");
      expect(result.findings[0]?.message).toMatch(/no scope/);
    }, 300_000);

    it("scans only the commit range when a diff base is given", async () => {
      const workspacePath = makeGitWorkspace(
        { "src/app.js": "export const answer = 42;\n" },
        { "src/leak.js": 'const T = "ghp_1234567890abcdefghijklmnopqrstuvwx12";\n' },
      );

      const result = await port("gitleaks").run("gitleaks", { workspacePath, diffBaseRef: "base-ref" });

      expect(result.outcome).toBe("fail");
      expect(result.findings[0]?.ruleId).toBe("github-pat");
      expect(result.findings[0]?.file).toBe("src/leak.js");
    }, 300_000);
  });

  describe("semgrep", () => {
    it("returns findings from a real run", async () => {
      const result = await port("semgrep").run("semgrep", dirty);

      expect(result.outcome).toBe("fail");
      // semgrep namespaces check_id by the ruleset's own location, so only the
      // rule's own id is stable across mounts.
      expect(result.findings.map((finding) => finding.ruleId.split(".").slice(-3).join("."))).toContain(
        "bank.python.os-system",
      );
      expect(result.findings[0]?.file).toBe("src/deploy.py");
    }, 300_000);

    it("passes a real clean tree and errors on an empty one (B3)", async () => {
      const passed = await port("semgrep").run("semgrep", clean);

      expect(passed.findings.map((finding) => finding.message)).toEqual([]);
      expect(passed.outcome).toBe("pass");
      expect((await port("semgrep").run("semgrep", empty)).outcome).toBe("error");
    }, 300_000);
  });

  describe("trivy", () => {
    it.runIf(TRIVY_CACHE)("returns findings from a real run against a seeded DB cache", async () => {
      const result = await port("trivy").run("trivy", dirty);

      expect(result.outcome).toBe("fail");
      expect(result.findings.map((finding) => finding.ruleId)).toContain("CVE-2021-44906");
      expect(result.findings[0]?.file).toBe("package-lock.json");
    }, 300_000);

    it.runIf(!TRIVY_CACHE)("fails closed when the vulnerability DB cannot be reached (B12)", async () => {
      const result = await port("trivy").run("trivy", dirty);

      expect(result.outcome).toBe("error");
    }, 300_000);

    it("errors on an empty workspace instead of passing it (B3)", async () => {
      expect((await port("trivy").run("trivy", empty)).outcome).toBe("error");
    }, 300_000);
  });

  it("the whole gate blocks on a real dirty workspace", async () => {
    const results = await Promise.all([
      port("gitleaks").run("gitleaks", dirty),
      port("semgrep").run("semgrep", dirty),
      port("trivy").run("trivy", dirty),
    ]);

    const decision = scanGateDecision(results);

    expect(decision.missing).toEqual([]);
    expect(decision.blocking).toBe(true);
  }, 600_000);
});
