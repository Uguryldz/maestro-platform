import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  CONTEXT_DIR_NAME,
  createWorkspace,
  IMPLEMENTATION_PATH,
  ticketDirName,
  WORK_DIR_NAME,
} from "../src/workspace.js";

/**
 * The PERSISTENT-KÖK sandbox model (analiz için tek kalıcı sandbox, ticket başına
 * izole klasör + izole context).
 *
 * The root is stable and never torn down; each ticket runs in its OWN isolated
 * subdirectory `<root>/<ticketKey>/` with its own AI context/cache. These tests
 * prove: two tickets get separate isolated areas, one ticket's dispose leaves the
 * root and the OTHER ticket intact, a ticket cannot see another's files/cache,
 * and the default (no root) path stays a throwaway mkdtemp dir (no regression).
 */

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "maestro-sandbox-root-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

describe("ticketDirName", () => {
  it("keeps a normal Jira key as a single safe segment", () => {
    expect(ticketDirName("OPS-6")).toBe("OPS-6");
    expect(ticketDirName("UGURPAY-123")).toBe("UGURPAY-123");
  });

  it("strips path separators and traversal so a key can never escape the root", () => {
    expect(ticketDirName("../../etc/passwd")).not.toContain("/");
    expect(ticketDirName("../../etc/passwd")).not.toContain("..");
    expect(ticketDirName("a/b\\c")).toBe("a_b_c");
    // Leading dots (a hidden/relative segment) are stripped.
    expect(ticketDirName(".ssh")).toBe("ssh");
  });

  it("fails CLOSED on a key that slugs to nothing usable", () => {
    expect(() => ticketDirName("/")).toThrow();
    expect(() => ticketDirName("...")).toThrow();
  });
});

