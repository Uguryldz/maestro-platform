import { describe, expect, it } from "vitest";
import { auth, harness, type Harness } from "./helpers.js";

async function twoAdmins(h: Harness): Promise<{ first: string; second: string }> {
  await h.addUser({ username: "ayse.kaya", roles: ["admin"] });
  await h.addUser({ username: "mert.demir", roles: ["admin"] });
  return { first: await h.login("ayse.kaya"), second: await h.login("mert.demir") };
}

function put(h: Harness, token: string, key: string, value: unknown) {
  return h.app.inject({
    method: "PUT",
    url: `/params/${key}`,
    headers: auth(token),
    payload: { value },
  });
}

describe("PUT /params/:key (M71, four eyes)", () => {
  it("applies an unguarded parameter straight away", async () => {
    const h = await harness();
    const { first } = await twoAdmins(h);

    const response = await put(h, first, "reminder.channel", "smtp");

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: "applied", change: { version: 1 } });
    expect(await h.params.values()).toHaveLength(1);
  });

  it("does NOT apply a guarded parameter on one signature", async () => {
    const h = await harness();
    const { first } = await twoAdmins(h);

    const response = await put(h, first, "gate.set", { kritik: ["4", "5"] });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toMatchObject({ status: "pending" });
    expect(await h.params.values()).toHaveLength(0);
    const events = await h.auditStore.read();
    expect(events.map((event) => event.action)).not.toContain("PARAM_CHANGED");
  });

  it("still does not apply it when the same person presses twice", async () => {
    // These admins carry a role but no maestro-admins group, so the master-admin
    // self-approval exemption does not apply — the strict four-eyes rule holds.
    const h = await harness();
    const { first } = await twoAdmins(h);

    await put(h, first, "gate.set", { kritik: ["4", "5"] });
    const second = await put(h, first, "gate.set", { kritik: ["4", "5"] });

    expect(second.statusCode).toBe(202);
    expect(await h.params.values()).toHaveLength(0);
  });

  it("lets a MASTER ADMIN self-approve a guarded parameter (single-admin exemption)", async () => {
    // A member of maestro-admins may confirm their own guarded proposal so a
    // one-admin install is not deadlocked. The value must still match byte for
    // byte (a real second review), and the change is recorded with the master
    // admin as both author and approver, flagged soloApproval in the audit meta.
    const h = await harness();
    await h.addUser({ username: "ugur", roles: ["admin"], groups: ["maestro-admins"] });
    const master = await h.login("ugur");
    const value = { kritik: ["4", "5"] };

    const proposed = await put(h, master, "gate.set", value);
    expect(proposed.statusCode).toBe(202); // still queued on the first press
    const applied = await put(h, master, "gate.set", value); // same person confirms

    expect(applied.statusCode).toBe(200);
    expect(applied.json()).toMatchObject({
      status: "applied",
      change: { changedBy: "ugur@ugurbank.local", approvedBy: "ugur@ugurbank.local", version: 1 },
    });
    expect(await h.params.pending()).toHaveLength(0);

    const recorded = (await h.auditStore.read()).filter((e) => e.action === "PARAM_CHANGED");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.meta).toMatchObject({ soloApproval: true });
  });

  it("does NOT let a master admin self-approve a DIFFERENT value (review still real)", async () => {
    const h = await harness();
    await h.addUser({ username: "ugur", roles: ["admin"], groups: ["maestro-admins"] });
    const master = await h.login("ugur");

    await put(h, master, "gate.set", { kritik: ["4", "5"] });
    const mismatch = await put(h, master, "gate.set", { kritik: ["5"] });

    // Different value → not applied. It just replaces the pending entry.
    expect(mismatch.statusCode).toBe(202);
    expect(await h.params.values()).toHaveLength(0);
  });

  it("applies it when a second, different person confirms the same value", async () => {
    const h = await harness();
    const { first, second } = await twoAdmins(h);
    const value = { kritik: ["4", "5"] };

    await put(h, first, "gate.set", value);
    const response = await put(h, second, "gate.set", value);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: "applied",
      change: {
        changedBy: "ayse.kaya@ugurbank.local",
        approvedBy: "mert.demir@ugurbank.local",
        version: 1,
      },
    });
    expect(await h.params.pending()).toHaveLength(0);

    const events = await h.auditStore.read();
    const recorded = events.filter((event) => event.action === "PARAM_CHANGED");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.actor).toBe("mert.demir@ugurbank.local");
  });

  it("refuses to apply when the second person confirms a DIFFERENT value", async () => {
    const h = await harness();
    const { first, second } = await twoAdmins(h);

    await put(h, first, "gate.set", { kritik: ["4", "5"] });
    const response = await put(h, second, "gate.set", { kritik: ["5"] });

    expect(response.statusCode).toBe(409);
    expect(await h.params.values()).toHaveLength(0);
    expect(await h.params.pending()).toHaveLength(1);
  });

  it("treats a re-ordered object as the same value", async () => {
    const h = await harness();
    const { first, second } = await twoAdmins(h);

    await put(h, first, "gate.set", { a: 1, b: 2 });
    const response = await put(h, second, "gate.set", { b: 2, a: 1 });

    expect(response.statusCode).toBe(200);
  });

  it("rejects a value that does not fit the definition", async () => {
    const h = await harness();
    const { first } = await twoAdmins(h);

    const response = await put(h, first, "reminder.channel", "carrier-pigeon");

    expect(response.statusCode).toBe(400);
    expect(await h.params.values()).toHaveLength(0);
  });

  it("404s on an unknown parameter", async () => {
    const h = await harness();
    const { first } = await twoAdmins(h);

    const response = await put(h, first, "made.up", "x");

    expect(response.statusCode).toBe(404);
  });

  it("versions successive changes", async () => {
    const h = await harness();
    const { first } = await twoAdmins(h);

    await put(h, first, "reminder.channel", "smtp");
    const second = await put(h, first, "reminder.channel", "slack");

    expect(second.json()).toMatchObject({ change: { version: 2 } });
  });
});

