import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { auth, harness, type Harness } from "./helpers.js";

/**
 * The three administration screens: platform wiring, notification routing and
 * ticket→application routing.
 *
 * The behaviour under test is the pair of distinctions all three depend on:
 * "nobody configured this" is not "this is broken", and "saved" is not
 * "waiting for a second pair of eyes". Both look identical on a screen that
 * does not say which, and both change what an operator does next.
 */

async function admin(h: Harness): Promise<string> {
  await h.addUser({ username: "ayse.kaya", roles: ["admin"] });
  return h.login("ayse.kaya");
}

async function techLead(h: Harness): Promise<string> {
  await h.addUser({ username: "mehmet.demir", roles: ["tech-lead"] });
  return h.login("mehmet.demir");
}

function get(h: Harness, url: string, token: string): Promise<LightMyRequestResponse> {
  return h.app.inject({ method: "GET", url, headers: auth(token) });
}

function put(h: Harness, url: string, token: string, payload: object): Promise<LightMyRequestResponse> {
  return h.app.inject({ method: "PUT", url, headers: auth(token), payload });
}

describe("GET /settings", () => {
  it("returns the connections and the notify drivers", async () => {
    const h = await harness();
    const token = await admin(h);

    const response = await get(h, "/settings", token);

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      connections: { id: string; status: string; credentialRef: string }[];
      notifyDrivers: { channel: string; enabled: boolean }[];
    };
    expect(body.connections.map((row) => row.id)).toEqual(["jira", "siem"]);
    expect(body.notifyDrivers.map((row) => row.channel)).toEqual(["jira", "teams"]);
  });

  it("tells an unconfigured connection apart from a working one", async () => {
    const h = await harness();
    const token = await admin(h);

    const body = (await get(h, "/settings", token)).json() as {
      connections: { id: string; status: string; checkedAt: string | null }[];
    };

    // Two different answers, and an operator's next action differs completely:
    // one needs setting up, the other needs investigating.
    expect(body.connections.find((row) => row.id === "jira")?.status).toBe("connected");
    expect(body.connections.find((row) => row.id === "siem")?.status).toBe("unconfigured");
  });

  it("never sends a secret — only a reference to one", async () => {
    const h = await harness();
    const token = await admin(h);

    const raw = (await get(h, "/settings", token)).body;

    // A console that can display a PAT is a console that can leak it into a
    // screenshot. The reference is a Vault path; the value never leaves the
    // process that holds it.
    expect(raw).toContain("vault:maestro/jira#token");
    expect(raw).not.toContain("password");
    expect(raw).not.toMatch(/secret["']?\s*:/i);
  });

  /** Same seam as the routing one below — see its comment for why. */
  it("uses the field names the settings screen reads", async () => {
    const h = await harness();
    const token = await admin(h);

    const body = (await get(h, "/settings", token)).json() as {
      connections: Record<string, unknown>[];
      notifyDrivers: Record<string, unknown>[];
    };

    for (const field of ["id", "endpoint", "status", "credentialRef", "checkedAt"]) {
      expect(body.connections[0]).toHaveProperty(field);
    }
    for (const field of ["channel", "enabled", "target"]) {
      expect(body.notifyDrivers[0]).toHaveProperty(field);
    }
  });

  it("refuses a developer (M86)", async () => {
    const h = await harness();
    await h.addUser({ username: "can.yilmaz", roles: ["developer"] });
    const token = await h.login("can.yilmaz");

    expect((await get(h, "/settings", token)).statusCode).toBe(403);
  });

  it("refuses a caller with no session", async () => {
    const h = await harness();
    expect((await h.app.inject({ method: "GET", url: "/settings" })).statusCode).toBe(401);
  });
});

describe("PUT /settings", () => {
  it("applies an unguarded parameter outright", async () => {
    const h = await harness();
    const token = await admin(h);

    const response = await put(h, "/settings", token, {
      changes: [{ key: "reminder.channel", value: "slack" }],
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { results: { status: string }[] };
    expect(body.results[0]?.status).toBe("applied");

    const values = await h.params.values();
    expect(values.find((value) => value.key === "reminder.channel")?.value).toBe("slack");
  });

  it("turns a guarded parameter into a proposal rather than a change (M32/M78)", async () => {
    const h = await harness();
    const token = await admin(h);

    const response = await put(h, "/settings", token, {
      changes: [{ key: "gate.set", value: { analysis: true } }],
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { results: { status: string }[] };
    // "pending", not "applied": four eyes means a DIFFERENT person confirms.
    // A screen that reported this as saved would tell an operator the gate set
    // changed when it did not.
    expect(body.results[0]?.status).toBe("pending");
    expect(await h.params.pending()).toHaveLength(1);
  });

  it("refuses a tech lead — writing settings is admin-only", async () => {
    const h = await harness();
    const token = await techLead(h);

    // Reading is theirs…
    expect((await get(h, "/settings", token)).statusCode).toBe(200);
    // …changing is not.
    const response = await put(h, "/settings", token, {
      changes: [{ key: "reminder.channel", value: "slack" }],
    });
    expect(response.statusCode).toBe(403);
  });

  it("refuses the write while the kill switch is on (M58)", async () => {
    const h = await harness();
    const token = await admin(h);
    await h.killSwitch.set({
      level: "all",
      actor: "ayse.kaya@ugurbank.local",
      reason: "olay",
      at: "2026-08-09T10:00:00.000Z",
    });

    const response = await put(h, "/settings", token, {
      changes: [{ key: "reminder.channel", value: "slack" }],
    });

    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: string }).error).toBe("kill_switch");
  });

  it("refuses an unknown parameter by name rather than storing it", async () => {
    const h = await harness();
    const token = await admin(h);

    const response = await put(h, "/settings", token, {
      changes: [{ key: "made.up.key", value: 1 }],
    });

    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: string }).error).toBe("unknown_param");
  });

  it("refuses a body with no changes", async () => {
    const h = await harness();
    const token = await admin(h);

    expect((await put(h, "/settings", token, { changes: [] })).statusCode).toBe(400);
  });
});

