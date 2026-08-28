import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { VariantScreen } from "../src/screens/Variant.tsx";
import { ADMIN, VIEWER, renderScreen, stubFetch } from "./harness.tsx";

/**
 * The agent-targeted knowledge upload (Variant → Knowledge tab). A document
 * uploaded HERE must carry `variantId` — that is the whole point: the note
 * feeds ONE agent, unlike the Knowledge screen's global upload. And the list
 * under the button shows ONLY this agent's notes, not the global ones and not
 * another agent's.
 */

const DETAIL = {
  path: "/variants/analyst-web",
  body: {
    variantId: "analyst-web",
    role: "analyst",
    platform: "web",
    model: "claude-opus-5",
    activeVersion: 2,
    persona: "mevcut persona",
    knowledge: [{ docId: "bddk-uyum.md", fileName: "bddk-uyum.md", category: "md", version: 2 }],
    versions: [],
  },
};

/** Global note + a note for THIS agent + a note for ANOTHER agent. */
const NOTES = [
  { id: "ag_1", title: "genel-kural.md", content: "herkese", enabled: true, updatedAt: "2026-08-14T10:00:00.000Z", variantId: null },
  { id: "ag_2", title: "web-ozel.md", content: "yalnız web", enabled: true, updatedAt: "2026-08-14T11:00:00.000Z", variantId: "analyst-web" },
  { id: "ag_3", title: "mobil-ozel.md", content: "yalnız mobil", enabled: false, updatedAt: "2026-08-14T12:00:00.000Z", variantId: "engineer-mobile" },
];

const ROUTES = [
  DETAIL,
  { path: "/studio/guidance", body: { notes: NOTES } },
  {
    path: "/studio/guidance/upload",
    method: "POST",
    status: 201,
    body: { note: { id: "ag_9", title: "yeni.md", content: "x", enabled: true, updatedAt: "2026-08-15T09:00:00.000Z", variantId: "analyst-web" } },
  },
] as const;

/** Fire the hidden file input directly (display:none defeats user-event). */
function chooseFile(file: File): void {
  const input = document.querySelector('input[type="file"]');
  expect(input).not.toBeNull();
  fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });
}

async function openKnowledgeTab(): Promise<void> {
  await userEvent.click(await screen.findByRole("tab", { name: /Knowledge/ }));
}

describe("variant detail — knowledge tab, targeted guidance", () => {
  it("lists ONLY this agent's notes — global and other-agent notes stay out", async () => {
    const { fetchImpl } = stubFetch([...ROUTES]);
    renderScreen(<VariantScreen />, {
      fetchImpl,
      session: ADMIN,
      initialEntries: ["/variant?id=analyst-web"],
    });

    await openKnowledgeTab();
    expect(await screen.findByText("web-ozel.md")).toBeInTheDocument();
    expect(screen.queryByText("genel-kural.md")).not.toBeInTheDocument();
    expect(screen.queryByText("mobil-ozel.md")).not.toBeInTheDocument();
    // The version's knowledgeRefs table is still there, honestly labelled.
    expect(screen.getByText("bddk-uyum.md")).toBeInTheDocument();
    expect(screen.getByText("Sürüme yazılı dosya adları (etiket)")).toBeInTheDocument();
  });

  it("counts the targeted notes into the Knowledge tab badge", async () => {
    const { fetchImpl } = stubFetch([...ROUTES]);
    renderScreen(<VariantScreen />, {
      fetchImpl,
      session: ADMIN,
      initialEntries: ["/variant?id=analyst-web"],
    });

    // 1 targeted note + 1 knowledgeRef = 2.
    const tab = await screen.findByRole("tab", { name: /Knowledge/ });
    await waitFor(() => expect(tab).toHaveTextContent("Knowledge2"));
  });

  it("uploads a document WITH this variant’s id, and mirrors nowhere else", async () => {
    const { fetchImpl, calls } = stubFetch([...ROUTES]);
    renderScreen(<VariantScreen />, {
      fetchImpl,
      session: ADMIN,
      initialEntries: ["/variant?id=analyst-web"],
    });

    await openKnowledgeTab();
    await screen.findByRole("button", { name: "Bu ajana belge yükle" });
    chooseFile(new File(["# Kural\nWeb ajanına özel."], "yeni.md", { type: "text/markdown" }));

    await waitFor(() => {
      const post = calls.find(
        (call) => call.url.endsWith("/studio/guidance/upload") && call.method === "POST",
      );
      expect(post).toBeDefined();
      // The target travels with the file — this is what makes it agent-scoped.
      expect(post?.body).toMatchObject({ fileName: "yeni.md", variantId: "analyst-web" });
    });

    // The write used to be mirrored into the running pilot. That engine is
    // retired, and a call to it now would be a request to nothing.
    expect(calls.some((call) => call.url.includes("/studio/pilot/"))).toBe(false);
  });

  it("hides the upload button and actions from a viewer (write is admin/tech-lead)", async () => {
    const { fetchImpl } = stubFetch([...ROUTES]);
    renderScreen(<VariantScreen />, {
      fetchImpl,
      session: VIEWER,
      initialEntries: ["/variant?id=analyst-web"],
    });

    await openKnowledgeTab();
    await screen.findByText("web-ozel.md");
    expect(screen.queryByRole("button", { name: "Bu ajana belge yükle" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sil" })).not.toBeInTheDocument();
  });
});
