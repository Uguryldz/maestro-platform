import type { LightMyRequestResponse } from "fastify";
import { describe, expect, it } from "vitest";
import { FIXED_PLACEHOLDERS, sectionToken } from "@maestro/publish";
import { buildDocx, buildNonWordZip } from "./docx-fixtures.js";
import { auth, harness, type Harness } from "./helpers.js";

/**
 * The corporate Word template's management surface (M103r/M109 + M83).
 *
 * What is under test is not "a file was stored" but the four promises the
 * platform makes to a bank's document owner: a corrupt file is refused rather
 * than discovered at generation time, an upload PUBLISHES a version rather
 * than overwriting one, the placeholder scan reports what is missing, and an
 * absent template is reported as absent rather than as an error.
 */

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

async function admin(h: Harness): Promise<string> {
  await h.addUser({ username: "ayse.kaya", roles: ["admin"] });
  return h.login("ayse.kaya");
}

async function techLead(h: Harness): Promise<string> {
  await h.addUser({ username: "mehmet.demir", roles: ["tech-lead"] });
  return h.login("mehmet.demir");
}

function upload(
  h: Harness,
  token: string,
  content: Uint8Array,
  fileName = "kurumsal-sablon.docx",
): Promise<LightMyRequestResponse> {
  return h.app.inject({
    method: "POST",
    url: "/doc-template",
    headers: { ...auth(token), "content-type": DOCX, "x-maestro-filename": fileName },
    payload: Buffer.from(content),
  });
}

function read(h: Harness, token: string): Promise<LightMyRequestResponse> {
  return h.app.inject({ method: "GET", url: "/doc-template", headers: auth(token) });
}

interface TemplateBody {
  template: { fileName: string; version: number; sizeBytes: number; styles: string[] } | null;
  placeholders: { token: string; found: boolean; location: string; descriptionKey: string }[];
  sectionMapping: { index: number; token: string; mapped: boolean; title: string }[];
  outputs: { fileName: string; templateVersion: number }[];
}

describe("GET /doc-template (M103r)", () => {
  it("reports an absent template as absent, not as an error", async () => {
    const h = await harness();
    const token = await admin(h);

    const response = await read(h, token);

    // 200 with `template: null`, NOT a 404. Generation continues on a fallback
    // layout, so "nobody has uploaded one" is a state the screen renders as a
    // warning — an error here would make a normal first-run look broken.
    expect(response.statusCode).toBe(200);
    const body = response.json() as TemplateBody;
    expect(body.template).toBeNull();
    // No file means nothing was scanned. Listing every token as "not found"
    // would read as a broken upload rather than an absent one.
    expect(body.placeholders).toEqual([]);
  });

  it("still lists the analysis sections so a document owner can see what needs slots", async () => {
    const h = await harness();
    const token = await admin(h);

    const body = (await read(h, token)).json() as TemplateBody;

    // The seeded analysis template (M108) has one section, "Amaç".
    expect(body.sectionMapping).toHaveLength(1);
    expect(body.sectionMapping[0]).toMatchObject({
      index: 1,
      title: "Amaç",
      token: sectionToken(1),
      // Unmapped: there is no .docx, so nothing carries the slot.
      mapped: false,
    });
  });

  /**
   * The field NAMES, pinned.
   *
   * The screens are not typed against the BFF's interfaces, so a rename on
   * either side compiles cleanly and crashes the page in a browser — which is
   * exactly how `/routing` shipped `appIds` for a screen reading `apps`. One
   * assertion per field `Doctemplate.tsx` actually reads.
   */
  it("uses the field names the template screen reads", async () => {
    const h = await harness();
    const token = await admin(h);
    await upload(h, token, await buildDocx([FIXED_PLACEHOLDERS.title, sectionToken(1)]));

    const body = (await read(h, token)).json() as {
      template: Record<string, unknown>;
      placeholders: Record<string, unknown>[];
      sectionMapping: Record<string, unknown>[];
    };

    for (const field of ["fileName", "version", "uploadedAt", "uploadedBy", "sizeBytes", "styles"]) {
      expect(body.template).toHaveProperty(field);
    }
    for (const field of ["token", "descriptionKey", "location", "found"]) {
      expect(body.placeholders[0]).toHaveProperty(field);
    }
    for (const field of ["index", "title", "token", "mapped"]) {
      expect(body.sectionMapping[0]).toHaveProperty(field);
    }
  });

  it("refuses a caller with no session", async () => {
    const h = await harness();
    const response = await h.app.inject({ method: "GET", url: "/doc-template" });
    expect(response.statusCode).toBe(401);
  });

  it("refuses a developer — the template is the admin surface (M86)", async () => {
    const h = await harness();
    await h.addUser({ username: "can.yilmaz", roles: ["developer"] });
    const token = await h.login("can.yilmaz");

    expect((await read(h, token)).statusCode).toBe(403);
  });
});

