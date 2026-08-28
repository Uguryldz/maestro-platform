import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { nodeSpawn } from "../src/node-spawn.js";

/**
 * The adapter is exercised against `process.execPath` with an inline script —
 * never against the real `claude` binary: this suite must stay offline and
 * must not spend a subscription seat.
 */
const NODE = process.execPath;
const workDir = mkdtempSync(join(tmpdir(), "maestro-spawn-"));

afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

function script(body: string): string[] {
  return ["-e", body];
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("nodeSpawn", () => {
  it("feeds stdin, collects stdout and reports the exit code", async () => {
    const result = await nodeSpawn()({
      command: NODE,
      args: script("process.stdin.on('data',d=>process.stdout.write('got:'+d));"),
      cwd: process.cwd(),
      stdin: "hello",
      env: {},
      timeoutMs: 20_000,
    });
    expect(result.stdout).toBe("got:hello");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBe(false);
  });

  it("keeps stderr and a non-zero exit apart from stdout", async () => {
    const result = await nodeSpawn()({
      command: NODE,
      args: script("process.stderr.write('bad');process.exit(3);"),
      cwd: process.cwd(),
      stdin: "",
      env: {},
      timeoutMs: 20_000,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toBe("bad");
    expect(result.stdout).toBe("");
  });

  it("delivers complete NDJSON lines as they arrive, including the last one", async () => {
    const lines: string[] = [];
    await nodeSpawn()({
      command: NODE,
      args: script("process.stdout.write('{\"a\":1}\\n{\"b\":2}');"),
      cwd: process.cwd(),
      stdin: "",
      env: {},
      timeoutMs: 20_000,
      onStdoutLine: (line) => lines.push(line),
    });
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it("passes only the environment it was given", async () => {
    const result = await nodeSpawn()({
      command: NODE,
      args: script("process.stdout.write(JSON.stringify(Object.keys(process.env).sort()));"),
      cwd: process.cwd(),
      stdin: "",
      env: { MAESTRO_SEAT: "seat-1" },
      timeoutMs: 20_000,
    });
    expect(JSON.parse(result.stdout)).toEqual(["MAESTRO_SEAT"]);
  });

  it("kills a process that outstays its timeout", async () => {
    const result = await nodeSpawn()({
      command: NODE,
      args: script("setInterval(()=>{},1000);"),
      cwd: process.cwd(),
      stdin: "",
      env: {},
      timeoutMs: 250,
    });
    expect(result.timedOut).toBe(true);
  });

  it("rejects when the command does not exist instead of reporting an empty run", async () => {
    await expect(
      nodeSpawn()({
        command: "/nonexistent/maestro-claude",
        args: [],
        cwd: process.cwd(),
        stdin: "",
        env: {},
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow();
  });
});

// Y1 — the CLI dying before it reads its prompt used to take the whole
// orchestrator down with an uncaught EPIPE, losing the turn record entirely.
describe("nodeSpawn — a child that dies before reading the prompt", () => {
  it("survives a broken stdin pipe and still reports the exit code", async () => {
    // Larger than a pipe buffer (64 KiB on Linux), so the write cannot be
    // absorbed and genuinely raises EPIPE.
    const prompt = "x".repeat(1024 * 1024);
    const result = await nodeSpawn()({
      command: NODE,
      args: script("process.exit(7);"),
      cwd: process.cwd(),
      stdin: prompt,
      env: {},
      timeoutMs: 20_000,
    });
    expect(result.exitCode).toBe(7);
    expect(result.timedOut).toBe(false);
  });

  it("still returns whatever the child managed to print before dying", async () => {
    const prompt = "y".repeat(1024 * 1024);
    const result = await nodeSpawn()({
      command: NODE,
      args: script("process.stdout.write('bye');process.exit(1);"),
      cwd: process.cwd(),
      stdin: prompt,
      env: {},
      timeoutMs: 20_000,
    });
    expect(result.stdout).toBe("bye");
    expect(result.exitCode).toBe(1);
  });
});

// D2 — `claude` launches hooks, MCP stdio servers and shells of its own;
// killing only the direct child left them writing into the workspace.
describe("nodeSpawn — timeout kills the whole process group", () => {
  it("stops a grandchild from touching the workspace after the turn was killed", async () => {
    const marker = join(workDir, "grandchild.txt");
    const ready = join(workDir, "grandchild-ready.txt");
    // The grandchild announces itself through the FILESYSTEM, not through the
    // parent's stdout. Both this and the late write have to survive the kill
    // question, and the parent's pipe is drained by the adapter we are testing.
    // The grandchild's late write is far enough out that a slow start cannot
    // push it before the kill. The old script paired a 300 ms timeout with a
    // 1500 ms write, which only holds if Node boots in well under 300 ms; under
    // the gate's four-way parallelism it does not, and the run was killed
    // before the grandchild existed. The test then failed on its own liveness
    // check — never on the behaviour it exists to prove. Widening both ends
    // keeps the ordering (kill at ~1.5 s, write at 6 s) true on a loaded box.
    const inner = [
      `require("fs").writeFileSync(${JSON.stringify(ready)},"up");`,
      `setTimeout(()=>{require("fs").writeFileSync(${JSON.stringify(marker)},"late")},6000);`,
    ].join("");
    const parent = [
      'const {spawn}=require("child_process");',
      `spawn(process.execPath,["-e",${JSON.stringify(inner)}],{stdio:"ignore"});`,
      "setInterval(()=>{},1000);",
    ].join("");

    const result = await nodeSpawn()({
      command: NODE,
      args: script(parent),
      cwd: workDir,
      stdin: "",
      env: {},
      timeoutMs: 1_500,
    });
    expect(result.timedOut).toBe(true);

    // Liveness through the FILESYSTEM rather than the parent's stdout: the
    // grandchild has to have existed for the assertion below to mean anything,
    // and a `ready` file survives the kill that a buffered pipe may not.
    expect(existsSync(ready)).toBe(true);

    // Well past the grandchild's 6 s timer: if the kill had reached only the
    // direct child, the marker would exist by now.
    await sleep(7_000);
    expect(existsSync(marker)).toBe(false);
  }, 30_000);
});
