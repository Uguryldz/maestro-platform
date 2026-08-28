import { describe, expect, it } from "vitest";
import { TruncatedOutputError } from "../src/errors.js";
import { SandboxVerificationRunner, TRUNCATED_EXIT_CODE } from "../src/verification-runner.js";
import { verificationFailures } from "../src/collect.js";
import { fakeRunner } from "./runner-helpers.js";

const WS = "/workspace/UGURPAY-42";
const LIMIT = 64;

function verifierOver(
  runner: ReturnType<typeof fakeRunner>,
  over: { onTruncated?: "fail" | "throw"; signal?: AbortSignal } = {},
): SandboxVerificationRunner {
  return new SandboxVerificationRunner({
    runner,
    platform: "linux-node",
    workspaceKey: "ws-1",
    runId: "run-000001",
    timeoutSeconds: 600,
    tailLimitBytes: LIMIT,
    ...over,
  });
}

describe("SandboxVerificationRunner runs the repo's own commands", () => {
  it("returns the command's exit code and output, structured", async () => {
    const runner = fakeRunner({ fallback: { exitCode: 0, stdoutTail: "42 passing", durationMs: 900 } });

    const result = await verifierOver(runner).run(WS, { name: "test", command: ["npm", "test"] });

    expect(result).toMatchObject({ name: "test", exitCode: 0, stdoutTail: "42 passing", durationMs: 900 });
    expect(result.command).toEqual(["npm", "test"]);
  });

  it("runs the repo's command, not one of its own", async () => {
    const runner = fakeRunner();

    await verifierOver(runner).run(WS, { name: "lint", command: ["./gradlew", "check"] });

    // A bank's Java service and a Node service verify themselves differently;
    // a platform that hard-coded either silently skips the other's checks.
    const line = runner.jobs[0]?.job.command.join(" ") ?? "";
    expect(line).toContain("./gradlew check");
    expect(line).toContain(WS);
  });

  it("a red build stays red — the exit code is the verdict", async () => {
    const runner = fakeRunner({ fallback: { exitCode: 1, stdoutTail: "3 failing" } });

    const result = await verifierOver(runner).run(WS, { name: "test", command: ["npm", "test"] });

    expect(result.exitCode).toBe(1);
    expect(verificationFailures([result])).toHaveLength(1);
  });
});

describe("truncated output is never a pass", () => {
  /**
   * The gap this closes: `RunnerPort` returns TAILS, and `tail()` drops the
   * HEAD of the stream to fit its budget with nothing in `RunResult` to say so.
   * A green exit code on a cut report cannot be shown to have come from the run
   * it appears to describe.
   */
  it("marks a command whose output filled the tail budget as FAILED, even on exit 0", async () => {
    const runner = fakeRunner({ fallback: { exitCode: 0, stdoutTail: "x".repeat(LIMIT) } });

    const result = await verifierOver(runner).run(WS, { name: "test", command: ["npm", "test"] });

    expect(result.exitCode).not.toBe(0);
    expect(result.exitCode).toBe(TRUNCATED_EXIT_CODE);
    // Every "did this pass" check in the tree reads the exit code, so this one
    // reaches the strike ladder and the handover like any other red command.
    expect(verificationFailures([result])).toHaveLength(1);
  });

  it("says WHY, in the place every consumer already reads", async () => {
    const runner = fakeRunner({ fallback: { exitCode: 0, stdoutTail: "y".repeat(LIMIT + 10) } });

    const result = await verifierOver(runner).run(WS, { name: "build", command: ["make"] });

    // The CI fingerprint, the handover note and the journal all read the
    // stderr tail for the reason a command failed.
    expect(result.stderrTail).toContain("truncated");
    expect(result.stderrTail).toContain("cannot be read as a pass");
  });

  it("detects truncation on stderr too, not only stdout", async () => {
    const runner = fakeRunner({ fallback: { exitCode: 0, stdoutTail: "ok", stderrTail: "z".repeat(LIMIT) } });

    const result = await verifierOver(runner).run(WS, { name: "test", command: ["npm", "test"] });

    expect(result.exitCode).toBe(TRUNCATED_EXIT_CODE);
  });

  it("throws instead, for a caller that would rather stop the turn", async () => {
    const runner = fakeRunner({ fallback: { exitCode: 0, stdoutTail: "x".repeat(LIMIT) } });

    await expect(
      verifierOver(runner, { onTruncated: "throw" }).run(WS, { name: "test", command: ["npm", "test"] }),
    ).rejects.toThrow(TruncatedOutputError);
  });

  it("leaves a report that fits the budget alone", async () => {
    const runner = fakeRunner({ fallback: { exitCode: 0, stdoutTail: "42 passing" } });

    const result = await verifierOver(runner).run(WS, { name: "test", command: ["npm", "test"] });

    expect(result.exitCode).toBe(0);
    expect(result.stderrTail).not.toContain("truncated");
  });

  it("counts BYTES, not characters — a multi-byte report is not under budget", async () => {
    // 32 Turkish characters are 64 bytes: a length check would read this as
    // half the budget and let a genuinely truncated report through.
    const runner = fakeRunner({ fallback: { exitCode: 0, stdoutTail: "ğ".repeat(LIMIT / 2) } });

    const result = await verifierOver(runner).run(WS, { name: "test", command: ["npm", "test"] });

    expect(result.exitCode).toBe(TRUNCATED_EXIT_CODE);
  });
});

describe("the sandbox is torn down on every path", () => {
  it("releases the lease after a successful command", async () => {
    const runner = fakeRunner();
    await verifierOver(runner).run(WS, { name: "test", command: ["npm", "test"] });
    expect(runner.leaked()).toEqual([]);
  });

  it("releases the lease after the kill switch aborts the build", async () => {
    const controller = new AbortController();
    const runner = fakeRunner({ onSession: () => controller.abort(new Error("kill_switch_stop_all")) });

    await expect(
      verifierOver(runner, { signal: controller.signal }).run(WS, { name: "test", command: ["npm", "test"] }),
    ).rejects.toThrow(/kill_switch_stop_all/);
    expect(runner.leaked()).toEqual([]);
  });

  it("a failing release does not replace the reason the session ended", async () => {
    const controller = new AbortController();
    const runner = fakeRunner({
      failRelease: true,
      onSession: () => controller.abort(new Error("kill_switch_stop_all")),
    });

    // Otherwise a cancelled run is filed as a broken runner.
    await expect(
      verifierOver(runner, { signal: controller.signal }).run(WS, { name: "test", command: ["npm", "test"] }),
    ).rejects.toThrow(/kill_switch_stop_all/);
  });
});
