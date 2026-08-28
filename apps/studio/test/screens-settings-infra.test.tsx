import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SettingsScreen } from "../src/screens/Settings.tsx";
import { InfrastructurePanel } from "../src/screens/settings/InfrastructurePanel.tsx";
import { ADMIN, VIEWER, renderScreen, stubFetch } from "./harness.tsx";

/**
 * The read-only infrastructure section of the settings screen.
 *
 * The question this section exists to answer — "where is the engine pointed and
 * is it up?" — had no screen before it, because `/studio/connections` only ever
 * carried the connectors an operator typed in. The properties under test are
 * the ones that make the answer trustworthy: the engine row is actually
 * rendered, an unprobed row does not wear a green "connected" light, an
 * unconfigured row is shown rather than hidden, no write control appears, and
 * the database password never reaches the DOM.
 *
 * The payload mirrors the live deployment exactly (measured against
 * `GET /settings` on 16 Aug), including the two shapes of `connected`: probed
 * with a `checkedAt` stamp (temporal, database) and unprobed with none (jira,
 * llm, identity).
 */

/**
 * The probe stamp for the fixture rows.
 *
 * Deliberately well in the past rather than "now": `ageLabel` measures against
 * the real clock, so a stamp near the present would render as minutes today and
 * as hours or days later, and the assertion on the wording would rot on its own
 * without anyone touching the code. The freshly-probed wording is covered
 * separately by the test that generates its own current stamp.
 */
const NOW = "2020-01-01T00:00:00.000Z";

const SETTINGS = {
  path: "/settings",
  body: {
    connections: [
      {
        id: "temporal",
        endpoint: "localhost:7233",
        status: "connected",
        credentialRef: "none",
        checkedAt: NOW,
      },
      {
        id: "database",
        // Already masked by the BFF — the screen must render it verbatim.
        endpoint: "postgresql://maestro:***@localhost:55432/maestro",
        status: "connected",
        credentialRef: "DATABASE_URL",
        checkedAt: NOW,
      },
      {
        id: "llm",
        endpoint: "https://openrouter.ai/api (anthropic/claude-sonnet-4.5)",
        status: "connected",
        credentialRef: "kv/llm#apikey",
        checkedAt: null,
      },
      {
        id: "siem",
        endpoint: "",
        status: "unconfigured",
        credentialRef: "none",
        checkedAt: null,
      },
    ],
    notifyDrivers: [],
  },
};

/** The same table with the engine reported down, to pin the degraded path. */
const ENGINE_DOWN = {
  path: "/settings",
  body: {
    connections: [
      {
        id: "temporal",
        endpoint: "localhost:7233",
        status: "degraded",
        credentialRef: "none",
        checkedAt: NOW,
      },
    ],
    notifyDrivers: [],
  },
};

