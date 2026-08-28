import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SCREENS } from "../src/app/screens.ts";
import { Sidebar } from "../src/shell/Sidebar.tsx";
import { renderScreen, stubFetch } from "./harness.tsx";

/**
 * Menu honesty: screens whose backing capability is not live yet (eval,
 * security scans, runners, evidence) stay IN the sidebar — deep links must not
 * break — but wear a small "yakında" badge instead of posing as working tools.
 */

const SOON_IDS = ["eval", "security", "runners", "evidence"];

describe("sidebar 'yakında' badges", () => {
  it("marks exactly the unwired screens as soon in the route table", () => {
    const flagged = SCREENS.filter((row) => row.soon === true).map((row) => row.id);
    expect(flagged.sort()).toEqual([...SOON_IDS].sort());
  });

  it("renders the badge next to those entries and keeps them clickable", async () => {
    const { fetchImpl } = stubFetch([]);
    renderScreen(<Sidebar />, { fetchImpl });

    const badges = await screen.findAllByText("yakında");
    expect(badges).toHaveLength(SOON_IDS.length);

    // The entries are still links — badged, not hidden.
    expect(screen.getByRole("link", { name: /Sürüm kalite testi/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Güvenlik taramaları/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Kanıt paketi/ })).toBeInTheDocument();
  });
});
