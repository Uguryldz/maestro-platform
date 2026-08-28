import { describe, expect, it } from "vitest";
import { InMemoryVariantCatalog, type VariantSeed } from "../src/stores/variant-memory.js";
import type { StudioReadModels } from "../src/read-studio.js";
import { auth } from "./helpers.js";
import { adminToken, memberToken, studioHarness } from "./studio-fixtures.js";

/**
 * The variant WRITE side (M38/M83).
 *
 * What is under test is the pair of promises the platform makes about agent
 * configuration: only an admin may change what an agent does on every ticket,
 * and a published version is never rewritten — a new version is appended, so a
 * run pinned to an older one keeps reading it (M83).
 */

const SEED: readonly VariantSeed[] = [
  {
    variantId: "analyst-web",
    role: "analyst",
    platform: "web",
    versions: [
      {
        version: 1,
        model: "claude-opus-5",
        persona: "eski persona",
        knowledgeRefs: ["bddk-uyum.md"],
        note: "ilk",
        publishedBy: "ayse.kaya@ugurbank.local",
        publishedAt: "2026-07-01T09:00:00.000Z",
        evalScore: 88,
      },
    ],
  },
];

/** A harness whose variant catalogue also answers the write side. */
async function writable(): Promise<
  Awaited<ReturnType<typeof studioHarness>> & { catalog: InMemoryVariantCatalog }
> {
  const catalog = new InMemoryVariantCatalog(SEED);
  const studio: StudioReadModels = { variants: catalog, variantWriter: catalog };
  const h = await studioHarness({ deps: { studio } });
  return Object.assign(h, { catalog });
}

const CREATE_BODY = {
  variantId: "engineer-mobile",
  role: "engineer",
  platform: "mobile-ios",
  model: "claude-opus-5",
  persona: "sen bir mobil mühendisisin",
  knowledgeRefs: ["kod-standartlari.md", "kod-standartlari.md"],
  note: "ilk yayın",
};