describe("infrastructure panel", () => {
  it("renders the engine row — the question that had no screen", async () => {
    const { fetchImpl } = stubFetch([SETTINGS]);
    renderScreen(<InfrastructurePanel />, { fetchImpl, session: ADMIN });

    const row = (await screen.findByText("İş akışı motoru (Temporal)")).closest("tr");
    expect(row).not.toBeNull();
    // The engine's address, and a probe that actually reached it.
    expect(within(row as HTMLElement).getByText("localhost:7233")).toBeInTheDocument();
    expect(within(row as HTMLElement).getByText("bağlı")).toBeInTheDocument();
  });

  it("renders the database and the LLM rows too", async () => {
    const { fetchImpl } = stubFetch([SETTINGS]);
    renderScreen(<InfrastructurePanel />, { fetchImpl, session: ADMIN });

    expect(await screen.findByText("Veritabanı (PostgreSQL)")).toBeInTheDocument();
    expect(screen.getByText("LLM (model ucu)")).toBeInTheDocument();
  });

  it("does not dress an UNPROBED row as connected — llm is 'yapılandırıldı'", async () => {
    const { fetchImpl } = stubFetch([SETTINGS]);
    renderScreen(<InfrastructurePanel />, { fetchImpl, session: ADMIN });

    const row = (await screen.findByText("LLM (model ucu)")).closest("tr") as HTMLElement;
    // The endpoint says "connected" for this row, but nobody probed it. The
    // screen must not repeat the green light.
    expect(within(row).getByText("yapılandırıldı")).toBeInTheDocument();
    expect(within(row).queryByText("bağlı")).not.toBeInTheDocument();
    expect(within(row).getByText("yoklanmadı")).toBeInTheDocument();
  });

  it("marks a PROBED row with when it was checked, not with 'yoklanmadı'", async () => {
    const { fetchImpl } = stubFetch([SETTINGS]);
    renderScreen(<InfrastructurePanel />, { fetchImpl, session: ADMIN });

    const row = (await screen.findByText("İş akışı motoru (Temporal)")).closest("tr") as HTMLElement;
    expect(within(row).queryByText("yoklanmadı")).not.toBeInTheDocument();
    // The fixture's stamp is days old, so this is the "{age} önce" branch.
    expect(within(row).getByText(/gün önce yoklandı/)).toBeInTheDocument();
  });

  it("does not double the adverb for a just-probed row ('az önce önce')", async () => {
    // Caught in the browser, not here: `age.now` is already "az önce", so the
    // "{age} önce yoklandı" template rendered "az önce ÖNCE yoklandı" (and
    // "probed just now ago" in English). The freshly-probed case gets its own
    // sentence. `checkedAt` is NOW, so ageLabel returns `age.now`.
    const fresh = {
      path: "/settings",
      body: {
        connections: [
          {
            id: "temporal",
            endpoint: "localhost:7233",
            status: "connected",
            credentialRef: "none",
            checkedAt: new Date().toISOString(),
          },
        ],
        notifyDrivers: [],
      },
    };
    const { fetchImpl } = stubFetch([fresh]);
    renderScreen(<InfrastructurePanel />, { fetchImpl, session: ADMIN });

    const row = (await screen.findByText("İş akışı motoru (Temporal)")).closest("tr") as HTMLElement;
    expect(within(row).getByText("az önce yoklandı")).toBeInTheDocument();
    expect(row.textContent).not.toContain("önce önce");
  });

  it("shows an unconfigured row rather than hiding it (M33 — siem)", async () => {
    const { fetchImpl } = stubFetch([SETTINGS]);
    renderScreen(<InfrastructurePanel />, { fetchImpl, session: ADMIN });

    const row = (await screen.findByText("SIEM")).closest("tr") as HTMLElement;
    // A connection missing from the table reads as "not part of the platform",
    // and audit forwarding very much is.
    expect(within(row).getByText("kurulmadı")).toBeInTheDocument();
    expect(within(row).getByText("adres tanımlı değil")).toBeInTheDocument();
    // "not set up" must never be dressed as "broken" — two different errands.
    expect(within(row).queryByText("sorunlu")).not.toBeInTheDocument();
  });

  it("reports a down engine as degraded (a real fault stays red)", async () => {
    const { fetchImpl } = stubFetch([ENGINE_DOWN]);
    renderScreen(<InfrastructurePanel />, { fetchImpl, session: ADMIN });

    const row = (await screen.findByText("İş akışı motoru (Temporal)")).closest("tr") as HTMLElement;
    expect(within(row).getByText("sorunlu")).toBeInTheDocument();
    expect(within(row).queryByText("bağlı")).not.toBeInTheDocument();
  });

  it("never lets a password reach the DOM, and does not re-mask the server's mask", async () => {
    const { fetchImpl } = stubFetch([SETTINGS]);
    renderScreen(<InfrastructurePanel />, { fetchImpl, session: ADMIN });
    await screen.findByText("Veritabanı (PostgreSQL)");

    // The whole rendered document, not just the endpoint cell — a secret that
    // leaked through some OTHER field would pass a single-cell assertion.
    const body = document.body.textContent ?? "";
    expect(body).not.toContain("s3cr3t");
    expect(body).not.toMatch(/maestro:[^*@\s]+@/);
    // The server's own mask survives verbatim — masking it twice would hide
    // whether the server did its job.
    expect(screen.getByText("postgresql://maestro:***@localhost:55432/maestro")).toBeInTheDocument();
  });

  it("carries NO write control — these values come from deploy/.env", async () => {
    const { fetchImpl } = stubFetch([SETTINGS]);
    renderScreen(<InfrastructurePanel />, { fetchImpl, session: ADMIN });
    await screen.findByText("İş akışı motoru (Temporal)");

    // Even for an admin: no edit, no delete, no live test on this table.
    // (The title appears twice — the card heading and the table's a11y caption.)
    const card = screen
      .getByRole("heading", { name: "Altyapı (salt okunur)" })
      .closest("section") as HTMLElement;
    expect(within(card).queryByRole("button")).not.toBeInTheDocument();
  });

  it("shows the same read-only facts to a viewer", async () => {
    const { fetchImpl } = stubFetch([SETTINGS]);
    renderScreen(<InfrastructurePanel />, { fetchImpl, session: VIEWER });
    expect(await screen.findByText("İş akışı motoru (Temporal)")).toBeInTheDocument();
  });

  it("states what makes it different from the editable panel", async () => {
    const { fetchImpl } = stubFetch([SETTINGS]);
    renderScreen(<InfrastructurePanel />, { fetchImpl, session: ADMIN });
    await screen.findByText("İş akışı motoru (Temporal)");
    expect(screen.getByText(/deploy\/\.env/)).toBeInTheDocument();
  });

  it("renders in English too (tr+en parity)", async () => {
    const { fetchImpl } = stubFetch([SETTINGS]);
    renderScreen(<InfrastructurePanel />, { fetchImpl, session: ADMIN, locale: "en" });

    expect(await screen.findByText("Workflow engine (Temporal)")).toBeInTheDocument();
    const row = (screen.getByText("LLM (model endpoint)")).closest("tr") as HTMLElement;
    expect(within(row).getByText("configured")).toBeInTheDocument();
    expect(within(row).getByText("not probed")).toBeInTheDocument();
  });
});

describe("settings screen wiring", () => {
  it("shows the infrastructure table BESIDE the editable connectors, not merged", async () => {
    const { fetchImpl } = stubFetch([
      SETTINGS,
      { path: "/studio/connections", body: { connections: [] } },
      { path: "/studio/killswitch", status: 404, body: { error: "not_found" } },
    ]);
    renderScreen(<SettingsScreen />, { fetchImpl, session: ADMIN });

    // Both headings are present, each with its own identity.
    expect(await screen.findByText("İş akışı motoru (Temporal)")).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Altyapı (salt okunur)" }),
    ).toBeInTheDocument();
    // …and the editable panel still keeps its own, separate heading.
    expect(screen.getByRole("heading", { name: "Bağlantılar" })).toBeInTheDocument();
  });
});
