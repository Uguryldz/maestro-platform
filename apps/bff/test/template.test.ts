import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { auth, harness, SEED_TEMPLATE, type Harness } from "./helpers.js";

/**
 * The analysis template designer's write side (M108 + M83 pinning).
 *
 * The behaviour under test is not "a row was written" but the three promises
 * the designer makes to an institution: a save PUBLISHES rather than edits, a
 * published version is readable forever, and the section key the schema is
 * generated from is derived on the server rather than trusted from a client.
 */

const SECTIONS = [
  {
    title: "Amaç",
    description: "",
    aiInstruction: "Ticket'ın çözdüğü iş problemini yaz.",
    required: true,
    format: "free_text",
    example: "",
  },
  {
    title: "Kapsam Dışı",
    description: "",
    aiInstruction: "Neyin kapsam dışı olduğunu maddele.",
    required: false,
    format: "bullet_list",
    example: "",
  },
];

async function admin(h: Harness): Promise<string> {
  await h.addUser({ username: "ayse.kaya", roles: ["admin"] });
  return h.login("ayse.kaya");
}

function publish(h: Harness, token: string, body: object): Promise<LightMyRequestResponse> {
  return h.app.inject({ method: "POST", url: "/template/versions", headers: auth(token), payload: body });
}

describe("GET /template (M108)", () => {
  it("returns the published version, its history and the project bindings", async () => {
    const h = await harness();
    const token = await admin(h);

    const response = await h.app.inject({ method: "GET", url: "/template", headers: auth(token) });

    expect(response.statusCode).toBe(200);
    const body = response.json() as { template: { version: number }; history: unknown[]; projects: unknown[] };
    expect(body.template.version).toBe(1);
    expect(body.history).toHaveLength(1);
    expect(body.projects).toHaveLength(1);
  });

  it("refuses a session without one of the template roles", async () => {
    const h = await harness();
    await h.addUser({ username: "dev.user", roles: ["developer"] });
    const token = await h.login("dev.user");

    const response = await h.app.inject({ method: "GET", url: "/template", headers: auth(token) });

    expect(response.statusCode).toBe(403);
  });

  it("refuses an unauthenticated read", async () => {
    const h = await harness();
    const response = await h.app.inject({ method: "GET", url: "/template" });
    expect(response.statusCode).toBe(401);
  });
});

describe("POST /template/versions (M108, M83 pinning)", () => {
  it("publishes the NEXT version instead of editing the current one", async () => {
    const h = await harness();
    const token = await admin(h);

    const response = await publish(h, token, { name: "Analiz şablonu", sections: SECTIONS });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ version: 2, name: "Analiz şablonu" });
    // Version 1 is untouched: a run pinned to it still reads what it started
    // with, which is the whole point of M83.
    const v1 = await h.templates.get(1);
    expect(v1).toEqual(SEED_TEMPLATE);
  });

  it("keeps every published version readable after a newer one lands", async () => {
    const h = await harness();
    const token = await admin(h);
    await publish(h, token, { name: "Analiz şablonu", sections: SECTIONS });

    const response = await h.app.inject({ method: "GET", url: "/template/versions/1", headers: auth(token) });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ version: 1, sections: [{ key: "amac" }] });
  });

  it("answers 404 for a version that was never published", async () => {
    const h = await harness();
    const token = await admin(h);

    const response = await h.app.inject({ method: "GET", url: "/template/versions/99", headers: auth(token) });

    expect(response.statusCode).toBe(404);
  });

  it("derives section keys on the server, folding Turkish letters", async () => {
    const h = await harness();
    const token = await admin(h);

    const response = await publish(h, token, { name: "Analiz şablonu", sections: SECTIONS });

    const body = response.json() as { sections: { key: string; title: string }[] };
    expect(body.sections.map((s) => s.key)).toEqual(["amac", "kapsam_disi"]);
  });

  it("makes colliding keys unique rather than losing a section", async () => {
    const h = await harness();
    const token = await admin(h);
    // Two titles that slugify identically: trusting a client-sent key here
    // would generate a Zod schema with ONE property and silently drop a
    // section from every analysis.
    const sections = [
      { ...SECTIONS[0], title: "Kapsam" },
      { ...SECTIONS[0], title: "kapsam" },
      { ...SECTIONS[0], title: "KAPSAM" },
    ];

    const response = await publish(h, token, { name: "Analiz şablonu", sections });

    const body = response.json() as { sections: { key: string }[] };
    expect(body.sections.map((s) => s.key)).toEqual(["kapsam", "kapsam_2", "kapsam_3"]);
    expect(new Set(body.sections.map((s) => s.key)).size).toBe(3);
  });

  it("constrains derived keys to plain identifiers", async () => {
    const h = await harness();
    const token = await admin(h);
    // The key becomes a generated schema's property name, so a title that
    // looks like a JS internal must not survive as one.
    const sections = [
      { ...SECTIONS[0], title: "__proto__" },
      { ...SECTIONS[0], title: "İçerik" },
      { ...SECTIONS[0], title: "..." },
    ];

    const response = await publish(h, token, { name: "Analiz şablonu", sections });

    const body = response.json() as { sections: { key: string }[] };
    expect(body.sections.map((s) => s.key)).toEqual(["proto", "icerik", "bolum"]);
    expect(body.sections.every((s) => /^[a-z][a-z0-9_]*$/.test(s.key))).toBe(true);
  });

  it("records the publication in the audit trail with the section keys", async () => {
    const h = await harness();
    const token = await admin(h);

    await publish(h, token, { name: "Analiz şablonu", sections: SECTIONS });

    const events = await h.auditStore.read();
    const published = events.find((event) => event.subject === "template:Analiz şablonu");
    expect(published).toBeDefined();
    expect(published?.actor).toBe("ayse.kaya@ugurbank.local");
    expect(published?.meta).toMatchObject({ version: 2, kind: "analysis_template", keys: ["amac", "kapsam_disi"] });
  });

  it("refuses a template with no sections", async () => {
    const h = await harness();
    const token = await admin(h);

    const response = await publish(h, token, { name: "Analiz şablonu", sections: [] });

    expect(response.statusCode).toBe(400);
    expect(await h.templates.latest()).toMatchObject({ version: 1 });
  });

  it("refuses a section without a title, an instruction or a known format", async () => {
    const h = await harness();
    const token = await admin(h);

    const noTitle = await publish(h, token, { name: "T", sections: [{ ...SECTIONS[0], title: "  " }] });
    const noInstruction = await publish(h, token, { name: "T", sections: [{ ...SECTIONS[0], aiInstruction: "" }] });
    const badFormat = await publish(h, token, { name: "T", sections: [{ ...SECTIONS[0], format: "svg" }] });

    expect([noTitle.statusCode, noInstruction.statusCode, badFormat.statusCode]).toEqual([400, 400, 400]);
    // Nothing was published by any of the three.
    expect(await h.templates.latest()).toMatchObject({ version: 1 });
  });

  it("refuses a write from a session without a template role", async () => {
    const h = await harness();
    await h.addUser({ username: "dev.user", roles: ["developer"] });
    const token = await h.login("dev.user");

    const response = await publish(h, token, { name: "Analiz şablonu", sections: SECTIONS });

    expect(response.statusCode).toBe(403);
    expect(await h.templates.latest()).toMatchObject({ version: 1 });
  });
});
