import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { EvalScreen } from "../src/screens/Eval.tsx";
import { VariantsScreen } from "../src/screens/Variants.tsx";
import { parseKnowledge } from "../src/screens/variants/knowledge.ts";
import { VariantScreen } from "../src/screens/Variant.tsx";
import { ADMIN, VIEWER, renderScreen, stubFetch } from "./harness.tsx";

/**
 * The agent-configuration screens: variant CRUD and the M78 eval gate.
 *
 * The properties under test are the ones the BFF also enforces, mirrored so a
 * UI that drifted from the server fails here: only an admin sees the write
 * controls, a create posts the fields the admin typed, and shipping a regression
 * requires a justification before the button does anything.
 */

const VARIANTS_LIST = {
  path: "/variants",
  body: {
    variants: [
      {
        variantId: "analyst-web",
        role: "analyst",
        platform: "web",
        model: "claude-opus-5",
        activeVersion: 2,
        knowledgeFiles: 2,
        evalScore: 91,
      },
    ],
  },
};

describe("variants screen", () => {
  it("lists the catalogue", async () => {
    const { fetchImpl } = stubFetch([VARIANTS_LIST]);
    renderScreen(<VariantsScreen />, { fetchImpl, session: ADMIN });
    expect(await screen.findByText("analyst-web")).toBeInTheDocument();
  });

  it("hides the add button from a non-admin", async () => {
    const { fetchImpl } = stubFetch([VARIANTS_LIST]);
    renderScreen(<VariantsScreen />, { fetchImpl, session: VIEWER });
    await screen.findByText("analyst-web");
    expect(screen.queryByRole("button", { name: "Ajan tanımı ekle" })).not.toBeInTheDocument();
  });

  it("creates a variant, posting the typed fields (never a forged author)", async () => {
    const { fetchImpl, calls } = stubFetch([
      VARIANTS_LIST,
      {
        path: "/variants",
        method: "POST",
        status: 201,
        body: { variantId: "engineer-mobile", role: "engineer", platform: "mobile-ios", activeVersion: 1 },
      },
    ]);
    renderScreen(<VariantsScreen />, { fetchImpl, session: ADMIN });

    await userEvent.click(await screen.findByRole("button", { name: "Ajan tanımı ekle" }));
    const dialog = await screen.findByRole("dialog");

    await userEvent.type(within(dialog).getByLabelText("Variant kimliği"), "engineer-mobile");
    await userEvent.type(within(dialog).getByLabelText("Platform"), "-ios");
    await userEvent.clear(within(dialog).getByLabelText("Model"));
    await userEvent.type(within(dialog).getByLabelText("Model"), "claude-opus-5");
    await userEvent.click(within(dialog).getByRole("button", { name: "Ajan tanımı ekle" }));

    await waitFor(() => {
      const post = calls.find((call) => call.method === "POST");
      expect(post).toBeDefined();
      expect(post?.body).toMatchObject({ variantId: "engineer-mobile", model: "claude-opus-5" });
      // The author is derived server-side from the session; the client never sends it.
      expect(post?.body).not.toHaveProperty("publishedBy");
    });
  });

  it("offers only the ENGINE-LIVE roles; the other four are visible but disabled '(yakında)'", async () => {
    const { fetchImpl } = stubFetch([VARIANTS_LIST]);
    renderScreen(<VariantsScreen />, { fetchImpl, session: ADMIN });

    await userEvent.click(await screen.findByRole("button", { name: "Ajan tanımı ekle" }));
    const dialog = await screen.findByRole("dialog");

    // The three roles the engine actually runs today are selectable…
    for (const live of ["alım", "analist", "geliştirici"]) {
      expect(within(dialog).getByRole("option", { name: live })).toBeEnabled();
    }
    // …and the dead ones are listed honestly: present, marked, unselectable.
    for (const dead of [
      "kod gözden geçiren (yakında)",
      "test tasarımcısı (yakında)",
      "test gözden geçiren (yakında)",
      "test mühendisi (yakında)",
    ]) {
      expect(within(dialog).getByRole("option", { name: dead })).toBeDisabled();
    }
  });
});

/** A run whose g2 golden ticket regressed (85 → 79). */
const REGRESSED = {
  goldenTickets: [
    { goldenId: "g1", sourceTicket: "P-1", kind: "analiz", expectation: "x", lastScore: 92 },
    { goldenId: "g2", sourceTicket: "P-2", kind: "analiz", expectation: "y", lastScore: 79 },
  ],
  lastRun: {
    runId: "run-1",
    variantId: "analyst-web",
    baselineVersion: 1,
    candidateVersion: 2,
    at: "2026-07-20T09:00:00.000Z",
    results: [
      { goldenId: "g1", baselineScore: 90, candidateScore: 92 },
      { goldenId: "g2", baselineScore: 85, candidateScore: 79 },
    ],
    decision: { status: "pending", justification: "", decidedBy: null, decidedAt: null },
  },
};

