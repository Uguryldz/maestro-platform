import { fireEvent, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashScreen } from "../src/screens/Dash.tsx";
import { StartGuide } from "../src/screens/setup/StartGuide.tsx";
import { GUIDE_DISMISSED_KEY, type SetupState } from "../src/screens/dash/setup-state.ts";
import { renderScreen, stubFetch } from "./harness.tsx";

/**
 * The start guide, and what the Panel keeps of it.
 *
 * The guide itself MOVED to the setup wizard (`screens-setup.test.tsx` covers
 * it there). What these tests pin down is the boundary that move created: the
 * Panel is a REPORT screen now, so the five-step checklist must not render on
 * it — while the platform's incompleteness must not become invisible either. A
 * Panel that quietly dropped the setup gap would be a worse regression than the
 * tutorial it replaced, so the one-line note and its link are asserted just as
 * hard as the guide's absence.
 *
 * The dismissal semantics are unchanged and still measured here: hiding is a
 * display preference, never a completion claim.
 */

const GUIDE_TITLE = "Hoş geldiniz — Maestro'yu 5 adımda çalışır hale getirin";
const PANEL_NOTE = "Kurulum henüz tamamlanmadı. Adımların tamamı Kurulum sihirbazında.";

const DONE: SetupState = {
  hasConn: true,
  hasBinding: true,
  hasTrainedAgent: true,
  hasWebhook: true,
  hasSweep: false,
  complete: true,
  loading: false,
};

function guideProps(over: Partial<SetupState> = {}): {
  setup: SetupState;
  onDismiss: () => void;
  onWebhookAck: () => void;
} {
  return { setup: { ...DONE, ...over }, onDismiss: vi.fn(), onWebhookAck: vi.fn() };
}

/** A Panel whose runs exist but whose setup is only partly done. */
function panelRoutes(
  over: { readonly variants?: unknown[]; readonly projects?: unknown[] } = {},
): readonly { path: string; body: unknown }[] {
  return [
    // 16 runs — the old rule would have hidden the guide on this alone.
    {
      path: "/studio/runs",
      body: {
        items: Array.from({ length: 16 }, (_, i) => ({
          ticketKey: `OPS-${i}`,
          title: `iş ${i}`,
          applicationId: "maestro-pilot",
          startedAt: "2026-08-16T10:00:00.000Z",
          state: { status: "fail", step: "10", risk: "dusuk", updatedAt: "2026-08-16T10:00:00.000Z" },
        })),
        nextCursor: null,
      },
    },
    { path: "/onboarding/jira-connections", body: { connections: [{ id: "jira" }] } },
    { path: "/onboarding/scm-connections", body: { connections: [] } },
    { path: "/routing", body: { projects: over.projects ?? [{ projectKey: "OPS" }] } },
    { path: "/variants", body: { variants: over.variants ?? [{ knowledgeFiles: 3 }] } },
  ];
}

beforeEach(() => {
  globalThis.localStorage?.clear();
});