describe("GET /routing", () => {
  it("returns the bound projects and the data-class policy rules", async () => {
    const h = await harness();
    const token = await admin(h);
    await seedPolicy(h);

    const response = await get(h, "/routing", token);

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      projects: { projectKey: string; trigger: string; apps: string[] }[];
      rules: { ruleId: string; backend: string; outcome: string }[];
    };
    expect(body.projects[0]).toMatchObject({ projectKey: "UGURPAY", trigger: "label" });
    // One rule per data class, plus the fallback.
    expect(body.rules.map((rule) => rule.ruleId)).toEqual([
      "dataclass:acik",
      "dataclass:dahili",
      "dataclass:gizli",
      "dataclass:onprem_missing",
    ]);
  });

  /**
   * The field NAMES, pinned.
   *
   * `Routing.tsx` reads `row.apps`, and this endpoint served `appIds`. Nothing
   * caught it: the screen is not typed against the BFF's interface, so the
   * whole stack compiled and the page crashed on `row.apps.length` the first
   * time a browser opened it. The compiler cannot check this seam, so a test
   * has to — one assertion per field each screen actually reads.
   */
  it("uses the field names the routing screen reads", async () => {
    const h = await harness();
    const token = await admin(h);
    await seedPolicy(h);

    const body = (await get(h, "/routing", token)).json() as {
      projects: Record<string, unknown>[];
      rules: Record<string, unknown>[];
    };

    for (const field of ["projectKey", "trigger", "apps", "noteKey"]) {
      expect(body.projects[0]).toHaveProperty(field);
    }
    for (const field of ["ruleId", "conditionKey", "backend", "model", "outcome"]) {
      expect(body.rules[0]).toHaveProperty(field);
    }
  });

  /**
   * The leak that produced these keys: `note` and `condition` used to be
   * finished English sentences, printed verbatim into a Turkish table
   * ("every ticket starts a run", `draft: not yet bound`). The BFF does not
   * send sentences (M104) — it sends the key and the screen renders it.
   */
  it("sends catalog KEYS for the note and the condition, never prose", async () => {
    const h = await harness();
    const token = await admin(h);
    await seedPolicy(h);

    const body = (await get(h, "/routing", token)).json() as {
      projects: { noteKey: string }[];
      rules: { conditionKey: string }[];
    };

    expect(body.projects[0]?.noteKey).toMatch(/^routing\.note\./);
    expect(body.rules[0]?.conditionKey).toMatch(/^routing\.policy\.condition\./);
    // No whitespace: a key is an identifier, a sentence has spaces in it.
    expect(body.projects[0]?.noteKey).not.toMatch(/\s/);
    expect(body.rules[0]?.conditionKey).not.toMatch(/\s/);
  });

  it("refuses rather than inventing a policy when the parameter is not seeded", async () => {
    const h = await harness();
    const token = await admin(h);

    // No `dataclass.policy` row. A compiled-in default would decide where
    // confidential material goes precisely when the database could not.
    const response = await get(h, "/routing", token);

    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: string; details: { key: string } };
    expect(body.error).toBe("param_not_seeded");
    expect(body.details.key).toBe("dataclass.policy");
  });

  it("reports a blocking fallback as blocked, not as fine", async () => {
    const h = await harness();
    const token = await admin(h);
    await seedPolicy(h, { whenOnpremMissing: "block" });

    const body = (await get(h, "/routing", token)).json() as {
      rules: { ruleId: string; outcome: string }[];
    };

    const fallback = body.rules.find((rule) => rule.ruleId === "dataclass:onprem_missing");
    expect(fallback?.outcome).toBe("blocked");
  });

  it("reports a masked-cloud fallback as degraded rather than ok", async () => {
    const h = await harness();
    const token = await admin(h);
    await seedPolicy(h, { whenOnpremMissing: "masked_cloud" });

    const body = (await get(h, "/routing", token)).json() as {
      rules: { ruleId: string; outcome: string }[];
    };

    // The work proceeds, but a confidential ticket went to a cloud model with
    // its identifiers masked. Green would hide the one event a compliance
    // reviewer opens this screen to find.
    expect(body.rules.find((rule) => rule.ruleId === "dataclass:onprem_missing")?.outcome).toBe(
      "degraded",
    );
  });

  /**
   * The raw policy round-trips VERBATIM, so the editor never has to reconstruct
   * a fallback from a rendered outcome.
   *
   * `degrade_ai_assist` and `masked_cloud` both render as the SAME `degraded`
   * outcome, so a screen guessing the fallback from a rule would be unable to
   * tell them apart — and a guessed value PUT back on an untouched save
   * silently downgrades the stored policy, past two approvers who only ever saw
   * the fabricated value. The screen depends on this raw field; a regression on
   * either side must fail here, not in a browser.
   */
  it("exposes the stored whenOnpremMissing verbatim, not just the lossy outcome", async () => {
    const h = await harness();
    const token = await admin(h);
    await seedPolicy(h, { whenOnpremMissing: "block" });

    const body = (await get(h, "/routing", token)).json() as {
      policy: { backendByClass: Record<string, string>; whenOnpremMissing: string };
    };

    expect(body.policy.whenOnpremMissing).toBe("block");
    expect(body.policy.backendByClass.gizli).toBe("onprem");
  });
});