/**
 * Four eyes counts PEOPLE, not tokens (M32/M101). `ai-via:ugur` and `ugur` are
 * the same pair of eyes; comparing the raw actor strings let one person hold a
 * normal session in one hand and their own MCP token in the other and close
 * their own proposal.
 */
describe("PUT /params/:key — delegation cannot supply the second pair of eyes", () => {
  it("does NOT apply when the proposer confirms through their own ai-via token", async () => {
    const h = await harness();
    await h.addUser({ username: "ayse.kaya", roles: ["admin"] });
    const human = await h.login("ayse.kaya");
    const delegated = await h.delegatedToken("ayse.kaya");
    const value = { kritik: ["4", "5"] };

    const proposal = await put(h, human, "gate.set", value);
    expect(proposal.statusCode).toBe(202);

    const confirmation = await put(h, delegated, "gate.set", value);

    expect(confirmation.statusCode).not.toBe(200);
    expect(await h.params.values()).toHaveLength(0);
    const events = await h.auditStore.read();
    expect(events.map((event) => event.action)).not.toContain("PARAM_CHANGED");
  });

  it("does NOT apply when an ai-via proposal is confirmed by the same human", async () => {
    const h = await harness();
    await h.addUser({ username: "ayse.kaya", roles: ["admin"] });
    const human = await h.login("ayse.kaya");
    const delegated = await h.delegatedToken("ayse.kaya");
    const value = { kritik: ["4", "5"] };

    await put(h, delegated, "gate.set", value);
    const confirmation = await put(h, human, "gate.set", value);

    expect(confirmation.statusCode).not.toBe(200);
    expect(await h.params.values()).toHaveLength(0);
  });

  /**
   * M101 gives the MCP surface "admin-öneri": a proposal, never an approval.
   * A delegated token may leave the first signature and nothing more.
   */
  it("lets an ai-via token propose but never approve", async () => {
    const h = await harness();
    await h.addUser({ username: "ayse.kaya", roles: ["admin"] });
    await h.addUser({ username: "mert.demir", roles: ["admin"] });
    const proposer = await h.login("ayse.kaya");
    const delegated = await h.delegatedToken("mert.demir");
    const value = { kritik: ["4", "5"] };

    await put(h, proposer, "gate.set", value);
    const confirmation = await put(h, delegated, "gate.set", value);

    expect(confirmation.statusCode).toBe(403);
    expect(await h.params.values()).toHaveLength(0);
    expect(await h.params.pending()).toHaveLength(1);
  });

  it("still applies for two genuinely different humans", async () => {
    const h = await harness();
    const { first, second } = await twoAdmins(h);
    const value = { kritik: ["4", "5"] };

    await put(h, first, "gate.set", value);

    expect((await put(h, second, "gate.set", value)).statusCode).toBe(200);
  });
});

