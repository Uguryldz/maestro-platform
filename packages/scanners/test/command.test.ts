import { describe, expect, it } from "vitest";
import { WRAPPER_EXIT, WRAPPER_EXIT_REASONS, reportPath, wrapCommand } from "../src/index.js";

describe("container command wrapper", () => {
  it("hands the tool command over as \"$@\", never as text inside the script", () => {
    const argv = wrapCommand("/workspace", ["trivy", "fs", "--format", "json", "/workspace"]);

    expect(argv.slice(0, 2)).toEqual(["sh", "-c"]);
    // argv[2] is the script, argv[3] is $0, the rest is $@.
    expect(argv[3]).toBe("sh");
    expect(argv.slice(4)).toEqual(["trivy", "fs", "--format", "json", "/workspace"]);
    expect(argv[2]).not.toContain("trivy");
  });

  it("refuses to run before proving the workspace has content (B3)", () => {
    const script = wrapCommand("/workspace", ["trivy"])[2] ?? "";

    expect(script).toContain("if [ ! -d '/workspace' ]");
    expect(script).toContain(`exit ${WRAPPER_EXIT.missingWorkspace}`);
    expect(script).toContain("ls -A '/workspace'");
    expect(script).toContain(`exit ${WRAPPER_EXIT.emptyWorkspace}`);
  });

  it("reads a report file back and preserves the tool's own exit code (B1)", () => {
    const report = reportPath("gitleaks");
    const script = wrapCommand("/workspace", ["gitleaks", "dir", "/workspace"], { readReport: report })[2] ?? "";

    expect(report).toBe("/tmp/maestro-gitleaks-report.json");
    expect(script).toContain(`if [ ! -f '${report}' ]; then exit ${WRAPPER_EXIT.missingReport}; fi`);
    expect(script).toContain(`cat '${report}'`);
    expect(script).toContain("exit $code");
    // The tool's own stdout must not be able to contaminate the report.
    expect(script).toContain('"$@" >/dev/null');
  });

  it("execs the tool directly when it streams its own report", () => {
    const script = wrapCommand("/workspace", ["semgrep", "scan"])[2] ?? "";

    expect(script).toContain('exec "$@"');
    expect(script).not.toContain("cat '");
  });

  it("refuses a mount path that is not a plain absolute POSIX path", () => {
    for (const path of ["ws", "/work space", "/work'; rm -rf /; '", "/work$(id)", ""]) {
      expect(() => wrapCommand(path, ["trivy"])).toThrow(/plain absolute POSIX path/);
    }
  });

  it("gives every reserved exit code a reason the driver can report", () => {
    for (const code of Object.values(WRAPPER_EXIT)) {
      expect(WRAPPER_EXIT_REASONS[code]).toBeTruthy();
    }
    // Reserved codes must not collide with a tool's own "it ran" codes.
    expect(Object.values(WRAPPER_EXIT).every((code) => code > 2)).toBe(true);
  });
});