describe("PUT /routing", () => {
  it("files the policy change as a proposal — it is guarded (M32/M78)", async () => {
    const h = await harness();
    const token = await admin(h);
    await seedPolicy(h);

    const response = await put(h, "/routing", token, {
      policy: {
        backendByClass: { acik: "api", dahili: "api", gizli: "api" },
        whenOnpremMissing: "block",
      },
    });

    expect(response.statusCode).toBe(200);
    // Routing `gizli` to a cloud backend is the most consequential setting on
    // the screen; one person must not be able to make it alone.
    expect((response.json() as { status: string }).status).toBe("pending");
  });

  it("refuses a policy that is missing a data class", async () => {
    const h = await harness();
    const token = await admin(h);
    await seedPolicy(h);

    const response = await put(h, "/routing", token, {
      policy: { backendByClass: { acik: "api" }, whenOnpremMissing: "block" },
    });

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toBe("invalid_routing_body");
  });

  it("refuses a tech lead", async () => {
    const h = await harness();
    const token = await techLead(h);
    await seedPolicy(h);

    const response = await put(h, "/routing", token, {
      policy: {
        backendByClass: { acik: "api", dahili: "api", gizli: "onprem" },
        whenOnpremMissing: "block",
      },
    });
    expect(response.statusCode).toBe(403);
  });
});

/**
 * Seed the `dataclass.policy` parameter the routing screen reads.
 *
 * Written through the store rather than through the endpoint because the
 * endpoint would (correctly) file a proposal: this is the row an installer's
 * parameter seed creates as version 1.
 */
async function seedPolicy(
  h: Harness,
  overrides: { whenOnpremMissing?: string } = {},
): Promise<void> {
  await h.params.apply({
    key: "dataclass.policy",
    scopeRef: null,
    value: {
      backendByClass: { acik: "api", dahili: "api", gizli: "onprem" },
      whenOnpremMissing: overrides.whenOnpremMissing ?? "degrade_ai_assist",
    },
    version: 1,
    changedBy: "installer@ugurbank.local",
    approvedBy: null,
    at: "2026-08-01T09:00:00.000Z",
  });
}
