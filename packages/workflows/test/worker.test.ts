import { existsSync } from "node:fs";
import { WORK_PORT } from "@maestro/adapter-jira";
import { LLM_PORT } from "@maestro/llm-gateway";
import { NOTIFY_PORT } from "@maestro/notify";
import { PUBLISH_PORT } from "@maestro/publish";
import { PortRegistry } from "@maestro/ports";
import { SCAN_PORT } from "@maestro/scanners";
import { SECRET_PORT } from "@maestro/secrets";
import { STORAGE_PORT } from "@maestro/storage";
import { describe, expect, it } from "vitest";
import { InMemoryIdempotency } from "../src/impl/idempotency.js";
import { createActivities } from "../src/impl/index.js";
import {
  MAESTRO_TASK_QUEUE,
  PORT_NAMES,
  type PortSelection,
  composeActivityDeps,
  resolvePorts,
  runMaestroWorker,
  warnIfGuardIsProcessLocal,
  workflowsPath,
} from "../src/worker.js";
import { makeFakes } from "./fakes.js";

/**
 * The composition root. These tests are about WIRING, not about Temporal: the
 * worker's own behaviour is proven by the time-skipping suite.
 */

const marker = (name: string) => ({ name });

function registryWithEverything(): PortRegistry {
  const registry = new PortRegistry();
  for (const port of Object.values(PORT_NAMES)) {
    registry.register(port, "fake", (config) => ({ port, config }));
  }
  return registry;
}

const selection = (driver = "fake"): PortSelection =>
  Object.fromEntries(
    Object.keys(PORT_NAMES).map((key) => [key, { driver, config: marker(key) }]),
  ) as PortSelection;

describe("port names match the packages that register them", () => {
  it("does not drift from the driver packages' own constants", () => {
    // Imported here and NOWHERE in src/: the core must not depend on a driver
    // package, but a test may, and this is the only thing keeping the two
    // spellings of every port name in step ("v1's CI-gate death" was a key
    // producer and consumer disagreeing).
    expect(PORT_NAMES.work).toBe(WORK_PORT);
    expect(PORT_NAMES.llm).toBe(LLM_PORT);
    expect(PORT_NAMES.scan).toBe(SCAN_PORT);
    expect(PORT_NAMES.storage).toBe(STORAGE_PORT);
    expect(PORT_NAMES.secret).toBe(SECRET_PORT);
    expect(PORT_NAMES.notify).toBe(NOTIFY_PORT);
    expect(PORT_NAMES.publish).toBe(PUBLISH_PORT);
  });
});

describe("resolvePorts (M44)", () => {
  it("builds every port from the registry, with its own config", () => {
    const ports = resolvePorts(registryWithEverything(), selection()) as unknown as Record<
      string,
      { port: string; config: { name: string } }
    >;
    expect(Object.keys(ports).sort()).toEqual([
      "llm",
      "notify",
      "publish",
      "scan",
      "scm",
      "secrets",
      "storage",
      "work",
    ]);
    expect(ports["work"]?.port).toBe("work");
    expect(ports["work"]?.config.name).toBe("work");
    // Each port got ITS config, not the last one seen.
    expect(ports["notify"]?.config.name).toBe("notify");
  });

  it("refuses to start with a driver that was never registered", () => {
    expect(() => resolvePorts(registryWithEverything(), selection("missing"))).toThrow(
      /no driver "missing"/,
    );
  });

  it("names the drivers it does have, so the misconfiguration is fixable", () => {
    expect(() => resolvePorts(registryWithEverything(), selection("missing"))).toThrow(/fake/);
  });
});

