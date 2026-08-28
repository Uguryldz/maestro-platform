import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { KnowledgeScreen } from "../src/screens/Knowledge.tsx";
import { ADMIN, VIEWER, renderScreen, stubFetch } from "./harness.tsx";

/**
 * The guidance FILE upload ("ajan eğitimi" from a document). The browser reads
 * the file, posts `{ fileName, contentBase64 }` to the BFF, and on success the
 * library refetches AND mirrors the enabled set into the running pilot — the
 * same after-write path a typed note takes.
 */

const NOTE = {
  id: "ag_9",
  title: "kural.md",
  content: "Ekstre son 12 ay",
  enabled: true,
  updatedAt: "2026-08-13T10:00:00.000Z",
};

const ROUTES = [
  { path: "/studio/guidance", body: { notes: [] } },
  { path: "/studio/guidance/upload", method: "POST", status: 201, body: { note: NOTE } },
] as const;

/**
 * Choose a file. The input is hidden (`display:none` — the visible button
 * forwards its click), so this fires the change event directly rather than
 * going through user-event's visibility checks.
 */
function chooseFile(file: File): void {
  const input = document.querySelector('input[type="file"]');
  expect(input).not.toBeNull();
  fireEvent.change(input as HTMLInputElement, { target: { files: [file] } });
}

describe("guidance file upload", () => {
  it("posts the file as { fileName, contentBase64 } and mirrors nowhere else", async () => {
    const { fetchImpl, calls } = stubFetch([...ROUTES]);
    renderScreen(<KnowledgeScreen />, { fetchImpl, session: ADMIN });

    await screen.findByRole("button", { name: "Dosya yükle" });
    const content = "# Kural\nEkstre SON 12 AY ile sınırlı.";
    chooseFile(new File([content], "kural.md", { type: "text/markdown" }));

    await waitFor(() => {
      const post = calls.find(
        (call) => call.url.endsWith("/studio/guidance/upload") && call.method === "POST",
      );
      expect(post).toBeDefined();
      expect(post?.body).toMatchObject({ fileName: "kural.md" });
      // The bytes travel base64; decoded as UTF-8 they are the file, Turkish
      // characters intact (atob alone yields latin1 and would mangle them).
      const body = post?.body as { contentBase64: string };
      const bytes = Uint8Array.from(atob(body.contentBase64), (ch) => ch.charCodeAt(0));
      expect(new TextDecoder().decode(bytes)).toBe(content);
    });

    // The write used to be mirrored into the running pilot. That engine is
    // retired, and a call to it now would be a request to nothing.
    expect(calls.some((call) => call.url.includes("/studio/pilot/"))).toBe(false);
  });

  it("shows the translated refusal when the BFF rejects the file type", async () => {
    const { fetchImpl } = stubFetch([
      { path: "/studio/guidance", body: { notes: [] } },
      {
        path: "/studio/guidance/upload",
        method: "POST",
        status: 400,
        body: { error: "guidance_upload_type" },
      },
    ]);
    renderScreen(<KnowledgeScreen />, { fetchImpl, session: ADMIN });

    await screen.findByRole("button", { name: "Dosya yükle" });
    chooseFile(new File(["x"], "rapor.pdf"));

    expect(
      await screen.findByText("Yalnızca .md, .txt veya .docx dosyaları yüklenebilir."),
    ).toBeInTheDocument();
  });

  it("hides the upload button from a viewer (write is admin/tech-lead)", async () => {
    const { fetchImpl } = stubFetch([{ path: "/studio/guidance", body: { notes: [] } }]);
    renderScreen(<KnowledgeScreen />, { fetchImpl, session: VIEWER });

    await screen.findByText("Öğrenme kaynakları");
    expect(screen.queryByRole("button", { name: "Dosya yükle" })).not.toBeInTheDocument();
  });
});