/** A variant detail with an active version 2 on `claude-opus-5`. */
const VARIANT_DETAIL = {
  path: "/variants/analyst-web",
  body: {
    variantId: "analyst-web",
    role: "analyst",
    platform: "web",
    model: "claude-opus-5",
    activeVersion: 2,
    persona: "mevcut persona",
    knowledge: [{ docId: "bddk-uyum.md", fileName: "bddk-uyum.md", category: "md", version: 2 }],
    versions: [
      { version: 2, publishedAt: "2026-07-20T09:00:00.000Z", publishedBy: "ayse@ugurbank.local", note: "v2", evalScore: 91 },
      { version: 1, publishedAt: "2026-07-01T09:00:00.000Z", publishedBy: "ayse@ugurbank.local", note: "ilk", evalScore: 88 },
    ],
  },
};

describe("variant detail screen — publish new version (M83)", () => {
  it("hides the write buttons from a non-admin", async () => {
    const { fetchImpl } = stubFetch([VARIANT_DETAIL]);
    renderScreen(<VariantScreen />, {
      fetchImpl,
      session: VIEWER,
      initialEntries: ["/variant?id=analyst-web"],
    });
    await screen.findByText("mevcut persona");
    expect(screen.queryByRole("button", { name: "Yeni sürüm yayınla" })).not.toBeInTheDocument();
  });

  it("publishes a new version with a different model, posting only versioned fields", async () => {
    const { fetchImpl, calls } = stubFetch([
      VARIANT_DETAIL,
      {
        path: "/variants/analyst-web/versions",
        method: "POST",
        status: 201,
        body: { ...VARIANT_DETAIL.body, model: "claude-sonnet-5", activeVersion: 3 },
      },
    ]);
    renderScreen(<VariantScreen />, {
      fetchImpl,
      session: ADMIN,
      initialEntries: ["/variant?id=analyst-web"],
    });

    // Open the "publish version" modal (seeded from the active version).
    await userEvent.click(await screen.findByRole("button", { name: "Yeni sürüm yayınla" }));
    const dialog = await screen.findByRole("dialog");

    // Change the MODEL — this is "model chosen from the UI".
    const model = within(dialog).getByLabelText("Model");
    await userEvent.clear(model);
    await userEvent.type(model, "claude-sonnet-5");
    await userEvent.type(within(dialog).getByLabelText("Sürüm notu"), "model yükseltildi");
    await userEvent.click(within(dialog).getByRole("button", { name: "Yeni sürüm yayınla" }));

    await waitFor(() => {
      const post = calls.find((call) => call.url.includes("/versions"));
      expect(post).toBeDefined();
      expect(post?.method).toBe("POST");
      expect(post?.body).toMatchObject({ model: "claude-sonnet-5", note: "model yükseltildi" });
      // Server-derived provenance is NEVER sent by the client (M83).
      expect(post?.body).not.toHaveProperty("version");
      expect(post?.body).not.toHaveProperty("publishedBy");
      expect(post?.body).not.toHaveProperty("publishedAt");
    });
  });
});

describe("eval screen (M78)", () => {
  it("shows the regression verdict on the run", async () => {
    const { fetchImpl } = stubFetch([{ path: "/eval", body: REGRESSED }]);
    renderScreen(<EvalScreen />, { fetchImpl, session: ADMIN });
    // The regressed golden ticket is flagged.
    expect(await screen.findByText("geriledi")).toBeInTheDocument();
  });

  it("keeps the ship button disabled until a regression is justified", async () => {
    const { fetchImpl } = stubFetch([{ path: "/eval", body: REGRESSED }]);
    renderScreen(<EvalScreen />, { fetchImpl, session: ADMIN });

    const ship = await screen.findByRole("button", { name: "Yayınla" });
    expect(ship).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Gerekçe"), "g2 bu üründe kritik değil");
    expect(ship).toBeEnabled();
  });

  it("posts the justification when shipping a regression", async () => {
    const { fetchImpl, calls } = stubFetch([
      { path: "/eval", body: REGRESSED },
      {
        path: "/eval/decisions",
        method: "POST",
        body: { ...REGRESSED.lastRun, decision: { status: "shipped", justification: "gerekçe", decidedBy: "x", decidedAt: "y" } },
      },
    ]);
    renderScreen(<EvalScreen />, { fetchImpl, session: ADMIN });

    await userEvent.type(await screen.findByLabelText("Gerekçe"), "gerekçe");
    await userEvent.click(screen.getByRole("button", { name: "Yayınla" }));

    await waitFor(() => {
      const post = calls.find((call) => call.url.includes("/eval/decisions"));
      expect(post?.body).toMatchObject({ runId: "run-1", status: "shipped", justification: "gerekçe" });
    });
  });

  it("shows a non-admin the read-only pending state, no buttons", async () => {
    const { fetchImpl } = stubFetch([{ path: "/eval", body: REGRESSED }]);
    renderScreen(<EvalScreen />, { fetchImpl, session: VIEWER });
    await screen.findByText("geriledi");
    expect(screen.queryByRole("button", { name: "Yayınla" })).not.toBeInTheDocument();
  });
});

describe("parseKnowledge", () => {
  it("splits on newlines and commas, trims and dedupes", () => {
    expect(parseKnowledge("a.md\nb.md, a.md\n\n c.md ")).toEqual(["a.md", "b.md", "c.md"]);
  });
});