describe("POST /variants", () => {
  it("refuses an unauthenticated caller", async () => {
    const h = await writable();
    const response = await h.app.inject({ method: "POST", url: "/variants", payload: CREATE_BODY });
    expect(response.statusCode).toBe(401);
  });

  it("refuses a member without the admin role", async () => {
    const h = await writable();
    const token = await memberToken(h);
    const response = await h.app.inject({
      method: "POST",
      url: "/variants",
      headers: auth(token),
      payload: CREATE_BODY,
    });
    expect(response.statusCode).toBe(403);
  });

  it("creates a variant and publishes version 1 for an admin", async () => {
    const h = await writable();
    const token = await adminToken(h);
    const response = await h.app.inject({
      method: "POST",
      url: "/variants",
      headers: auth(token),
      payload: CREATE_BODY,
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as { variantId: string; activeVersion: number; knowledge: unknown[] };
    expect(body.variantId).toBe("engineer-mobile");
    expect(body.activeVersion).toBe(1);
    // The duplicate knowledge ref is deduped by the service.
    expect(body.knowledge).toHaveLength(1);
  });

  it("refuses creating over an existing variant rather than orphaning its history", async () => {
    const h = await writable();
    const token = await adminToken(h);
    const response = await h.app.inject({
      method: "POST",
      url: "/variants",
      headers: auth(token),
      payload: { ...CREATE_BODY, variantId: "analyst-web" },
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: string }).error).toBe("variant_exists");
  });

  it("validates the variant id grammar", async () => {
    const h = await writable();
    const token = await adminToken(h);
    const response = await h.app.inject({
      method: "POST",
      url: "/variants",
      headers: auth(token),
      payload: { ...CREATE_BODY, variantId: "NOT VALID" },
    });
    expect(response.statusCode).toBe(400);
  });

  it("refuses a persona carrying control characters", async () => {
    const h = await writable();
    const token = await adminToken(h);
    // A NUL smuggled into the persona — refused rather than stored.
    const persona = `satir${String.fromCharCode(0)}gizli`;
    const response = await h.app.inject({
      method: "POST",
      url: "/variants",
      headers: auth(token),
      payload: { ...CREATE_BODY, persona },
    });
    expect(response.statusCode).toBe(400);
  });

  it("derives the author and never takes it from the body", async () => {
    const h = await writable();
    const token = await adminToken(h, "yonetici");
    await h.app.inject({
      method: "POST",
      url: "/variants",
      headers: auth(token),
      // A forged author in the body must be ignored.
      payload: { ...CREATE_BODY, publishedBy: "someone.else@evil" },
    });
    const detail = await h.catalog.get("engineer-mobile");
    expect(detail?.versions[0]?.publishedBy).toBe("yonetici@ugurbank.local");
  });

  it("writes an audit line naming the created variant", async () => {
    const h = await writable();
    const token = await adminToken(h);
    await h.app.inject({
      method: "POST",
      url: "/variants",
      headers: auth(token),
      payload: CREATE_BODY,
    });
    const events = await h.auditStore.read();
    const created = events.find((event) => event.subject === "variant:engineer-mobile");
    expect(created).toBeDefined();
    expect(created?.meta["kind"]).toBe("variant_create");
  });

  it("refuses the write while the kill switch is on (M58)", async () => {
    const h = await writable();
    const token = await adminToken(h);
    await h.killSwitch.set({
      level: "all",
      actor: "yonetici@ugurbank.local",
      reason: "olay",
      at: "2026-08-09T10:00:00.000Z",
    });
    const response = await h.app.inject({
      method: "POST",
      url: "/variants",
      headers: auth(token),
      payload: CREATE_BODY,
    });
    expect(response.statusCode).toBe(409);
    expect((response.json() as { error: string }).error).toBe("kill_switch");
  });

  it("REFUSES by name when no writer is wired — never a silent success", async () => {
    // Read wired, write not: the read-only deployment the Prisma catalogue is.
    const catalog = new InMemoryVariantCatalog(SEED);
    const h = await studioHarness({ deps: { studio: { variants: catalog } } });
    const token = await adminToken(h);
    const response = await h.app.inject({
      method: "POST",
      url: "/variants",
      headers: auth(token),
      payload: CREATE_BODY,
    });
    expect(response.statusCode).toBe(503);
    expect((response.json() as { details: { capability: string } }).details.capability).toBe("variants");
  });
});

describe("PUT /variants/:variantId", () => {
  it("edits the platform overlay for an admin, leaving versions untouched", async () => {
    const h = await writable();
    const token = await adminToken(h);
    const response = await h.app.inject({
      method: "PUT",
      url: "/variants/analyst-web",
      headers: auth(token),
      payload: { platform: "mobile-android" },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { platform: string; activeVersion: number };
    expect(body.platform).toBe("mobile-android");
    // The edit does not publish a version.
    expect(body.activeVersion).toBe(1);
  });

  it("404s an unknown variant", async () => {
    const h = await writable();
    const token = await adminToken(h);
    const response = await h.app.inject({
      method: "PUT",
      url: "/variants/yok-boyle",
      headers: auth(token),
      payload: { platform: "web" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("refuses a member", async () => {
    const h = await writable();
    const token = await memberToken(h);
    const response = await h.app.inject({
      method: "PUT",
      url: "/variants/analyst-web",
      headers: auth(token),
      payload: { platform: "web" },
    });
    expect(response.statusCode).toBe(403);
  });
});

describe("POST /variants/:variantId/versions (M83 append-only)", () => {
  it("appends a new version without rewriting the previous one", async () => {
    const h = await writable();
    const token = await adminToken(h);

    const response = await h.app.inject({
      method: "POST",
      url: "/variants/analyst-web/versions",
      headers: auth(token),
      payload: {
        model: "claude-opus-5",
        persona: "yeni persona",
        knowledgeRefs: ["bddk-uyum.md", "musteri-iletisim.md"],
        note: "iletişim başlığı",
      },
    });

    expect(response.statusCode).toBe(201);
    const body = response.json() as {
      activeVersion: number;
      persona: string;
      versions: { version: number; note: string }[];
    };
    expect(body.activeVersion).toBe(2);
    expect(body.persona).toBe("yeni persona");
    expect(body.versions).toHaveLength(2);

    // Version 1 is UNCHANGED — a run pinned to it still reads the old persona.
    const detail = await h.catalog.get("analyst-web");
    const v1 = detail?.versions.find((version) => version.version === 1);
    expect(v1?.note).toBe("ilk");
    const full = await h.catalog.get("analyst-web");
    expect(full).not.toBeNull();
  });

  it("scores a freshly published version as null, never zero", async () => {
    const h = await writable();
    const token = await adminToken(h);
    const response = await h.app.inject({
      method: "POST",
      url: "/variants/analyst-web/versions",
      headers: auth(token),
      payload: { model: "claude-opus-5", persona: "p", knowledgeRefs: [], note: "" },
    });
    const body = response.json() as { versions: { version: number; evalScore: number | null }[] };
    const v2 = body.versions.find((version) => version.version === 2);
    // Never evaluated is not a score of zero.
    expect(v2?.evalScore).toBeNull();
  });

  it("404s an unknown variant", async () => {
    const h = await writable();
    const token = await adminToken(h);
    const response = await h.app.inject({
      method: "POST",
      url: "/variants/yok-boyle/versions",
      headers: auth(token),
      payload: { model: "m", persona: "p", knowledgeRefs: [], note: "" },
    });
    expect(response.statusCode).toBe(404);
  });

  it("refuses a member", async () => {
    const h = await writable();
    const token = await memberToken(h);
    const response = await h.app.inject({
      method: "POST",
      url: "/variants/analyst-web/versions",
      headers: auth(token),
      payload: { model: "m", persona: "p", knowledgeRefs: [], note: "" },
    });
    expect(response.statusCode).toBe(403);
  });
});
