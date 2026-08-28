import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DashScreen } from "../src/screens/Dash.tsx";
import { renderScreen, stubFetch } from "./harness.tsx";

/**
 * The Panel after the pilot engine was retired.
 *
 * This file used to characterise a "Canlı motor işleri" section fed by
 * `/studio/pilot/state` and `/studio/pilot/runs`, plus three banner tones for
 * the ways that poll could fail. All of it is gone: the Panel reads ONE engine
 * now, through `/studio/runs`. What remains here is the honest label on the DB
 * list, and a guard that the pilot section cannot come back — asserted with the
 * pilot routes still answering, so a re-added query would light the section up
 * and fail rather than pass for want of a fixture.
 */

const DB_RUN = {
  ticketKey: "UGURPAY-1",
  title: "Ekstre filtresi",
  appId: "ugurpay",
  mode: "full_auto",
  risk: "orta",
  dataClass: "dahili",
  parentTicketKey: null,
  childTicketKeys: [],
  reporter: "ayse@corp",
  assignee: null,
  prId: null,
  costUsd: 0,
  tokensIn: 0,
  tokensOut: 0,
  startedAt: "2026-08-12T09:00:00.000Z",
  updatedAt: "2026-08-12T09:00:00.000Z",
  state: null,
};

/** StartGuide's four reads, so the Panel renders whole. */
const GUIDE_ROUTES = [
  { path: "/onboarding/jira-connections", body: { connections: [] } },
  { path: "/onboarding/scm-connections", body: { connections: [] } },
  { path: "/routing", body: { projects: [], rules: [], policy: null } },
  { path: "/studio/listening-rules", body: { rules: [] } },
];

describe("dash — one engine, read through /studio/runs", () => {
  it("labels the DB list honestly as archive/sample records", async () => {
    const { fetchImpl } = stubFetch([
      { path: "/studio/runs", body: { items: [DB_RUN], nextCursor: null } },
      ...GUIDE_ROUTES,
    ]);
    renderScreen(<DashScreen />, { fetchImpl });

    expect(await screen.findByText("Arşiv / örnek kayıtlar")).toBeInTheDocument();
    expect(screen.getByText(/Veritabanındaki iş kayıtları/)).toBeInTheDocument();
  });

  it("has no pilot section and never calls the retired engine, even when it would answer", async () => {
    const { fetchImpl, calls } = stubFetch([
      { path: "/studio/runs", body: { items: [DB_RUN], nextCursor: null } },
      { path: "/studio/pilot/state", body: { running: true, ticketKey: "OPS-9" } },
      {
        path: "/studio/pilot/runs",
        body: {
          runs: [
            {
              runId: "r1",
              ticketKey: "OPS-7",
              browseUrl: null,
              flowType: "duzeltme",
              outcome: "tamamlandı",
              detail: null,
              stepsDone: 9,
              stepsTotal: 9,
              finishedAt: "2026-08-13T09:00:00.000Z",
            },
          ],
        },
      },
      ...GUIDE_ROUTES,
    ]);
    renderScreen(<DashScreen />, { fetchImpl });

    // Wait for the screen to settle on real data before asserting absence.
    expect(await screen.findByText("Arşiv / örnek kayıtlar")).toBeInTheDocument();

    expect(screen.queryByText("Canlı motor işleri")).not.toBeInTheDocument();
    expect(screen.queryByText("OPS-9")).not.toBeInTheDocument();
    expect(screen.queryByText("OPS-7")).not.toBeInTheDocument();
    // The three retired banner tones.
    expect(screen.queryByText("Akış motoru yanıt vermiyor")).not.toBeInTheDocument();
    expect(screen.queryByText("Motor durumu okunamadı")).not.toBeInTheDocument();
    expect(screen.queryByText(/Prova motoru \(pilot\)/)).not.toBeInTheDocument();

    expect(calls.some((call) => call.url.includes("/studio/pilot/"))).toBe(false);
  });
});
