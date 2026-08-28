import { describe, expect, it } from "vitest";
import { harness } from "./helpers.js";

describe("health probes", () => {
  it("reports liveness without touching a dependency", async () => {
    const h = await harness();
    h.runs.pingFails = true;

    const response = await h.app.inject({ method: "GET", url: "/healthz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "ok" });
  });

  it("refuses to build when production is missing a connection value (M6)", async () => {
    const previous = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      await expect(harness()).rejects.toThrow(/required in production/);
    } finally {
      if (previous === undefined) delete process.env["NODE_ENV"];
      else process.env["NODE_ENV"] = previous;
    }
  });

  it("reports ready when the workflow engine and the switch answer", async () => {
    const h = await harness();

    const response = await h.app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      status: "ready",
      checks: { workflows: "ok", killswitch: "ok" },
    });
  });

  it("reports 503 when the workflow engine is unreachable", async () => {
    const h = await harness();
    h.runs.pingFails = true;

    const response = await h.app.inject({ method: "GET", url: "/readyz" });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({ status: "degraded", checks: { workflows: "fail" } });
  });

  it("answers 404 as JSON for an unknown route", async () => {
    const h = await harness();

    const response = await h.app.inject({ method: "GET", url: "/nope" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "not_found" });
  });
});