describe("panel — setup guidance lives in the wizard now", () => {
  it("does NOT render the five-step guide, however incomplete the setup is", async () => {
    // Connections, binding and training are done; the WEBHOOK is not acked, so
    // this is the most "unfinished" a live platform gets — and still no guide.
    const { fetchImpl } = stubFetch(panelRoutes());
    renderScreen(<DashScreen />, { fetchImpl });

    // The note proves the setup reads settled and the Panel KNOWS it is open…
    expect(await screen.findByText(PANEL_NOTE)).toBeInTheDocument();
    // …and the checklist is not what it chose to say about it.
    expect(screen.queryByText(GUIDE_TITLE)).not.toBeInTheDocument();
    expect(screen.queryByText("Bağlantıları kur")).not.toBeInTheDocument();
    expect(screen.queryByText("Ticket girişini aç")).not.toBeInTheDocument();
    // The runs really did load, so this is a report screen showing its report.
    expect(screen.getByText("Aktif iş akışı")).toBeInTheDocument();
  });

  it("links to the wizard rather than leaving the operator to find it", async () => {
    const { fetchImpl } = stubFetch(panelRoutes());
    renderScreen(<DashScreen />, { fetchImpl });

    const link = await screen.findByRole("link", { name: "Kurulum sihirbazını aç" });
    expect(link.getAttribute("href")).toBe("/setup");
  });

  it("says nothing at all once every step is finished", async () => {
    globalThis.localStorage.setItem("maestro.setup.webhookAcked", "1");
    const { fetchImpl } = stubFetch(panelRoutes());
    renderScreen(<DashScreen />, { fetchImpl });

    expect(await screen.findByText("Aktif iş akışı")).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText(PANEL_NOTE)).not.toBeInTheDocument();
    });
    expect(screen.queryByText(GUIDE_TITLE)).not.toBeInTheDocument();
    // Nothing was hidden behind a "still incomplete" note either.
    expect(screen.queryByText("Kurulum hâlâ eksik; başlangıç rehberi gizlendi.")).toBeNull();
  });

  it("keeps admitting the gap after the note is dismissed", async () => {
    const { fetchImpl } = stubFetch(panelRoutes());
    renderScreen(<DashScreen />, { fetchImpl });

    fireEvent.click(await screen.findByText("Anladım, gizle"));

    // The preference is persisted, under the SAME key the guide always used —
    // a dismissal made here is one the wizard's guide honours too.
    expect(globalThis.localStorage.getItem(GUIDE_DISMISSED_KEY)).toBe("1");
    expect(screen.queryByText(PANEL_NOTE)).not.toBeInTheDocument();
    // …but "hide" did NOT become "done": the Panel still says setup is open.
    expect(screen.getByText("Kurulum hâlâ eksik; başlangıç rehberi gizlendi.")).toBeInTheDocument();
  });

  it("honours a previously stored dismissal on a fresh render", async () => {
    globalThis.localStorage.setItem(GUIDE_DISMISSED_KEY, "1");
    const { fetchImpl } = stubFetch(panelRoutes());
    renderScreen(<DashScreen />, { fetchImpl });

    expect(
      await screen.findByText("Kurulum hâlâ eksik; başlangıç rehberi gizlendi."),
    ).toBeInTheDocument();
    expect(screen.queryByText(PANEL_NOTE)).not.toBeInTheDocument();
    expect(screen.queryByText(GUIDE_TITLE)).not.toBeInTheDocument();
  });
});

describe("start guide — steps", () => {
  it("lists five steps including the webhook and nudges the first open one", () => {
    renderScreen(
      <StartGuide {...guideProps({ hasConn: false, hasWebhook: false, complete: false })} />,
    );

    expect(screen.getByText("Bağlantıları kur")).toBeInTheDocument();
    expect(screen.getByText("Projeni bağla")).toBeInTheDocument();
    expect(screen.getByText("Ticket girişini aç")).toBeInTheDocument();
    expect(screen.getByText("Ajanlarını belgelerle eğit")).toBeInTheDocument();
    expect(screen.getByText("Jira'da iş aç, Panel'den izle")).toBeInTheDocument();

    const nudges = screen.getAllByText("Şimdi bunu yap →");
    expect(nudges).toHaveLength(1);
    expect(screen.getByText("Bağlantıları kur").closest("button")).toContainElement(nudges[0]!);
  });

  it("moves the nudge to the webhook when it is the only open step", () => {
    renderScreen(<StartGuide {...guideProps({ hasWebhook: false, complete: false })} />);

    const webhook = screen.getByText("Ticket girişini aç").closest("button")!;
    expect(webhook.className).toContain("dash-start__step--next");
    expect(screen.getByText("Bağlantıları kur").closest("button")!.className).toContain(
      "dash-start__step--done",
    );
  });

  it("remembers the webhook acknowledgement, which no endpoint can report", () => {
    const props = guideProps({ hasWebhook: false, complete: false });
    renderScreen(<StartGuide {...props} />);

    fireEvent.click(screen.getByRole("checkbox"));

    expect(globalThis.localStorage.getItem("maestro.setup.webhookAcked")).toBe("1");
    expect(props.onWebhookAck).toHaveBeenCalledWith(true);
  });
});
