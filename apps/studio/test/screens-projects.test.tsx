import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ProjectsScreen } from "../src/screens/Projects.tsx";
import { renderScreen, stubFetch } from "./harness.tsx";

/**
 * The projects page gathers the three binding steps into one page with three
 * tabs (add application / Jira mapping & approval / listening rules). The tests
 * here cover the page's OWN behaviour — the tab strip and which tab the URL
 * selects — not the three screens' internals, which have their own suites.
 *
 * Each tab renders a real screen that fetches, so the stub answers the endpoints
 * those screens hit on mount; the assertions are about the tabs, not the data.
 */

// The endpoints the three tabbed screens call on mount, answered emptily.
const STUBS = [
  { path: "/onboarding/options", body: { jiraProjects: [], adoRepos: [], platforms: [] } },
  { path: "/onboarding/jira-connections", body: { connections: [] } },
  { path: "/onboarding/scm-connections", body: { connections: [] } },
  { path: "/onboarding/pending", body: { items: [] } },
  { path: "/routing", body: { projects: [], rules: [], policy: { backendByClass: {}, whenOnpremMissing: "block" } } },
  { path: "/studio/apps", body: { items: [], nextCursor: null } },
  { path: "/studio/listening-rules", body: { rules: [] } },
];

describe("projects page (tabbed binding)", () => {
  it("shows the three tabs in the operator's order", async () => {
    const { fetchImpl } = stubFetch(STUBS);
    renderScreen(<ProjectsScreen />, { fetchImpl, initialEntries: ["/projects"] });

    // Tabs are now numbered so their order reads as steps ("1 · …").
    const tabs = await screen.findAllByRole("tab");
    expect(tabs.map((el) => el.textContent)).toEqual([
      "1 · Uygulama ekle",
      "2 · Bağlı projeler & onay",
      "3 · Dinleme kuralları",
    ]);
    // Default tab is the first step: add application.
    expect(screen.getByRole("tab", { name: /Uygulama ekle/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("opens on the bound-projects list when something is already bound", async () => {
    // A fresh install lands on "add application"; once a project is bound, the
    // page must open on the LIST so the admin sees what they bound instead of an
    // empty add-form ("bağladığım uygulamayı göremiyorum").
    const withBinding = STUBS.map((s) =>
      s.path === "/routing"
        ? {
            path: "/routing",
            body: {
              projects: [
                { projectKey: "OPS", trigger: "label", apps: ["Uguryldz/maestro-pilot"], noteKey: "routing.note.active_label", noteParams: { label: "maestro" } },
              ],
              rules: [],
              policy: { backendByClass: {}, whenOnpremMissing: "block" },
            },
          }
        : s,
    );
    const { fetchImpl } = stubFetch(withBinding);
    renderScreen(<ProjectsScreen />, { fetchImpl, initialEntries: ["/projects"] });

    // The default flips only after the /routing query resolves, so wait for it.
    await waitFor(() =>
      expect(screen.getByRole("tab", { name: /Bağlı projeler & onay/ })).toHaveAttribute(
        "aria-selected",
        "true",
      ),
    );
  });

  it("selects the tab named in the URL (?tab=)", async () => {
    const { fetchImpl } = stubFetch(STUBS);
    renderScreen(<ProjectsScreen />, {
      fetchImpl,
      initialEntries: ["/projects?tab=listening"],
    });

    expect(
      (await screen.findByRole("tab", { name: /Dinleme kuralları/ })).getAttribute("aria-selected"),
    ).toBe("true");
    expect(screen.getByRole("tab", { name: /Uygulama ekle/ })).toHaveAttribute(
      "aria-selected",
      "false",
    );
  });

  it("switches the active tab when another is clicked", async () => {
    const { fetchImpl } = stubFetch(STUBS);
    renderScreen(<ProjectsScreen />, { fetchImpl, initialEntries: ["/projects"] });

    await userEvent.click(await screen.findByRole("tab", { name: /Bağlı projeler & onay/ }));
    expect(screen.getByRole("tab", { name: /Bağlı projeler & onay/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("shows the how-it-works journey strip with all three steps", async () => {
    const { fetchImpl } = stubFetch(STUBS);
    renderScreen(<ProjectsScreen />, { fetchImpl, initialEntries: ["/projects"] });

    // The journey heading and each step's one-line hint are present, so a
    // first-time admin sees the sequence and what each step does.
    expect(await screen.findByText(/3 adımda proje bağlama/)).toBeInTheDocument();
    expect(screen.getByText(/İkinci bir yönetici onaylar/)).toBeInTheDocument();
    expect(screen.getByText(/Hangi ticket'lar işlensin/)).toBeInTheDocument();
  });
});
