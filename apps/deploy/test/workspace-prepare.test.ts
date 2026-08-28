import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareWorkspace, WorkspaceError } from "../src/stores/workspace-prepare.js";

/**
 * The checkout step 3ö reads.
 *
 * These exercise the parts that do NOT need a network: the repository-name
 * guard, reuse of an existing checkout, and the refusal path. The clone itself
 * is one `git clone` call; what breaks in practice is the surrounding logic —
 * a retried activity re-cloning, or a malformed name reaching the command
 * line.
 */

const made: string[] = [];

afterEach(async () => {
  for (const dir of made.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "maestro-ws-"));
  made.push(dir);
  return dir;
}

describe("prepareWorkspace", () => {
  it("refuses a repository name that is not owner/repo", async () => {
    // The value reaches a command line. A name with a slash too many — or a
    // shell metacharacter — must be rejected before it gets there.
    for (const bad of ["maestro-pilot", "a/b/c", "own er/repo", "repo;rm -rf /", ""]) {
      await expect(prepareWorkspace({ repo: bad, root: await root(), runId: "r1" })).rejects.toBeInstanceOf(
        WorkspaceError,
      );
    }
  });

  it("reuses an existing checkout instead of cloning again", async () => {
    // Temporal re-runs an activity after a worker crash. Re-cloning would turn
    // every retry into a fresh network fetch of a repository already on disk.
    const dir = await root();
    const existing = join(dir, "run-1");
    await mkdir(join(existing, ".git"), { recursive: true });
    await writeFile(join(existing, "README.md"), "already here");

    const path = await prepareWorkspace({ repo: "owner/repo", root: dir, runId: "run-1" });

    expect(path).toBe(existing);
  });

  it("reports the repository when the clone fails, not the raw stderr", async () => {
    // A token travels in an `http.extraHeader`. The failure message must name
    // what could not be cloned without echoing the command that carried it.
    const dir = await root();
    const error = await prepareWorkspace({
      repo: "maestro-test/does-not-exist",
      root: dir,
      runId: "run-2",
      host: "127.0.0.1:1",
      timeoutMs: 5_000,
    }).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(WorkspaceError);
    expect((error as WorkspaceError).message).toContain("maestro-test/does-not-exist");
    expect((error as WorkspaceError).message).not.toContain("extraheader");
  });
});
