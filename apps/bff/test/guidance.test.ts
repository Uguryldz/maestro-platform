import { describe, expect, it } from "vitest";
import { buildDocx } from "./docx-fixtures.js";
import { harness, type Harness } from "./helpers.js";

/**
 * Analysis guidance — the "öğren" library. Reading is open to any login; writing
 * (add / toggle / delete) is admin/tech-lead. The enabled notes are what the
 * analyst learns from, exposed on /studio/guidance/active for the pilot mirror.
 */

async function adminToken(h: Harness): Promise<string> {
  await h.addUser({ username: "ayse.kaya", roles: ["admin"] });
  return h.login("ayse.kaya");
}

function post(h: Harness, token: string, body: { title: string; content: string }) {
  return h.app.inject({
    method: "POST",
    url: "/studio/guidance",
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

describe("analysis guidance", () => {
  it("adds a note and lists it", async () => {
    const h = await harness();
    const token = await adminToken(h);

    const created = await post(h, token, { title: "Ekstre kuralı", content: "Son 12 ay ile sınırla." });
    expect(created.statusCode).toBe(201);
    expect(created.json().note).toMatchObject({ title: "Ekstre kuralı", enabled: true });

    const list = await h.app.inject({
      method: "GET",
      url: "/studio/guidance",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().notes).toHaveLength(1);
  });

  it("exposes only ENABLED notes on /active — what the analyst learns", async () => {
    const h = await harness();
    const token = await adminToken(h);

    const on = await post(h, token, { title: "A", content: "aktif" });
    const off = await post(h, token, { title: "B", content: "kapalı" });
    // Turn B off.
    await h.app.inject({
      method: "PUT",
      url: `/studio/guidance/${off.json().note.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { enabled: false },
    });

    const active = await h.app.inject({
      method: "GET",
      url: "/studio/guidance/active",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(active.json().notes).toHaveLength(1);
    expect(active.json().notes[0]).toMatchObject({ id: on.json().note.id, enabled: true });
  });

  it("toggles learning off without deleting the note", async () => {
    const h = await harness();
    const token = await adminToken(h);
    const created = await post(h, token, { title: "X", content: "y" });
    const id = created.json().note.id;

    const patched = await h.app.inject({
      method: "PUT",
      url: `/studio/guidance/${id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { enabled: false },
    });
    expect(patched.json().note.enabled).toBe(false);
    // Still present in the full list.
    const list = await h.app.inject({
      method: "GET",
      url: "/studio/guidance",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.json().notes).toHaveLength(1);
  });

  it("deletes a note", async () => {
    const h = await harness();
    const token = await adminToken(h);
    const id = (await post(h, token, { title: "X", content: "y" })).json().note.id;

    const del = await h.app.inject({
      method: "DELETE",
      url: `/studio/guidance/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(204);
    const list = await h.app.inject({
      method: "GET",
      url: "/studio/guidance",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.json().notes).toHaveLength(0);
  });

  it("refuses a write from a viewer (read is open, write is admin/tech-lead)", async () => {
    const h = await harness();
    await h.addUser({ username: "viewer1", roles: ["viewer"] });
    const token = await h.login("viewer1");

    const res = await post(h, token, { title: "X", content: "y" });
    expect(res.statusCode).toBe(403);
  });

  it("rejects an empty title/content", async () => {
    const h = await harness();
    const token = await adminToken(h);
    const res = await post(h, token, { title: "", content: "" });
    expect(res.statusCode).toBe(400);
  });
});

/**
 * File upload → note ("ajan eğitimi"). Studio posts { fileName, contentBase64 }
 * — no multipart. md/txt are UTF-8 text; docx goes through the same zip reader
 * the corporate template scan uses; everything else is refused by extension.
 */
describe("POST /studio/guidance/upload", () => {
  function upload(
    h: Harness,
    token: string,
    fileName: string,
    bytes: Uint8Array | string,
    variantId?: string,
  ) {
    const raw = typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes);
    return h.app.inject({
      method: "POST",
      url: "/studio/guidance/upload",
      headers: { authorization: `Bearer ${token}` },
      payload: {
        fileName,
        contentBase64: raw.toString("base64"),
        ...(variantId === undefined ? {} : { variantId }),
      },
    });
  }

  it("stores an .md file as an enabled note titled with the file name — UTF-8 intact", async () => {
    const h = await harness();
    const token = await adminToken(h);

    const res = await upload(h, token, "ekstre-kurallari.md", "# Kural\nEkstre SON 12 AY ile sınırlı — müşteri seçimi ne olursa olsun.");
    expect(res.statusCode).toBe(201);
    expect(res.json().note).toMatchObject({ title: "ekstre-kurallari.md", enabled: true });
    expect(res.json().note.content).toContain("SON 12 AY ile sınırlı");

    // It is an ordinary note from here on: listed, and active for the analyst.
    const active = await h.app.inject({
      method: "GET",
      url: "/studio/guidance/active",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(active.json().notes).toHaveLength(1);
  });

  it("extracts the visible text of a real .docx", async () => {
    const h = await harness();
    const token = await adminToken(h);
    const docx = await buildDocx(["Ekstre filtresi her zaman sunucuda doğrulanır"]);

    const res = await upload(h, token, "analiz-notu.docx", docx);
    expect(res.statusCode).toBe(201);
    const content = res.json().note.content as string;
    expect(content).toContain("Ekstre filtresi her zaman sunucuda doğrulanır");
    // Markup is stripped, not stored: the note is text, not Word XML.
    expect(content).not.toContain("<w:");
  });

  it("refuses a file that wears .docx but is not a Word package", async () => {
    const h = await harness();
    const token = await adminToken(h);
    const res = await upload(h, token, "sahte.docx", "bu bir zip değil");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("guidance_upload_type");
  });

  it("refuses an unsupported extension", async () => {
    const h = await harness();
    const token = await adminToken(h);
    const res = await upload(h, token, "rapor.pdf", "yüzde yüz pdf");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("guidance_upload_type");
  });

  it("refuses more text than the ~200KB note budget", async () => {
    const h = await harness();
    const token = await adminToken(h);
    const res = await upload(h, token, "dev.txt", "a".repeat(201 * 1024));
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("guidance_upload_too_large");
  });

  it("refuses a body that is not base64", async () => {
    const h = await harness();
    const token = await adminToken(h);
    const res = await h.app.inject({
      method: "POST",
      url: "/studio/guidance/upload",
      headers: { authorization: `Bearer ${token}` },
      payload: { fileName: "not.md", contentBase64: "%%%not-base64%%%" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_guidance_upload");
  });

  it("is write-gated like every other guidance write", async () => {
    const h = await harness();
    await h.addUser({ username: "viewer1", roles: ["viewer"] });
    const token = await h.login("viewer1");
    const res = await upload(h, token, "x.md", "içerik");
    expect(res.statusCode).toBe(403);
  });

  /**
   * Targeted upload — `variantId` scopes the note to ONE agent variant. The
   * round trip is asserted end to end: the create answers with the target, and
   * the note comes back with it on the library GET.
   */
  it("stores the target variant and returns it on GET /studio/guidance", async () => {
    const h = await harness();
    const token = await adminToken(h);

    const res = await upload(h, token, "web-kurallari.md", "Web ajanına özel kural.", "analyst-web");
    expect(res.statusCode).toBe(201);
    expect(res.json().note).toMatchObject({ title: "web-kurallari.md", variantId: "analyst-web" });

    const list = await h.app.inject({
      method: "GET",
      url: "/studio/guidance",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().notes[0]).toMatchObject({ variantId: "analyst-web" });
  });

  it("keeps an upload WITHOUT variantId global — variantId null, today's behaviour", async () => {
    const h = await harness();
    const token = await adminToken(h);

    const res = await upload(h, token, "genel.md", "Herkese giden not.");
    expect(res.statusCode).toBe(201);
    expect(res.json().note.variantId).toBeNull();
  });

  it("collapses a whitespace-only variantId to null (global), never an empty-string target", async () => {
    const h = await harness();
    const token = await adminToken(h);

    const res = await upload(h, token, "bosluk.md", "içerik", "   ");
    expect(res.statusCode).toBe(201);
    expect(res.json().note.variantId).toBeNull();
  });
});