/** M86: settings screens are admin+TL, not "anybody with a session". */
describe("PUT /params/:key — authorisation (M86)", () => {
  it("refuses a roleless account on an UNGUARDED parameter", async () => {
    const h = await harness();
    await h.addUser({ username: "stajyer", roles: [] });
    const token = await h.login("stajyer");

    const response = await put(h, token, "reminder.channel", "smtp");

    expect(response.statusCode).toBe(403);
    expect(await h.params.values()).toHaveLength(0);
  });

  it("refuses a roleless account on a guarded parameter", async () => {
    const h = await harness();
    await h.addUser({ username: "stajyer", roles: [] });
    const token = await h.login("stajyer");

    const response = await put(h, token, "gate.set", { kritik: ["4"] });

    expect(response.statusCode).toBe(403);
    expect(await h.params.pending()).toHaveLength(0);
  });

  it("accepts a tech-lead", async () => {
    const h = await harness();
    await h.addUser({ username: "tl", roles: ["tech-lead"] });
    const token = await h.login("tl");

    expect((await put(h, token, "reminder.channel", "smtp")).statusCode).toBe(200);
  });
});

describe("GET /params", () => {
  it("returns definitions, values and the pending queue", async () => {
    const h = await harness();
    const { first } = await twoAdmins(h);
    await put(h, first, "gate.set", { kritik: ["4"] });

    const response = await h.app.inject({ method: "GET", url: "/params", headers: auth(first) });

    const body = response.json() as {
      definitions: { key: string }[];
      values: unknown[];
      pending: unknown[];
    };
    // The seeded definitions, by KEY rather than by count: the harness's
    // fixture list grows as screens are wired, and an assertion on its length
    // fails for the wrong reason every time one is added.
    expect(body.definitions.map((definition) => definition.key)).toContain("gate.set");
    expect(body.definitions.map((definition) => definition.key)).toContain("reminder.channel");
    expect(body.values).toHaveLength(0);
    expect(body.pending).toHaveLength(1);
  });

  it("masks a secret parameter's value — the Teams webhook URL never leaves in full", async () => {
    const h = await harness();
    const { first } = await twoAdmins(h);
    const secret = "https://outlook.office.com/webhook/verysecret-abcdef";
    await put(h, first, "notify.teams.webhook", { url: secret });

    const response = await h.app.inject({ method: "GET", url: "/params", headers: auth(first) });
    const body = response.json() as { values: { key: string; value: unknown }[] };
    const row = body.values.find((value) => value.key === "notify.teams.webhook");

    // The row exists and is MASKED — only a recognition tail, never the URL.
    expect(row?.value).toEqual({ url: "…abcdef" });
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(JSON.stringify(body)).not.toContain("verysecret");
  });

  /** The SoD keys live here (M71); a roleless account has no business reading them. */
  it("refuses a roleless account", async () => {
    const h = await harness();
    await h.addUser({ username: "stajyer", roles: [] });
    const token = await h.login("stajyer");

    const response = await h.app.inject({ method: "GET", url: "/params", headers: auth(token) });

    expect(response.statusCode).toBe(403);
  });
});
