import { describe, expect, it } from "vitest";
import { WorkspaceProbeError } from "../src/errors.js";
import { SandboxWorkspaceProbe } from "../src/workspace-probe.js";
import { fakeRunner, porcelainZ } from "./runner-helpers.js";

const WS = "/workspace/UGURPAY-42";

function probeOver(runner: ReturnType<typeof fakeRunner>, signal?: AbortSignal): SandboxWorkspaceProbe {
  return new SandboxWorkspaceProbe({
    runner,
    platform: "linux-node",
    workspaceKey: "ws-1",
    runId: "run-000001",
    timeoutSeconds: 60,
    ...(signal === undefined ? {} : { signal }),
  });
}

describe("SandboxWorkspaceProbe reads the working copy through the sandbox", () => {
  it("reports every changed file with its status, and runs inside the sandbox", async () => {
    const runner = fakeRunner({
      responses: [
        { match: "status", result: { stdoutTail: porcelainZ([" M src/pay.ts", "?? .github/workflows/deploy.yml"]) } },
        { match: "numstat", result: { stdoutTail: "12\t3\tsrc/pay.ts\0" } },
      ],
    });

    const files = await probeOver(runner).changedFiles(WS);

    expect(files).toEqual([
      { path: "src/pay.ts", status: "modified", insertions: 12, deletions: 3 },
      { path: ".github/workflows/deploy.yml", status: "added", insertions: 0, deletions: 0 },
    ]);
    // The clone only exists inside the sandbox; a probe that shelled out on the
    // host would be reporting on a different filesystem.
    expect(runner.jobs.length).toBeGreaterThan(0);
    expect(runner.jobs[0]?.job.workspaceKey).toBe("ws-1");
  });

  it("keeps both ends of a rename — moving content off protected ground is still a change", async () => {
    const runner = fakeRunner({
      responses: [
        { match: "status", result: { stdoutTail: porcelainZ(["R  src/new.ts", "db/migrations/003.sql"]) } },
        { match: "numstat", result: { stdoutTail: "" } },
      ],
    });

    const files = await probeOver(runner).changedFiles(WS);

    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({
      path: "src/new.ts",
      status: "renamed",
      fromPath: "db/migrations/003.sql",
    });
  });

  it("does not lose the entries after a rename (the two-field porcelain record)", async () => {
    const runner = fakeRunner({
      responses: [
        {
          match: "status",
          result: { stdoutTail: porcelainZ(["R  a.ts", "b.ts", " M src/after-the-rename.ts"]) },
        },
        { match: "numstat", result: { stdoutTail: "" } },
      ],
    });

    const files = await probeOver(runner).changedFiles(WS);

    // A parser that split naively would read "b.ts" as its own entry and shift
    // everything after it, so the real change lands under a nonsense path.
    expect(files.map((f) => f.path)).toEqual(["a.ts", "src/after-the-rename.ts"]);
  });

  it("reports a typechange as a typechange, not an ordinary edit", async () => {
    const runner = fakeRunner({
      responses: [
        { match: "status", result: { stdoutTail: porcelainZ([" T config/app.yml"]) } },
        { match: "numstat", result: { stdoutTail: "" } },
      ],
    });

    const files = await probeOver(runner).changedFiles(WS);

    // `T` is a regular file replaced by a symlink; collapsed into "modified"
    // it reads as an edit while it is how a tracked path starts pointing out
    // of the workspace.
    expect(files[0]?.status).toBe("typechange");
  });

  it("sees files under .git/ that git status structurally cannot report", async () => {
    const runner = fakeRunner({
      responses: [
        { match: "status", result: { stdoutTail: "" } },
        { match: "find", result: { stdoutTail: "./hooks/post-checkout\0" } },
      ],
    });

    const internal = await probeOver(runner).internalChangedFiles(WS);

    // Persistent code execution on the bank's runner, invisible to every diff.
    expect(internal).toEqual([
      { path: ".git/hooks/post-checkout", status: "modified", insertions: 0, deletions: 0 },
    ]);
  });

  it("FAILS CLOSED: a probe that cannot look does not report a clean tree", async () => {
    const runner = fakeRunner({
      responses: [{ match: "status", result: { exitCode: 128, stderrTail: "fatal: not a git repository" } }],
    });

    await expect(probeOver(runner).changedFiles(WS)).rejects.toThrow(WorkspaceProbeError);
    // The operator needs git's own reason: this error is the only thing
    // standing between the agent's diff and the deny-list.
    await expect(probeOver(runner).changedFiles(WS)).rejects.toThrow(/not a git repository/);
  });

  it("releases the lease on every path, including the failing one", async () => {
    const ok = fakeRunner({
      responses: [
        { match: "status", result: { stdoutTail: porcelainZ([" M a.ts"]) } },
        { match: "numstat", result: { stdoutTail: "" } },
      ],
    });
    await probeOver(ok).changedFiles(WS);
    expect(ok.leaked()).toEqual([]);

    const failing = fakeRunner({ responses: [{ match: "status", result: { exitCode: 1 } }] });
    await expect(probeOver(failing).changedFiles(WS)).rejects.toThrow(WorkspaceProbeError);
    expect(failing.leaked()).toEqual([]);
  });

  it("asks for ALL untracked files, so a new directory is not one opaque entry", async () => {
    const runner = fakeRunner({
      responses: [
        { match: "status", result: { stdoutTail: "" } },
        { match: "numstat", result: { stdoutTail: "" } },
      ],
    });

    await probeOver(runner).changedFiles(WS);

    // `-unormal` collapses a new directory into one entry naming the DIRECTORY,
    // so three files created under `.github/workflows/` would be reported as a
    // single path that is not itself on the deny-list.
    const status = runner.jobs.find((j) => j.job.command.includes("status"));
    expect(status?.job.command).toContain("-uall");
  });

  it("a numstat failure does not erase changes the status call already proved", async () => {
    const runner = fakeRunner({
      responses: [
        { match: "status", result: { stdoutTail: porcelainZ([" M src/pay.ts"]) } },
        { match: "numstat", result: { exitCode: 1, stderrTail: "boom" } },
      ],
    });

    const files = await probeOver(runner).changedFiles(WS);

    expect(files).toHaveLength(1);
    expect(files[0]?.path).toBe("src/pay.ts");
  });

  it("aborts on the kill switch instead of returning a clean tree", async () => {
    const controller = new AbortController();
    const runner = fakeRunner({ onSession: () => controller.abort(new Error("kill_switch_stop_all")) });

    await expect(probeOver(runner, controller.signal).changedFiles(WS)).rejects.toThrow(/kill_switch_stop_all/);
    expect(runner.leaked()).toEqual([]);
  });
});