describe("persistent-root workspace — isolation", () => {
  it("opens each ticket in its own <root>/<ticketKey> area with an isolated context dir", async () => {
    const a = await createWorkspace({ persistentRoot: root, ticketKey: "OPS-1" });
    const b = await createWorkspace({ persistentRoot: root, ticketKey: "OPS-2" });
    try {
      // The KÖK holds one subdir per ticket; the code dir and context dir live
      // INSIDE each ticket's own area.
      expect(a.root).toBe(join(root, "OPS-1", WORK_DIR_NAME));
      expect(b.root).toBe(join(root, "OPS-2", WORK_DIR_NAME));
      expect(a.contextDir).toBe(join(root, "OPS-1", CONTEXT_DIR_NAME));
      expect(b.contextDir).toBe(join(root, "OPS-2", CONTEXT_DIR_NAME));

      // Both areas exist under the shared root; the root has exactly the two
      // ticket subdirs and nothing shared between them.
      const rootEntries = (await readdir(root)).sort();
      expect(rootEntries).toEqual(["OPS-1", "OPS-2"]);
      expect(await exists(a.root)).toBe(true);
      expect(await exists(b.root)).toBe(true);
      expect(await exists(a.contextDir)).toBe(true);
      expect(await exists(b.contextDir)).toBe(true);

      // A code dir and a context dir are never the same directory — the AI's
      // scratch state can never be staged into the code/git working tree.
      expect(a.codeDir).not.toBe(a.contextDir);
    } finally {
      await a.dispose();
      await b.dispose();
    }
  });

  it("A cannot see B's files or context cache (izole context)", async () => {
    const a = await createWorkspace({ persistentRoot: root, ticketKey: "OPS-A" });
    const b = await createWorkspace({ persistentRoot: root, ticketKey: "OPS-B" });
    try {
      await a.write(IMPLEMENTATION_PATH, "export const secretOfA = 1;\n");
      await writeFile(join(a.contextDir, "cache.json"), '{"a":"private"}', "utf8");

      await b.write(IMPLEMENTATION_PATH, "export const secretOfB = 2;\n");
      await writeFile(join(b.contextDir, "cache.json"), '{"b":"private"}', "utf8");

      // B's code dir does NOT contain A's file (and vice versa) — separate trees.
      const bCodeEntries = await readdir(b.codeDir);
      expect(bCodeEntries).not.toContain("secretOfA");
      const bImpl = await readFile(join(b.codeDir, IMPLEMENTATION_PATH), "utf8");
      expect(bImpl).toContain("secretOfB");
      expect(bImpl).not.toContain("secretOfA");

      // The context caches are per-ticket: A's cache is unreadable from B's dir.
      expect(await exists(join(b.contextDir, "cache.json"))).toBe(true);
      const bCache = await readFile(join(b.contextDir, "cache.json"), "utf8");
      expect(bCache).toContain("private");
      expect(bCache).not.toContain('"a"');
      // B's context path is not a parent of / same as A's — no shared cache dir.
      expect(b.contextDir.startsWith(a.contextDir)).toBe(false);
      expect(a.contextDir.startsWith(b.contextDir)).toBe(false);
    } finally {
      await a.dispose();
      await b.dispose();
    }
  });

  it("disposing one ticket removes ONLY its area — the KÖK and the other ticket survive", async () => {
    const a = await createWorkspace({ persistentRoot: root, ticketKey: "OPS-A" });
    const b = await createWorkspace({ persistentRoot: root, ticketKey: "OPS-B" });

    await a.write(IMPLEMENTATION_PATH, "export const a = 1;\n");
    await b.write(IMPLEMENTATION_PATH, "export const b = 2;\n");

    // Dispose A only.
    await a.dispose();

    // The KÖK is untouched, B's whole area (work + context + file) is intact,
    // and A's subdir is gone.
    expect(await exists(root)).toBe(true);
    expect(await exists(join(root, "OPS-A"))).toBe(false);
    expect(await exists(join(root, "OPS-B"))).toBe(true);
    expect(await exists(b.root)).toBe(true);
    expect(await exists(b.contextDir)).toBe(true);
    const bImpl = await readFile(join(b.codeDir, IMPLEMENTATION_PATH), "utf8");
    expect(bImpl).toContain("export const b = 2;");

    await b.dispose();
    // Now B is gone too, but the KÖK still stands (never torn down).
    expect(await exists(join(root, "OPS-B"))).toBe(false);
    expect(await exists(root)).toBe(true);
  });

  it("reusing the same root for a fresh run of a ticket works (root is permanent)", async () => {
    const first = await createWorkspace({ persistentRoot: root, ticketKey: "OPS-R" });
    await first.write(IMPLEMENTATION_PATH, "export const v = 1;\n");
    await first.dispose();
    expect(await exists(join(root, "OPS-R"))).toBe(false);
    expect(await exists(root)).toBe(true);

    // A second run for the same ticket re-creates the area cleanly under the
    // still-present root (mkdir recursive tolerates the existing KÖK).
    const second = await createWorkspace({ persistentRoot: root, ticketKey: "OPS-R" });
    try {
      expect(await exists(second.root)).toBe(true);
      const entries = await readdir(second.codeDir);
      // Fresh area — the previous run's file is not resurrected.
      expect(entries).not.toContain(IMPLEMENTATION_PATH.split("/")[0]);
    } finally {
      await second.dispose();
    }
  });

  it("requires a ticketKey when a persistent root is given (fails CLOSED)", async () => {
    await expect(createWorkspace({ persistentRoot: root })).rejects.toThrow(/ticketKey/);
  });
});

describe("default (no persistent root) — mkdtemp, no regression", () => {
  it("opens a throwaway dir OUTSIDE the given root and disposes it whole", async () => {
    const ws = await createWorkspace({});
    expect(ws.root.startsWith(root)).toBe(false); // not under the persistent root
    expect(ws.codeDir).toBe(ws.root);
    // It still has an isolated context dir under its own throwaway root.
    expect(ws.contextDir).toBe(join(ws.root, CONTEXT_DIR_NAME));
    expect(await exists(ws.contextDir)).toBe(true);

    await ws.write(IMPLEMENTATION_PATH, "export const x = 1;\n");
    const throwaway = ws.root;
    await ws.dispose();
    // The whole throwaway dir is gone (old behaviour).
    expect(await exists(throwaway)).toBe(false);
  });
});
