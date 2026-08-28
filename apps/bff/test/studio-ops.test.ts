import { describe, expect, it } from "vitest";
import { auth } from "./helpers.js";
import {
  AT,
  GATE,
  RUNNER,
  TICKET,
  adminToken,
  memberToken,
  outsiderToken,
  studioHarness,
} from "./studio-fixtures.js";

/**
 * The operator surface. The fleet, the quota and the trail describe the
 * PLATFORM rather than the caller's work, so they are role-gated (M86); the
 * gate board is a work list and is scoped per project like the runs it names.
 */
describe("GET /studio/gates", () => {
  it("refuses an unauthenticated caller", async () => {
    const h = await studioHarness();
    expect((await h.app.inject({ method: "GET", url: "/studio/gates" })).statusCode).toBe(401);
  });

  it("does not show a stranger the gates of a project they cannot see", async () => {
    const h = await studioHarness();
    h.read.gates.open(GATE);
    const token = await outsiderToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/gates", headers: auth(token) });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { items: unknown[] }).items).toHaveLength(0);
  });

  it("returns the open gate with a waiting time computed from the clock", async () => {
    const h = await studioHarness();
    h.read.gates.open(GATE);
    const token = await memberToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/gates", headers: auth(token) });

    const body = response.json() as { items: { ticketKey: string; step: string; ownerGroup: string; waitingDays: number }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.ticketKey).toBe(TICKET);
    expect(body.items[0]?.ownerGroup).toBe("tech-leads");
    // Opened four days before the harness clock — a stored duration would be
    // stale, so the endpoint must be doing the arithmetic.
    expect(body.items[0]?.waitingDays).toBe(4);
  });

  it("filters by owner group", async () => {
    const h = await studioHarness();
    h.read.gates.open(GATE);
    h.read.gates.open({ ...GATE, step: "4", ownerGroup: "product-owners" });
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/gates?ownerGroup=product-owners",
      headers: auth(token),
    });

    const body = response.json() as { items: { step: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.step).toBe("4");
  });

  it("rejects an over-long owner group instead of querying with it", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/studio/gates?ownerGroup=${"x".repeat(200)}`,
      headers: auth(token),
    });

    expect(response.statusCode).toBe(400);
  });

  /** M32/M101: the board reports gates; it never offers a way to close one. */
  it("exposes no route that decides a gate", async () => {
    const h = await studioHarness();
    h.read.gates.open(GATE);
    const token = await adminToken(h);

    for (const method of ["POST", "PUT", "PATCH", "DELETE"] as const) {
      const response = await h.app.inject({
        method,
        url: "/studio/gates",
        headers: auth(token),
        payload: { decision: "approve" },
      });
      expect(response.statusCode).toBe(404);
    }
  });
});

describe("GET /studio/runners", () => {
  it("refuses a caller without an operator role", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/runners", headers: auth(token) });

    expect(response.statusCode).toBe(403);
  });

  it("returns the fleet and its per-pool capacity to an admin", async () => {
    const h = await studioHarness();
    h.read.runners.put(RUNNER);
    h.read.runners.put({ ...RUNNER, runnerId: "lnx-02", activeSandboxes: 1, state: "idle" });
    const token = await adminToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/runners", headers: auth(token) });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      items: { runnerId: string }[];
      pools: { pool: string; capacity: number; busy: number; machines: number }[];
    };
    expect(body.items).toHaveLength(2);
    // Summed from the two fixtures, not a stored aggregate.
    expect(body.pools[0]).toMatchObject({ pool: "docker-linux", capacity: 8, busy: 3, machines: 2 });
  });

  it("counts an unreachable runner as unhealthy", async () => {
    const h = await studioHarness();
    h.read.runners.put({ ...RUNNER, state: "unreachable", note: "Xcode güncellemesi bekliyor" });
    const token = await adminToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/runners", headers: auth(token) });

    const body = response.json() as { items: { note: string | null }[]; pools: { unhealthy: number }[] };
    expect(body.pools[0]?.unhealthy).toBe(1);
    expect(body.items[0]?.note).toBe("Xcode güncellemesi bekliyor");
  });
});

describe("GET /studio/sandboxes", () => {
  it("refuses a caller without an operator role", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);
    expect(
      (await h.app.inject({ method: "GET", url: "/studio/sandboxes", headers: auth(token) })).statusCode,
    ).toBe(403);
  });

  it("lists the workspaces an admin can see", async () => {
    const h = await studioHarness();
    h.read.runners.putSandbox({
      ticketKey: TICKET,
      runnerId: "lnx-01",
      state: "resumable",
      sizeBytes: 1_100_000_000,
      lastAccessAt: AT,
    });
    const token = await adminToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/sandboxes", headers: auth(token) });

    const body = response.json() as { items: { ticketKey: string; sizeBytes: number; state: string }[] };
    expect(body.items[0]).toMatchObject({ ticketKey: TICKET, sizeBytes: 1_100_000_000, state: "resumable" });
  });
});

describe("GET /studio/quota", () => {
  it("refuses a caller without an operator role", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);
    expect(
      (await h.app.inject({ method: "GET", url: "/studio/quota", headers: auth(token) })).statusCode,
    ).toBe(403);
  });

  /**
   * M55: the pool is what queues work. One exhausted account beside a ready one
   * is not a platform at 100%, and reporting an average would say it was.
   */
  it("reports the pool as having capacity while one account is ready", async () => {
    const h = await studioHarness();
    const token = await adminToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/quota", headers: auth(token) });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      accounts: { accountId: string }[];
      pool: { ready: number; exhausted: number; hasCapacity: boolean };
    };
    expect(body.accounts).toHaveLength(2);
    expect(body.pool).toMatchObject({ ready: 1, exhausted: 1, hasCapacity: true });
  });
});

describe("GET /studio/health", () => {
  it("refuses a caller without an operator role", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);
    expect(
      (await h.app.inject({ method: "GET", url: "/studio/health", headers: auth(token) })).statusCode,
    ).toBe(403);
  });

  it("reports the worst service state as the overall one", async () => {
    const h = await studioHarness({
      services: [
        { service: "bff", state: "healthy", version: "0.1.0", checkedAt: AT, note: null },
        { service: "temporal", state: "degraded", version: "1.0.0", checkedAt: AT, note: "3 replika" },
      ],
    });
    const token = await adminToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/health", headers: auth(token) });

    const body = response.json() as { state: string; services: { service: string }[] };
    expect(body.state).toBe("degraded");
    expect(body.services).toHaveLength(2);
  });

  it("an unconfigured connector never colours the overall state", async () => {
    // "Nobody set up an LLM yet" is a settings to-do, not an outage: the row
    // must appear honestly as not_configured while the platform stays green.
    const h = await studioHarness({
      services: [
        { service: "bff", state: "healthy", version: "0.1.0", checkedAt: AT, note: null },
        {
          service: "llm",
          state: "not_configured",
          version: "llm",
          checkedAt: AT,
          note: "health.note.not_configured",
        },
      ],
    });
    const token = await adminToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/health", headers: auth(token) });

    const body = response.json() as { state: string; services: { state: string }[] };
    expect(body.state).toBe("healthy");
    expect(body.services.map((s) => s.state)).toContain("not_configured");
  });
});

describe("GET /studio/audit", () => {
  it("refuses an operator who is not an auditor", async () => {
    const h = await studioHarness();
    await h.addUser({ username: "lider", roles: ["tech-lead"], groups: [] });
    const token = await h.login("lider");

    const response = await h.app.inject({ method: "GET", url: "/studio/audit", headers: auth(token) });

    expect(response.statusCode).toBe(403);
  });

  it("returns the appended records newest first", async () => {
    const h = await studioHarness();
    await h.chain.append({ actor: "maestro-worker", action: "RUN_STARTED", subject: TICKET, at: AT });
    await h.chain.append({ actor: "maestro-worker", action: "GATE_OPEN", subject: TICKET, at: AT });
    const token = await adminToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/audit", headers: auth(token) });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { items: { action: string; seq: number; hash: string }[] };
    expect(body.items).toHaveLength(2);
    expect(body.items[0]?.action).toBe("GATE_OPEN");
    expect(body.items[0]?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("filters by subject", async () => {
    const h = await studioHarness();
    await h.chain.append({ actor: "maestro-worker", action: "RUN_STARTED", subject: TICKET, at: AT });
    await h.chain.append({ actor: "maestro-worker", action: "RUN_STARTED", subject: "UGURWEB-1", at: AT });
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: `/studio/audit?subject=${TICKET}`,
      headers: auth(token),
    });

    const body = response.json() as { items: { subject: string }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.subject).toBe(TICKET);
  });

  /** B13: window + exact action + needle, combined with AND. */
  it("filters by an inclusive time window, action and free-text needle", async () => {
    const h = await studioHarness();
    await h.chain.append({ actor: "maestro-worker", action: "RUN_STARTED", subject: TICKET, at: "2026-08-07T10:00:00.000Z" });
    await h.chain.append({ actor: "ayse@corp", action: "GATE_APPROVE", subject: TICKET, at: "2026-08-08T10:00:00.000Z" });
    await h.chain.append({ actor: "ayse@corp", action: "GATE_REJECT", subject: "UGURWEB-1", at: "2026-08-09T10:00:00.000Z" });
    const token = await adminToken(h);

    const windowed = await h.app.inject({
      method: "GET",
      url: "/studio/audit?from=2026-08-08T00:00:00.000Z&to=2026-08-08T23:59:59.999Z",
      headers: auth(token),
    });
    expect((windowed.json() as { items: { action: string }[] }).items.map((i) => i.action)).toEqual([
      "GATE_APPROVE",
    ]);

    const byAction = await h.app.inject({
      method: "GET",
      url: "/studio/audit?action=GATE_REJECT",
      headers: auth(token),
    });
    expect((byAction.json() as { items: { subject: string }[] }).items[0]?.subject).toBe("UGURWEB-1");

    const byNeedle = await h.app.inject({
      method: "GET",
      url: "/studio/audit?q=ugurweb&actor=ayse@corp",
      headers: auth(token),
    });
    const needleItems = (byNeedle.json() as { items: { action: string }[] }).items;
    expect(needleItems).toHaveLength(1);
    expect(needleItems[0]?.action).toBe("GATE_REJECT");
  });

  it("rejects an over-long needle instead of querying with it", async () => {
    const h = await studioHarness();
    const token = await adminToken(h);
    const response = await h.app.inject({
      method: "GET",
      url: `/studio/audit?q=${"x".repeat(300)}`,
      headers: auth(token),
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /studio/audit.csv", () => {
  it("refuses an operator who is not an auditor", async () => {
    const h = await studioHarness();
    await h.addUser({ username: "lider", roles: ["tech-lead"], groups: [] });
    const token = await h.login("lider");

    const response = await h.app.inject({ method: "GET", url: "/studio/audit.csv", headers: auth(token) });

    expect(response.statusCode).toBe(403);
  });

  it("downloads the whole trail as an attachment stamped with the clock's date", async () => {
    const h = await studioHarness();
    await h.chain.append({ actor: "maestro-worker", action: "RUN_STARTED", subject: TICKET, at: AT });
    await h.chain.append({ actor: "ayse@corp", action: "GATE_APPROVE", subject: TICKET, at: AT });
    const token = await adminToken(h);

    const response = await h.app.inject({ method: "GET", url: "/studio/audit.csv", headers: auth(token) });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/csv; charset=utf-8");
    // The harness clock is 2026-08-09 — the stamp comes from the clock, not Date.now.
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="maestro-denetim-2026-08-09.csv"',
    );
    const lines = response.body.trim().split("\n");
    expect(lines[0]).toBe("seq,at,actor,action,subject,hash");
    // Chain order (ascending seq), header + both rows.
    expect(lines).toHaveLength(3);
    expect(lines[1]).toContain("RUN_STARTED");
    expect(lines[2]).toContain("GATE_APPROVE");
  });

  it("applies the same filters as the JSON page and ignores paging", async () => {
    const h = await studioHarness();
    await h.chain.append({ actor: "maestro-worker", action: "RUN_STARTED", subject: TICKET, at: AT });
    await h.chain.append({ actor: "ayse@corp", action: "GATE_APPROVE", subject: TICKET, at: AT });
    await h.chain.append({ actor: "ayse@corp", action: "GATE_APPROVE", subject: "UGURWEB-1", at: AT });
    const token = await adminToken(h);

    // `limit=1` must NOT truncate the file: the export is the whole window.
    const response = await h.app.inject({
      method: "GET",
      url: "/studio/audit.csv?actor=ayse@corp&limit=1",
      headers: auth(token),
    });

    const lines = response.body.trim().split("\n");
    expect(lines).toHaveLength(3); // header + the two ayse rows
    expect(response.body).not.toContain("RUN_STARTED");
    expect(response.body).toContain("UGURWEB-1");
  });

  it("rejects a malformed filter instead of exporting with it", async () => {
    const h = await studioHarness();
    const token = await adminToken(h);
    const response = await h.app.inject({
      method: "GET",
      url: `/studio/audit.csv?actor=${"x".repeat(300)}`,
      headers: auth(token),
    });
    expect(response.statusCode).toBe(400);
  });
});

describe("GET /studio/audit/verification", () => {
  it("refuses a non-auditor", async () => {
    const h = await studioHarness();
    const token = await memberToken(h);
    expect(
      (await h.app.inject({ method: "GET", url: "/studio/audit/verification", headers: auth(token) }))
        .statusCode,
    ).toBe(403);
  });

  it("verifies a real chain", async () => {
    const h = await studioHarness();
    await h.chain.append({ actor: "maestro-worker", action: "RUN_STARTED", subject: TICKET, at: AT });
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/audit/verification",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, checked: 1, brokenAtSeq: null });
  });

  /**
   * M33: an emptied table must never report `ok`. A verification that called
   * "nothing to check" a pass would give a wiped trail a clean bill of health.
   */
  it("refuses to call an empty chain verified", async () => {
    const h = await studioHarness();
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "GET",
      url: "/studio/audit/verification",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(200);
    expect((response.json() as { ok: boolean }).ok).toBe(false);
  });
});
