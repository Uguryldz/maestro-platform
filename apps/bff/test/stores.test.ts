import { describe, expect, it } from "vitest";
import { ticketOfWorkflowId, workflowIdFor } from "../src/gateway.js";
import { projectKeyOf } from "../src/jira-intake.js";
import {
  InMemoryKillSwitchStore,
  InMemoryParamStore,
  KILL_SWITCH_OFF,
  StaticGateDirectory,
  StaticJiraProjectBindings,
} from "../src/stores/memory.js";
import { UGURPAY_BINDING } from "./helpers.js";

describe("workflow ids", () => {
  it("round-trips a ticket key", () => {
    expect(workflowIdFor("UGURPAY-123")).toBe("maestro-UGURPAY-123");
    expect(ticketOfWorkflowId("maestro-UGURPAY-123")).toBe("UGURPAY-123");
  });

  it("does not claim an id this deployment did not mint", () => {
    expect(ticketOfWorkflowId("some-other-workflow")).toBeNull();
  });

  it("derives the project key from the ticket key", () => {
    expect(projectKeyOf("UGURPAY-123")).toBe("UGURPAY");
    expect(() => projectKeyOf("not-a-key")).toThrow();
  });
});

describe("InMemoryParamStore", () => {
  it("refuses a version that does not follow the stored history", async () => {
    const store = new InMemoryParamStore();
    const base = {
      key: "a.b",
      scopeRef: null,
      value: 1,
      changedBy: "ayse@corp",
      approvedBy: null,
      at: "2026-08-09T09:00:00.000Z",
    };

    await store.apply({ ...base, version: 1 });
    await expect(store.apply({ ...base, version: 1 })).rejects.toThrow();
    await expect(store.apply({ ...base, version: 3 })).rejects.toThrow();
    await expect(store.apply({ ...base, version: 2 })).resolves.toBeUndefined();
  });

  it("versions each scope separately", async () => {
    const store = new InMemoryParamStore();
    const base = {
      key: "a.b",
      value: 1,
      version: 1,
      changedBy: "ayse@corp",
      approvedBy: null,
      at: "2026-08-09T09:00:00.000Z",
    };

    await store.apply({ ...base, scopeRef: null });
    await expect(store.apply({ ...base, scopeRef: "ugurpay" })).resolves.toBeUndefined();
  });

  it("keeps one pending proposal per key and scope", async () => {
    const store = new InMemoryParamStore();
    await store.putPending({ key: "a.b", scopeRef: null, value: 1, proposedBy: "x@corp", at: "t" });
    await store.putPending({ key: "a.b", scopeRef: null, value: 2, proposedBy: "y@corp", at: "t" });

    expect(await store.pending()).toHaveLength(1);
    await store.clearPending("a.b", null);
    expect(await store.pending()).toHaveLength(0);
  });
});

describe("kill switch store", () => {
  it("starts off and remembers what it was set to", async () => {
    const store = new InMemoryKillSwitchStore();
    expect(await store.get()).toEqual(KILL_SWITCH_OFF);

    await store.set({ level: "all", actor: "ayse@corp", reason: "olay", at: "t" });
    expect((await store.get()).level).toBe("all");
  });
});

describe("bindings and gate ownership", () => {
  it("returns null for a project that was never bound", async () => {
    const bindings = new StaticJiraProjectBindings([UGURPAY_BINDING]);
    expect(await bindings.resolve("UGURPAY")).toMatchObject({ appId: "ugurpay" });
    expect(await bindings.resolve("UGURWEB")).toBeNull();
  });

  it("falls back to the platform default gate owner", async () => {
    const gates = new StaticGateDirectory();
    expect(await gates.ownerGroup("4", "UGURPAY")).toBe("product-owners");
    expect(await gates.ownerGroup("5", "UGURPAY")).toBe("tech-leads");
  });

  it("returns null for a step that owns no group", async () => {
    expect(await new StaticGateDirectory().ownerGroup("6a", "UGURPAY")).toBeNull();
  });

  it("lets a project override the owner (M71)", async () => {
    const gates = new StaticGateDirectory({ UGURPAY: { "5": "ugurpay-leads" } });
    expect(await gates.ownerGroup("5", "UGURPAY")).toBe("ugurpay-leads");
    expect(await gates.ownerGroup("5", "UGURWEB")).toBe("tech-leads");
  });
});