describe("the activity set", () => {
  it("binds every method of the interface", () => {
    const activities = createActivities(makeFakes().deps);
    const names = Object.keys(activities).sort();
    expect(names).toContain("runEngineering");
    expect(names).toContain("verifyCiOrigin");
    expect(names).toContain("buildEvidencePackage");
    expect(names).toContain("isMasterApprover");
    // The `analiz` flow's delivery step; see `planFor`.
    expect(names).toContain("deliverAnalysis");
    // The listening rule's status map, applied; see `impl/status-move.ts`.
    expect(names).toContain("moveTicketStatus");
    expect(names).toHaveLength(28);
    expect(Object.values(activities).every((fn) => typeof fn === "function")).toBe(true);
  });

  it("composes the ports and the core into one dependency object", () => {
    const ports = resolvePorts(registryWithEverything(), selection());
    const deps = composeActivityDeps(ports, makeFakes().deps);
    expect(deps.work).toBe(ports.work);
    expect(deps.notify).toBe(ports.notify);
    expect(typeof deps.now).toBe("function");
  });
});

describe("the workflow bundle's entry point", () => {
  it("resolves to a file that exists", () => {
    expect(existsSync(workflowsPath())).toBe(true);
    expect(workflowsPath()).toMatch(/ticket-workflow\.(ts|js)$/);
  });

  it("has a stable task queue name", () => {
    expect(MAESTRO_TASK_QUEUE).toBe("maestro-delivery");
  });
});

describe("graceful shutdown", () => {
  it("asks the worker to drain on a signal, and cleans its handlers up", async () => {
    const handlers = new Map<string, () => void>();
    const fakeProcess = {
      on: (signal: string, handler: () => void) => handlers.set(signal, handler),
      off: (signal: string) => handlers.delete(signal),
    } as unknown as NodeJS.Process;

    let shutdownCalls = 0;
    let resolveRun: (() => void) | undefined;
    const worker = {
      shutdown: () => {
        shutdownCalls += 1;
        resolveRun?.();
      },
      run: () => new Promise<void>((resolve) => (resolveRun = resolve)),
    };

    const running = runMaestroWorker(worker as never, fakeProcess);
    expect(handlers.size).toBe(2);
    handlers.get("SIGTERM")?.();
    await running;

    expect(shutdownCalls).toBe(1);
    // Left behind, a handler would shut down the NEXT worker in this process.
    expect(handlers.size).toBe(0);
  });
});

describe("InMemoryIdempotency", () => {
  it("runs the work once and replays the result", async () => {
    const guard = new InMemoryIdempotency();
    let calls = 0;
    const work = async (): Promise<number> => {
      calls += 1;
      return calls;
    };
    expect(await guard.once("k", work)).toBe(1);
    expect(await guard.once("k", work)).toBe(1);
    expect(calls).toBe(1);
    expect(guard.size).toBe(1);
  });

  it("shares one execution between concurrent callers", async () => {
    const guard = new InMemoryIdempotency();
    let calls = 0;
    const work = async (): Promise<number> => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return calls;
    };
    const [a, b] = await Promise.all([guard.once("k", work), guard.once("k", work)]);
    expect([a, b]).toEqual([1, 1]);
    expect(calls).toBe(1);
  });

  it("does NOT remember a failure — a retry is the whole point", async () => {
    const guard = new InMemoryIdempotency();
    let calls = 0;
    const flaky = async (): Promise<string> => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return "ok";
    };
    await expect(guard.once("k", flaky)).rejects.toThrow("transient");
    expect(await guard.once("k", flaky)).toBe("ok");
    expect(calls).toBe(2);
  });

  it("keeps different keys apart", async () => {
    const guard = new InMemoryIdempotency();
    expect(await guard.once("a", async () => 1)).toBe(1);
    expect(await guard.once("b", async () => 2)).toBe(2);
    expect(guard.size).toBe(2);
  });

  /**
   * D6: the process-local guard is correct for one worker and silently wrong for
   * two. A deployment mistake must not be discovered from duplicated evidence.
   */
  it("warns when the guard is process-local, and stays quiet otherwise", () => {
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (message: string) => void warnings.push(message);
    try {
      warnIfGuardIsProcessLocal(new InMemoryIdempotency());
      // A table-backed guard satisfies the same interface and must NOT warn.
      warnIfGuardIsProcessLocal({ once: async (_key, fn) => fn() });
    } finally {
      console.warn = original;
    }

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("SINGLE");
  });
});