describe("POST /doc-template — validation", () => {
  it("refuses a file that is not a zip at all", async () => {
    const h = await harness();
    const token = await admin(h);

    const response = await upload(h, token, new Uint8Array(Buffer.from("%PDF-1.7 not a docx")));

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toBe("doc_template_not_docx");
    // Nothing was stored: a refused upload must not become version 1.
    expect(await h.docTemplates.latest()).toBeNull();
  });

  it("refuses a real zip that is not a Word package", async () => {
    const h = await harness();
    const token = await admin(h);

    // This is the case a four-byte `PK\x03\x04` check would wave through, and
    // the reason the upload path opens the archive.
    const response = await upload(h, token, buildNonWordZip());

    expect(response.statusCode).toBe(400);
    const body = response.json() as { error: string; details: { reason: string } };
    expect(body.error).toBe("doc_template_not_docx");
    expect(body.details.reason).toContain("word/document.xml");
    expect(await h.docTemplates.latest()).toBeNull();
  });

  it("refuses an empty body", async () => {
    const h = await harness();
    const token = await admin(h);

    const response = await upload(h, token, new Uint8Array(0));

    expect(response.statusCode).toBe(400);
    expect(await h.docTemplates.latest()).toBeNull();
  });

  it("refuses a file name that is not a .docx", async () => {
    const h = await harness();
    const token = await admin(h);
    const content = await buildDocx([FIXED_PLACEHOLDERS.title]);

    const response = await upload(h, token, content, "sablon.pdf");

    expect(response.statusCode).toBe(400);
    expect((response.json() as { error: string }).error).toBe("invalid_doc_template_filename");
  });

  it("strips a path out of the file name rather than storing it", async () => {
    const h = await harness();
    const token = await admin(h);
    const content = await buildDocx([FIXED_PLACEHOLDERS.title]);

    const response = await upload(h, token, content, "../../etc/sablon.docx");

    expect(response.statusCode).toBe(201);
    const stored = await h.docTemplates.latest();
    expect(stored?.fileName).not.toContain("/");
    expect(stored?.fileName).toBe(".._.._etc_sablon.docx");
  });

  it("refuses a tech lead — uploading the letterhead is admin-only", async () => {
    const h = await harness();
    const token = await techLead(h);
    const content = await buildDocx([FIXED_PLACEHOLDERS.title]);

    // A tech lead may READ the template screen…
    expect((await read(h, token)).statusCode).toBe(200);
    // …but replacing the file every bank document goes out under is not theirs.
    expect((await upload(h, token, content)).statusCode).toBe(403);
  });

  it("refuses the upload while the kill switch is on (M58)", async () => {
    const h = await harness();
    const token = await admin(h);
    await h.killSwitch.set({
      level: "all",
      actor: "ayse.kaya@ugurbank.local",
      reason: "olay incelemesi",
      at: "2026-08-09T10:00:00.000Z",
    });

    const response = await upload(h, token, await buildDocx([FIXED_PLACEHOLDERS.title]));

    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: string }).error).toBe("kill_switch");
    expect(await h.docTemplates.latest()).toBeNull();
  });
});

describe("POST /doc-template — the scan", () => {
  it("accepts a real .docx and reports which placeholders it carries", async () => {
    const h = await harness();
    const token = await admin(h);
    const content = await buildDocx([
      FIXED_PLACEHOLDERS.title,
      FIXED_PLACEHOLDERS.ticket,
      sectionToken(1),
    ]);

    const response = await upload(h, token, content);

    expect(response.statusCode).toBe(201);
    const body = response.json() as TemplateBody;
    expect(body.template).toMatchObject({ fileName: "kurumsal-sablon.docx", version: 1 });
    expect(body.template?.sizeBytes).toBe(content.byteLength);

    const found = body.placeholders.filter((one) => one.found).map((one) => one.token);
    expect(found).toContain(FIXED_PLACEHOLDERS.title);
    expect(found).toContain(FIXED_PLACEHOLDERS.ticket);
    expect(found).toContain(sectionToken(1));
  });

  it("reports the placeholders the template does NOT carry", async () => {
    const h = await harness();
    const token = await admin(h);
    // Deliberately missing the approval table — the one a gate signs.
    const content = await buildDocx([FIXED_PLACEHOLDERS.title]);

    const body = (await upload(h, token, content)).json() as TemplateBody;

    const approvals = body.placeholders.find(
      (one) => one.token === FIXED_PLACEHOLDERS.approvals,
    );
    expect(approvals).toBeDefined();
    // Present in the list and flagged missing: an omitted row would let a
    // document owner believe their template covers something it does not.
    expect(approvals?.found).toBe(false);
    expect(approvals?.descriptionKey).toBe("doctemplate.what.approvals");
  });

  it("says where a placeholder sits so it can be found in Word", async () => {
    const h = await harness();
    const token = await admin(h);
    const content = await buildDocx([FIXED_PLACEHOLDERS.ticket]);

    const body = (await upload(h, token, content)).json() as TemplateBody;

    const ticket = body.placeholders.find((one) => one.token === FIXED_PLACEHOLDERS.ticket);
    // The fixture writes "Alan: {{ticket}}" as its own paragraph.
    expect(ticket?.location).toBe(`Alan: ${FIXED_PLACEHOLDERS.ticket}`);
  });

  it("leaves the location empty for a placeholder that is not there", async () => {
    const h = await harness();
    const token = await admin(h);

    const body = (await upload(h, token, await buildDocx([]))).json() as TemplateBody;

    const run = body.placeholders.find((one) => one.token === FIXED_PLACEHOLDERS.run);
    // Not a made-up location. `found: false` carries the fact; inventing a
    // position for an absent token would be fabricated data.
    expect(run).toMatchObject({ found: false, location: "" });
  });

  it("reads the style names out of the .docx", async () => {
    const h = await harness();
    const token = await admin(h);

    const body = (await upload(h, token, await buildDocx([]))).json() as TemplateBody;

    // The fixture declares a corporate heading style; the scan must surface it
    // so a document owner recognises their own file.
    expect(body.template?.styles).toContain("Kurum Başlık");
  });

  it("maps an analysis section to its slot when the template carries one", async () => {
    const h = await harness();
    const token = await admin(h);

    const body = (await upload(h, token, await buildDocx([sectionToken(1)]))).json() as TemplateBody;

    expect(body.sectionMapping[0]).toMatchObject({ index: 1, mapped: true });
  });

  it("marks a section as appended when the template has no slot for it", async () => {
    const h = await harness();
    const token = await admin(h);

    const body = (await upload(h, token, await buildDocx([FIXED_PLACEHOLDERS.title]))).json() as TemplateBody;

    // Generation does not stop — the section is appended — but the screen has
    // to be able to say so.
    expect(body.sectionMapping[0]).toMatchObject({ index: 1, mapped: false });
  });
});

describe("POST /doc-template — versioning (M83)", () => {
  it("publishes a new version rather than overwriting the previous file", async () => {
    const h = await harness();
    const token = await admin(h);

    const first = await buildDocx([FIXED_PLACEHOLDERS.title]);
    const second = await buildDocx([FIXED_PLACEHOLDERS.title, FIXED_PLACEHOLDERS.approvals]);

    expect((await upload(h, token, first, "v1.docx")).statusCode).toBe(201);
    const response = await upload(h, token, second, "v2.docx");

    expect(response.statusCode).toBe(201);
    expect((response.json() as TemplateBody).template).toMatchObject({
      version: 2,
      fileName: "v2.docx",
    });

    // Version 1 is still readable: a run pinned to it must still render.
    const kept = await h.docTemplates.get(1);
    expect(kept?.fileName).toBe("v1.docx");
    expect(kept?.content.byteLength).toBe(first.byteLength);
  });

  it("serves an older version's bytes so a pinned run can still render", async () => {
    const h = await harness();
    const token = await admin(h);
    const first = await buildDocx([FIXED_PLACEHOLDERS.title]);
    await upload(h, token, first, "v1.docx");
    await upload(h, token, await buildDocx([]), "v2.docx");

    const response = await h.app.inject({
      method: "GET",
      url: "/doc-template/versions/1/file",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe(DOCX);
    // The SAME bytes that were uploaded: the bank's styles survive precisely
    // because nothing re-serialises them.
    expect(new Uint8Array(response.rawPayload)).toEqual(first);
  });

  it("refuses to invent a version that was never uploaded", async () => {
    const h = await harness();
    const token = await admin(h);
    await upload(h, token, await buildDocx([]));

    const response = await h.app.inject({
      method: "GET",
      url: "/doc-template/versions/7/file",
      headers: auth(token),
    });

    expect(response.statusCode).toBe(404);
    expect((response.json() as { error: string }).error).toBe("doc_template_version_not_found");
  });

  it("writes an audit line naming the placeholders the new template lacks", async () => {
    const h = await harness();
    const token = await admin(h);

    await upload(h, token, await buildDocx([FIXED_PLACEHOLDERS.title]));

    const events = await h.auditStore.read();
    const uploaded = events.find((event) => event.subject === "doc-template:1");
    expect(uploaded).toBeDefined();
    expect(uploaded?.actor).toBe("ayse.kaya@ugurbank.local");
    // The MISSING ones: this line exists so an auditor can see what the bank's
    // documents were not going to carry.
    expect(uploaded?.meta["missing"]).toContain(FIXED_PLACEHOLDERS.approvals);
  });
});
