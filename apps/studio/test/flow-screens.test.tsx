import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { AuthProvider } from "../src/auth/AuthProvider.tsx";
import type { Session } from "../src/auth/types.ts";
import { I18nProvider } from "../src/i18n/I18nProvider.tsx";
import { ClarifyScreen } from "../src/screens/Clarify.tsx";
import { DashScreen } from "../src/screens/Dash.tsx";
import { DetailScreen } from "../src/screens/Detail.tsx";
import { EvidenceScreen } from "../src/screens/Evidence.tsx";
import { FanoutScreen } from "../src/screens/Fanout.tsx";
import { LiveScreen } from "../src/screens/Live.tsx";
import { TicketsScreen } from "../src/screens/Tickets.tsx";
import { WorkmodeScreen } from "../src/screens/Workmode.tsx";
import { toRunList, toRunRow, MAX_RUN_PAGE } from "../src/screens/shared/runs.ts";
import { ToastProvider } from "../src/ui/Toast.tsx";

/**
 * Flow screens (dash, tickets, detail, live, clarify, workmode, fanout,
 * evidence, jira).
 *
 * Every test drives a stub fetch: test/setup.ts makes the global one throw, so
 * a screen that bypasses the ApiClient fails here rather than silently hitting
 * the network.
 */

const TECH_LEAD: Session = {
  userId: "ayse.kaya@ugurbank.local",
  username: "ayse.kaya",
  roles: ["tech-lead"],
  groups: ["maestro-ugurpay"],
  delegated: false,
  expiresAt: "2099-01-01T00:00:00.000Z",
};

const QA: Session = { ...TECH_LEAD, roles: ["qa"], username: "deniz.yilmaz" };
const DELEGATED_TECH_LEAD: Session = { ...TECH_LEAD, delegated: true };

/**
 * A catalog record exactly as `read-models.ts:RunRecord` sends it. Every field
 * is present because the BFF sends every field; a fixture that quietly dropped
 * one would let a screen read `undefined` and still pass.
 */
function record(
  ticketKey: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ticketKey,
    title: `${ticketKey} konusu`,
    appId: "odeme-servisi",
    mode: "ai_assist",
    risk: "orta",
    dataClass: "dahili",
    parentTicketKey: null,
    childTicketKeys: [],
    reporter: "mehmet.demir@ugurbank",
    assignee: null,
    prId: null,
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    startedAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
    ...extra,
  };
}

/** The workflow state the BFF joins onto a record; `null` when none exists. */
function state(
  ticketKey: string,
  status: string,
  step: string,
  startedAt = "2026-08-01T09:00:00.000Z",
): Record<string, unknown> {
  return {
    runId: `run-${ticketKey}`,
    ticketKey,
    step,
    status,
    risk: "orta",
    startedAt,
    updatedAt: "2026-08-06T09:00:00.000Z",
  };
}

/**
 * The rows `GET /studio/runs` sends: catalog record + nested `state`, wrapped in
 * the shared `{ items, nextCursor }` envelope. The statuses are the WORKFLOW
 * vocabulary (gate/done/fail), not Temporal's (running/completed/failed) — a
 * screen still speaking the old dictionary matches nothing here and renders an
 * empty list, which is precisely the silent failure these tests exist to catch.
 */
const RUN_ITEMS = [
  {
    ...record("UGURPAY-501"),
    state: state("UGURPAY-501", "running", "6a"),
  },
  {
    ...record("UGURPAY-478", {
      startedAt: "2026-07-28T09:00:00.000Z",
      prId: 4821,
      assignee: "ayse.kaya@ugurbank",
      costUsd: 1.5,
      tokensIn: 1200,
      tokensOut: 340,
    }),
    state: state("UGURPAY-478", "done", "13", "2026-07-28T09:00:00.000Z"),
  },
  {
    ...record("UGURDESK-45", { startedAt: "2026-07-20T09:00:00.000Z", appId: null }),
    state: state("UGURDESK-45", "fail", "6b", "2026-07-20T09:00:00.000Z"),
  },
  {
    ...record("UGURPAY-777", { startedAt: "2026-08-02T09:00:00.000Z" }),
    state: state("UGURPAY-777", "gate", "12", "2026-08-02T09:00:00.000Z"),
  },
  // Parked on step 2b — the clarification wait. Only the joined state can say
  // so; `/runs` reported this as an ordinary "running" execution.
  {
    ...record("UGURPAY-712", { startedAt: "2026-08-04T09:00:00.000Z" }),
    state: state("UGURPAY-712", "gate", "2b", "2026-08-04T09:00:00.000Z"),
  },
  // A catalog row whose workflow never started. The BFF lists it with a null
  // state rather than hiding it, so the screens must render it, not crash.
  {
    ...record("UGURPAY-900", { startedAt: "2026-08-03T09:00:00.000Z" }),
    state: null,
  },
];

const RUN_PAGE = { items: RUN_ITEMS, nextCursor: null };

/** `GET /studio/runs/:ticket` — record, live state and matched application. */
const GATE_DETAIL = {
  run: record("UGURPAY-501", {
    prId: 4821,
    assignee: "ayse.kaya@ugurbank",
    costUsd: 2.25,
    tokensIn: 5000,
    tokensOut: 900,
  }),
  state: state("UGURPAY-501", "gate", "12"),
  application: {
    appId: "odeme-servisi",
    displayName: "Ödeme Servisi",
    adoProject: "UgurBank",
    adoRepo: "odeme-servisi",
    platform: "dotnet",
    jiraComponent: null,
    maestroYamlPresent: true,
    createdVia: "onboarding",
  },
};

/**
 * A journal page exactly as `GET /studio/runs/:ticket/journal` sends it: the
 * shared `{ items, nextCursor }` envelope from routes/paging.ts, not `{ entries }`.
 * The field name is load-bearing — a screen reading `entries` off this body
 * renders an empty journal with no error at all.
 */
const JOURNAL = [
  {
    runId: "run-501-aaaaaaaa",
    seq: 1,
    at: "2026-08-01T09:05:00.000Z",
    actor: "ai",
    kind: "analysis",
    title: "Analiz belgesi üretildi",
    detail: "",
  },
  {
    runId: "run-501-aaaaaaaa",
    seq: 2,
    at: "2026-08-01T10:15:00.000Z",
    actor: "human",
    kind: "gate",
    title: "Kapı onayı verildi",
    detail: "",
  },
];

interface Call {
  readonly url: string;
  readonly method: string;
  readonly body: unknown;
}

/** A fetch stub that answers from a routing table and records every call. */
function stubFetch(routes: Readonly<Record<string, () => Response>>): {
  fetchImpl: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({
      url,
      method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    // Longest prefix wins, so "/api/runs/X" never shadows "/api/runs/X/signals/...".
    const key = Object.keys(routes)
      .filter((route) => url.startsWith(route))
      .sort((a, b) => b.length - a.length)[0];
    if (key === undefined) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    return routes[key]!();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function renderScreen(
  ui: ReactNode,
  options: { fetchImpl: typeof fetch; session?: Session; route?: string; path?: string } ,
): void {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  render(
    <I18nProvider initialLocale="tr">
      <QueryClientProvider client={queryClient}>
        <AuthProvider
          fetchImpl={options.fetchImpl}
          initialSession={options.session ?? TECH_LEAD}
          initialToken="test-token"
        >
          <ToastProvider>
            <MemoryRouter initialEntries={[options.route ?? "/"]}>
              {options.path === undefined ? (
                ui
              ) : (
                <Routes>
                  <Route path={options.path} element={ui} />
                </Routes>
              )}
            </MemoryRouter>
          </ToastProvider>
        </AuthProvider>
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe("tickets", () => {
  it("lists runs from GET /studio/runs and filters by workflow status", async () => {
    const { fetchImpl } = stubFetch({ "/api/studio/runs": () => json(RUN_PAGE) });
    renderScreen(<TicketsScreen />, { fetchImpl });

    await waitFor(() => expect(screen.getByText("UGURPAY-501")).toBeInTheDocument());
    expect(screen.getByText("UGURPAY-478")).toBeInTheDocument();
    expect(screen.getByText("UGURDESK-45")).toBeInTheDocument();

    // "Tamamlandı (1)" — the count is derived, not hard-coded.
    await userEvent.click(screen.getByRole("button", { name: /Tamamlandı \(1\)/ }));
    expect(screen.getByText("UGURPAY-478")).toBeInTheDocument();
    expect(screen.queryByText("UGURPAY-501")).not.toBeInTheDocument();
    expect(screen.queryByText("UGURDESK-45")).not.toBeInTheDocument();
  });

  /**
   * The capability the Temporal-backed list could not offer at all: "at a
   * gate" is a workflow status, and `/runs` collapsed it into "running".
   */
  it("filters to runs parked at a gate", async () => {
    const { fetchImpl } = stubFetch({ "/api/studio/runs": () => json(RUN_PAGE) });
    renderScreen(<TicketsScreen />, { fetchImpl });

    await waitFor(() => expect(screen.getByText("UGURPAY-501")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: /Kapıda \(2\)/ }));

    expect(screen.getByText("UGURPAY-777")).toBeInTheDocument();
    expect(screen.queryByText("UGURPAY-501")).not.toBeInTheDocument();
  });

  /** Enrichment: fields that only exist on the catalog record. */
  it("shows the title, application, step, risk and mode from the record", async () => {
    const { fetchImpl } = stubFetch({ "/api/studio/runs": () => json(RUN_PAGE) });
    renderScreen(<TicketsScreen />, { fetchImpl });

    await waitFor(() => expect(screen.getByText("UGURPAY-501 konusu")).toBeInTheDocument());
    expect(screen.getAllByText("odeme-servisi").length).toBeGreaterThan(0);
    // step 6a on the running row, translated from the contract's step table
    expect(screen.getAllByText("6a").length).toBeGreaterThan(0);
    expect(screen.getAllByText("orta").length).toBeGreaterThan(0);
    // TRANSLATED, not `ai_assist`. This assertion used to require the raw
    // enum, which is how the same table came to show a Turkish risk ("orta")
    // beside an English mode — two languages in two adjacent columns.
    expect(screen.getAllByText("AI destekli").length).toBeGreaterThan(0);
    expect(screen.queryByText("ai_assist")).not.toBeInTheDocument();
  });

  /**
   * A row whose workflow has not started carries `state: null`. It must be
   * LISTED (the BFF deliberately does not hide it) and must not be given a
   * status it does not have.
   */
  it("lists a catalog row with no execution instead of dropping it", async () => {
    const { fetchImpl } = stubFetch({ "/api/studio/runs": () => json(RUN_PAGE) });
    renderScreen(<TicketsScreen />, { fetchImpl });

    await waitFor(() => expect(screen.getByText("UGURPAY-900")).toBeInTheDocument());
    expect(screen.getByText("başlamadı")).toBeInTheDocument();
  });

  it("filters by Jira project", async () => {
    const { fetchImpl } = stubFetch({ "/api/studio/runs": () => json(RUN_PAGE) });
    renderScreen(<TicketsScreen />, { fetchImpl });

    await waitFor(() => expect(screen.getByText("UGURPAY-501")).toBeInTheDocument());
    await userEvent.selectOptions(screen.getByLabelText("Proje"), "UGURDESK");

    expect(screen.getByText("UGURDESK-45")).toBeInTheDocument();
    expect(screen.queryByText("UGURPAY-501")).not.toBeInTheDocument();
  });

  it("shows a translated message instead of the server's error code", async () => {
    const { fetchImpl } = stubFetch({
      "/api/studio/runs": () => json({ error: "project_access" }, 403),
    });
    renderScreen(<TicketsScreen />, { fetchImpl });

    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(screen.getByRole("alert").textContent).not.toContain("project_access");
    expect(screen.getByRole("alert").textContent?.length ?? 0).toBeGreaterThan(10);
  });

  /**
   * The integration regression this whole change exists to prevent: the screen
   * must ask `/studio/runs` (Postgres, the catalog) and never `/runs`
   * (Temporal). The dashboard read "no workflows yet" against a database
   * holding 22 of them purely because of this one path.
   */
  it("asks /studio/runs, never the Temporal-backed /runs", async () => {
    const { fetchImpl, calls } = stubFetch({
      "/api/studio/runs": () => json({ items: [], nextCursor: null }),
    });
    renderScreen(<TicketsScreen />, { fetchImpl });

    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    // Bound to the shared constant, not a literal: the screen asked for 500
    // against a server ceiling of 200 and every request 400'd. A literal here
    // would have passed while the live screen showed nothing.
    //
    // `archived=active` is the 0019 scope, and the list sends it EXPLICITLY
    // rather than leaning on the server's default: the archive toggle flips
    // this same parameter, so a screen that omitted it when off would be
    // asking a different question in each direction.
    expect(calls[0]!.url).toBe(`/api/studio/runs?limit=${MAX_RUN_PAGE}&archived=active`);
    expect(calls.every((call) => !/^\/api\/runs\b/.test(call.url))).toBe(true);
  });
});

/**
 * Archiving, from the operator's side (0019).
 *
 * The bug that produced this feature was a DISPLAY bug with a data-integrity
 * trap inside it: twelve day-old `fail` runs made the panel look broken, and
 * the obvious fix — delete them — would have destroyed a bank's audit trail.
 * So every test here checks the same pair: the run left the board, and the run
 * is still retrievable.
 */
describe("tickets: archiving a run", () => {
  /** The archived view's body: one retired run, carrying its archive stamp. */
  const ARCHIVED_PAGE = {
    items: [
      {
        ...record("UGURPAY-900", { archivedAt: "2026-08-16T12:00:00.000Z" }),
        state: state("UGURPAY-900", "fail", "3o"),
      },
    ],
    nextCursor: null,
  };

  it("asks the server for the archived set instead of hiding rows locally", async () => {
    // Hiding locally would be wrong twice over: the page is capped at
    // MAX_RUN_PAGE, so a client-side filter shrinks an already-truncated page,
    // and the "ilk N kayıt" note would then be counting rows it did not show.
    const { fetchImpl, calls } = stubFetch({
      "/api/studio/runs": () => json(RUN_PAGE),
    });
    renderScreen(<TicketsScreen />, { fetchImpl });

    await waitFor(() => expect(screen.getByText("UGURPAY-501")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("button", { name: "Arşivlenenleri göster" }));

    await waitFor(() =>
      expect(calls.some((call) => call.url.includes("archived=archived"))).toBe(true),
    );
  });

  it("sends the archive as a PUT and says so, without navigating away", async () => {
    const { fetchImpl, calls } = stubFetch({
      "/api/studio/runs/UGURPAY-501/archive": () =>
        json({ ticketKey: "UGURPAY-501", archivedAt: "2026-08-16T12:00:00.000Z" }),
      "/api/studio/runs": () => json(RUN_PAGE),
    });
    renderScreen(<TicketsScreen />, { fetchImpl });

    await waitFor(() => expect(screen.getByText("UGURPAY-501")).toBeInTheDocument());
    const row = screen.getByText("UGURPAY-501").closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Arşivle" }));

    await waitFor(() => {
      const write = calls.find((call) => call.method === "PUT");
      expect(write?.url).toBe("/api/studio/runs/UGURPAY-501/archive");
      // The body says WHICH WAY. "Archive" and "un-archive" are opposite
      // instructions and the endpoint refuses a body that does not choose.
      expect(write?.body).toEqual({ archived: true });
    });
  });

  it("labels an archived row with the way BACK, not with its current state", async () => {
    // The button must always say what pressing it will do. An archived row
    // offering "Arşivle" would be a one-way door with a misleading handle.
    const { fetchImpl } = stubFetch({
      "/api/studio/runs": () => json(ARCHIVED_PAGE),
    });
    renderScreen(<TicketsScreen />, { fetchImpl });

    await waitFor(() => expect(screen.getByText("UGURPAY-900")).toBeInTheDocument());
    const row = screen.getByText("UGURPAY-900").closest("tr")!;
    expect(within(row).getByRole("button", { name: "Geri al" })).toBeInTheDocument();
  });

  it("sends archived:false to restore, so the door opens both ways", async () => {
    const { fetchImpl, calls } = stubFetch({
      "/api/studio/runs/UGURPAY-900/archive": () =>
        json({ ticketKey: "UGURPAY-900", archivedAt: null }),
      "/api/studio/runs": () => json(ARCHIVED_PAGE),
    });
    renderScreen(<TicketsScreen />, { fetchImpl });

    await waitFor(() => expect(screen.getByText("UGURPAY-900")).toBeInTheDocument());
    const row = screen.getByText("UGURPAY-900").closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Geri al" }));

    await waitFor(() => {
      const write = calls.find((call) => call.method === "PUT");
      expect(write?.body).toEqual({ archived: false });
    });
  });

  it("surfaces a refusal instead of looking like a button that did nothing", async () => {
    // A viewer pressing Arşivle gets a 403. Silence here would read as a
    // broken button, and the operator would press it again.
    const { fetchImpl } = stubFetch({
      "/api/studio/runs/UGURPAY-501/archive": () => json({ error: "role_required" }, 403),
      "/api/studio/runs": () => json(RUN_PAGE),
    });
    renderScreen(<TicketsScreen />, { fetchImpl });

    await waitFor(() => expect(screen.getByText("UGURPAY-501")).toBeInTheDocument());
    const row = screen.getByText("UGURPAY-501").closest("tr")!;
    await userEvent.click(within(row).getByRole("button", { name: "Arşivle" }));

    // The toast lives in the `aria-live` region (ui/Toast.tsx), so it is
    // announced rather than merely drawn. Translated prose, never the raw code:
    // "role_required" on screen is a leak of the API's vocabulary into the
    // operator's.
    await waitFor(() => {
      const toasts = screen.getByRole("region").textContent ?? "";
      expect(toasts).not.toContain("role_required");
      expect(toasts.length).toBeGreaterThan(10);
    });
  });

  /**
   * The tile-vs-list agreement, from the operator's side.
   *
   * The dashboard's KPI tiles and its ticket list are counted from ONE
   * response. A tile reading "12 hatalı" over a list showing none is worse
   * than the twelve stale rows that started this, because the operator cannot
   * reconcile it against anything — so the dashboard must ask for the same
   * scope the list beneath it shows.
   */
  it("counts the dashboard KPIs over the same default scope the list shows", async () => {
    const { fetchImpl, calls } = stubFetch({
      "/api/studio/runs": () => json(RUN_PAGE),
    });
    renderScreen(<DashScreen />, { fetchImpl });

    await waitFor(() => expect(calls.some((c) => c.url.includes("/studio/runs"))).toBe(true));
    // Never `archived=all` or `archived=archived`: an archived run must not be
    // counted into a tile whose list would not show it.
    const runCalls = calls.filter((c) => /\/api\/studio\/runs(\?|$)/.test(c.url));
    expect(runCalls.length).toBeGreaterThan(0);
    expect(runCalls.every((c) => !c.url.includes("archived=archived"))).toBe(true);
    expect(runCalls.every((c) => !c.url.includes("archived=all"))).toBe(true);
  });
});

/**
 * The shape transformation, asserted directly.
 *
 * `/studio/runs` sends `{ items, nextCursor }` where each item nests its
 * workflow state; `/runs` sent a flat `{ runs: [...] }`. Reading the old field
 * off the new body yields an EMPTY list with no error — a screen that looks
 * healthy while showing nothing. So the envelope handling is pinned here as
 * well as through the rendered output.
 */
describe("run list shape", () => {
  it("reads the { items, nextCursor } envelope, not a bare array", () => {
    const result = toRunList({ items: RUN_ITEMS, nextCursor: "cursor-2" } as never);
    expect(result.runs).toHaveLength(RUN_ITEMS.length);
    expect(result.nextCursor).toBe("cursor-2");
  });

  it("lifts step/status/runId out of the nested state", () => {
    const row = toRunRow(RUN_ITEMS[0] as never);
    expect(row.status).toBe("running");
    expect(row.step).toBe("6a");
    expect(row.runId).toBe("run-UGURPAY-501");
    // Record fields survive the flattening.
    expect(row.title).toBe("UGURPAY-501 konusu");
    expect(row.appId).toBe("odeme-servisi");
  });

  it("leaves status/step/runId null when the workflow has not started", () => {
    const row = toRunRow(RUN_ITEMS[5] as never);
    expect(row.status).toBeNull();
    expect(row.step).toBeNull();
    expect(row.runId).toBeNull();
    // The catalog's own risk tier still stands in for the missing state.
    expect(row.risk).toBe("orta");
  });

  /**
   * `undefined` and `null` both mean "on the board" (0019).
   *
   * This is not defensive padding — it is the exact bug the fixtures caught.
   * A row whose body omits `archivedAt` (an older BFF, a proxy that strips
   * nulls) leaves the field `undefined`, and `undefined !== null` is TRUE, so
   * a naive check renders EVERY live run as archived: the list offers "Geri
   * al" on active work and the board looks emptied. No error, no crash — just
   * a screen confidently showing the wrong thing, which is this project's
   * worst failure class.
   */
  it("reads a missing archivedAt as 'on the board', never as archived", () => {
    const withoutField = toRunRow(RUN_ITEMS[0] as never);
    expect(withoutField.archivedAt).toBeNull();

    const archived = toRunRow({
      ...record("UGURPAY-900", { archivedAt: "2026-08-16T12:00:00.000Z" }),
      state: null,
    } as never);
    expect(archived.archivedAt).toBe("2026-08-16T12:00:00.000Z");
  });

  it("yields an empty list rather than throwing on a body with no items", () => {
    expect(toRunList(undefined).runs).toEqual([]);
    expect(toRunList({ runs: RUN_ITEMS } as never).runs).toEqual([]);
  });
});

describe("dash", () => {
  it("counts the KPIs from real workflow statuses rather than showing constants", async () => {
    const { fetchImpl } = stubFetch({ "/api/studio/runs": () => json(RUN_PAGE) });
    renderScreen(<DashScreen />, { fetchImpl });

    await waitFor(() => expect(screen.getByText("Aktif iş akışı")).toBeInTheDocument());

    // one `running`
    const active = screen.getByText("Aktif iş akışı").closest("section");
    expect(within(active!).getByText("1")).toBeInTheDocument();

    // two `gate` rows — a count the Temporal-backed list could not produce
    const gate = screen.getByText("Kapıda bekleyen").closest("section");
    expect(within(gate!).getByText("2")).toBeInTheDocument();

    // six rows on the page, including the one with no execution
    const total = screen.getByText("Toplam").closest("section");
    expect(within(total!).getByText("6")).toBeInTheDocument();
  });

  it("puts the failed run first, then the gate, in the attention list", async () => {
    const { fetchImpl } = stubFetch({ "/api/studio/runs": () => json(RUN_PAGE) });
    renderScreen(<DashScreen />, { fetchImpl });

    await waitFor(() => expect(screen.getByText("Dikkat isteyenler")).toBeInTheDocument());
    const rows = screen.getAllByRole("button").filter((el) => el.className.includes("screen-issue"));
    expect(rows[0]!.textContent).toContain("UGURDESK-45");
    expect(rows[1]!.textContent).toContain("UGURPAY-777");
    // A plain `running` run is not "attention" — nobody is blocked on it.
    expect(rows.some((row) => row.textContent?.includes("UGURPAY-501"))).toBe(false);
  });

  it("shows the empty state when the operator has no runs", async () => {
    const { fetchImpl } = stubFetch({
      "/api/studio/runs": () => json({ items: [], nextCursor: null }),
    });
    renderScreen(<DashScreen />, { fetchImpl });

    await waitFor(() => expect(screen.getByText("Henüz iş akışı yok")).toBeInTheDocument());
    expect(screen.queryByText("Aktif iş akışı")).not.toBeInTheDocument();
  });

  /**
   * The exact production symptom: a Postgres-backed page of runs rendered as
   * "Henüz iş akışı yok" because the screen was reading Temporal. If the body
   * below ever produces the empty state again, this fails.
   */
  it("does not show the empty state when /studio/runs returns rows", async () => {
    const { fetchImpl } = stubFetch({ "/api/studio/runs": () => json(RUN_PAGE) });
    renderScreen(<DashScreen />, { fetchImpl });

    await waitFor(() => expect(screen.getByText("Aktif iş akışı")).toBeInTheDocument());
    expect(screen.queryByText("Henüz iş akışı yok")).not.toBeInTheDocument();
  });
});

describe("detail + gate decision", () => {
  const routes: Readonly<Record<string, () => Response>> = {
    // The journal lives under /studio/runs (routes/studio-runs.ts:80), NOT under
    // the /runs prefix the detail header uses. The stub answers only the real
    // path so a regression back to /runs/:ticket/journal falls through to the
    // stub's 404 and the assertions below fail.
    "/api/studio/runs/UGURPAY-501/journal": () => json({ items: JOURNAL, nextCursor: null }),
    "/api/studio/runs/UGURPAY-501": () => json(GATE_DETAIL),
  };

  function renderDetail(session: Session, extra: Readonly<Record<string, () => Response>> = {}) {
    const stub = stubFetch({ ...routes, ...extra });
    renderScreen(<DetailScreen />, {
      fetchImpl: stub.fetchImpl,
      session,
      route: "/detail/UGURPAY-501",
      path: "/detail/:ticket",
    });
    return stub;
  }

  it("renders the run's step and risk from GET /studio/runs/:ticket", async () => {
    renderDetail(TECH_LEAD);
    await waitFor(() => expect(screen.getByText("Künye")).toBeInTheDocument());

    expect(screen.getAllByText("PR onayı").length).toBeGreaterThan(0);
    expect(screen.getByText("orta")).toBeInTheDocument();
    // risk orta -> 4 gates, read from GATES_BY_RISK, not typed in
    expect(screen.getByText("4 kapı")).toBeInTheDocument();
  });

  /**
   * The sidebar fields the old endpoint could not supply at all. Each one is
   * asserted against the fixture's value, so a screen that renders a plausible
   * placeholder instead of the record's own number fails here.
   */
  it("renders the record's application, people, PR and spend", async () => {
    renderDetail(TECH_LEAD);
    await waitFor(() => expect(screen.getByText("Künye")).toBeInTheDocument());

    expect(screen.getByText("Ödeme Servisi")).toBeInTheDocument();
    expect(screen.getByText("UgurBank/_git/odeme-servisi")).toBeInTheDocument();
    expect(screen.getByText("mehmet.demir@ugurbank")).toBeInTheDocument();
    expect(screen.getByText("ayse.kaya@ugurbank")).toBeInTheDocument();
    expect(screen.getByText("#4821")).toBeInTheDocument();
    expect(screen.getByText(/2\.25 USD/)).toBeInTheDocument();
    expect(screen.getByText("5000 giriş / 900 çıkış token")).toBeInTheDocument();
  });

  /** A null field is an em dash, never a filled-in guess. */
  it("shows an em dash for an unassigned ticket with no PR", async () => {
    const stub = stubFetch({
      "/api/studio/runs/UGURPAY-501": () =>
        json({ ...GATE_DETAIL, run: record("UGURPAY-501"), application: null }),
    });
    renderScreen(<DetailScreen />, {
      fetchImpl: stub.fetchImpl,
      route: "/detail/UGURPAY-501",
      path: "/detail/:ticket",
    });

    await waitFor(() => expect(screen.getByText("Künye")).toBeInTheDocument());
    const assignee = screen.getByText("Atanan").nextElementSibling;
    expect(assignee?.textContent).toBe("—");
    const pr = screen.getByText("PR").nextElementSibling;
    expect(pr?.textContent).toBe("—");
  });

  /** Parent/child links come from the record — the fan-out tree is real now. */
  it("links the parent and child tickets when the record carries them", async () => {
    const stub = stubFetch({
      "/api/studio/runs/UGURPAY-501": () =>
        json({
          ...GATE_DETAIL,
          run: record("UGURPAY-501", {
            parentTicketKey: "UGURPAY-500",
            childTicketKeys: ["UGURPAY-502", "UGURDESK-9"],
          }),
        }),
    });
    renderScreen(<DetailScreen />, {
      fetchImpl: stub.fetchImpl,
      route: "/detail/UGURPAY-501",
      path: "/detail/:ticket",
    });

    await waitFor(() => expect(screen.getByText("Fan-out bağı")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: "UGURPAY-500" })).toHaveAttribute(
      "href",
      "/detail/UGURPAY-500",
    );
    expect(screen.getByRole("link", { name: "UGURPAY-502" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "UGURDESK-9" })).toBeInTheDocument();
  });

  /**
   * A ticket in the catalog whose workflow never started. The old endpoint
   * could only 404 this, i.e. claim the ticket did not exist; the new one
   * returns the record with `state: null` and the screen must say so.
   */
  it("shows the record but no step list for a run that has not started", async () => {
    const stub = stubFetch({
      "/api/studio/runs/UGURPAY-900": () =>
        json({ run: record("UGURPAY-900"), state: null, application: null }),
    });
    renderScreen(<DetailScreen />, {
      fetchImpl: stub.fetchImpl,
      route: "/detail/UGURPAY-900",
      path: "/detail/:ticket",
    });

    await waitFor(() => expect(screen.getByText("Künye")).toBeInTheDocument());
    expect(screen.getByText("UGURPAY-900")).toBeInTheDocument();
    expect(screen.getByText("başlamadı")).toBeInTheDocument();
    // No gate panel may appear for a run with no state.
    expect(screen.queryByRole("button", { name: "Onayla" })).not.toBeInTheDocument();
  });

  it("sends the approval as a gateDecision SIGNAL, with no actor in the body", async () => {
    const stub = renderDetail(TECH_LEAD, {
      "/api/runs/UGURPAY-501/signals/gateDecision": () =>
        json({ accepted: true, step: "12", signatureSeq: 7 }),
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Onayla" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Onayla" }));
    await userEvent.click(screen.getByRole("button", { name: "Onayla ve imzala" }));

    await waitFor(() => {
      const signal = stub.calls.find((call) => call.url.includes("/signals/gateDecision"));
      expect(signal).toBeDefined();
      expect(signal!.method).toBe("POST");
      expect(signal!.body).toEqual({ decision: "approve" });
    });

    // The identity must come from the session server-side, never the payload.
    const signal = stub.calls.find((call) => call.url.includes("/signals/gateDecision"))!;
    expect(signal.body).not.toHaveProperty("actorUserId");
    expect(signal.body).not.toHaveProperty("actor");
  });

  it("refuses to send a rejection without a reason", async () => {
    const stub = renderDetail(TECH_LEAD, {
      "/api/runs/UGURPAY-501/signals/gateDecision": () => json({ accepted: true }),
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Reddet" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Reddet" }));

    const dialog = await screen.findByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "Reddet" });
    expect(submit).toBeDisabled();

    await userEvent.click(submit);
    expect(stub.calls.some((call) => call.url.includes("/signals/"))).toBe(false);

    // With a reason it goes, and the reason travels with it.
    await userEvent.type(within(dialog).getByLabelText("Gerekçe"), "kapsam eksik");
    await userEvent.click(within(dialog).getByRole("button", { name: "Reddet" }));

    await waitFor(() => {
      const signal = stub.calls.find((call) => call.url.includes("/signals/gateDecision"));
      expect(signal?.body).toEqual({ decision: "reject", reason: "kapsam eksik" });
    });
  });

  it("disables the decision for a role that does not own the gate", async () => {
    // Step 12 belongs to tech-lead; a QA session must not be offered the button.
    renderDetail(QA);
    await waitFor(() => expect(screen.getByRole("button", { name: "Onayla" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Reddet" })).toBeDisabled();
  });

  it("disables the decision for a delegated (AI) session", async () => {
    renderDetail(DELEGATED_TECH_LEAD);
    await waitFor(() => expect(screen.getByRole("button", { name: "Onayla" })).toBeDisabled());
  });

  it("translates a 404 from GET /runs/:ticket instead of printing the code", async () => {
    const stub = stubFetch({
      "/api/studio/runs/UGURPAY-999": () => json({ error: "no_run" }, 404),
    });
    renderScreen(<DetailScreen />, {
      fetchImpl: stub.fetchImpl,
      route: "/detail/UGURPAY-999",
      path: "/detail/:ticket",
    });

    await waitFor(() => expect(screen.getByText("Veri alınamadı")).toBeInTheDocument());
    expect(document.body.textContent).not.toContain("no_run");
  });

  /**
   * K1 regression. Two independent ways to break this, both silent in the old
   * suite: call `/runs/:ticket/journal` (404, no such route) or read `entries`
   * off a body that carries `items`. The first shows an error panel, the second
   * shows an empty journal that looks healthy — so the test asserts the URL
   * that left the client AND the rows that came back.
   */
  it("reads the journal from GET /studio/runs/:ticket/journal and renders its items", async () => {
    const stub = renderDetail(TECH_LEAD);
    await waitFor(() => expect(screen.getByText("Künye")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("tab", { name: /Ticket defteri/ }));

    await waitFor(() =>
      expect(screen.getByText("Analiz belgesi üretildi")).toBeInTheDocument(),
    );
    expect(screen.getByText("Kapı onayı verildi")).toBeInTheDocument();

    const call = stub.calls.find((entry) => entry.url.includes("/journal"));
    expect(call).toBeDefined();
    expect(call!.url).toContain("/api/studio/runs/UGURPAY-501/journal");
    // The /runs prefix has no journal sub-resource; asking there is a 404.
    expect(call!.url).not.toMatch(/\/api\/runs\/UGURPAY-501\/journal/);

    // An empty envelope must not be mistaken for a populated one.
    expect(screen.queryByText("Defter boş")).not.toBeInTheDocument();
  });

  it("shows the journal's failure as translated text, not invented history", async () => {
    renderDetail(TECH_LEAD, {
      "/api/studio/runs/UGURPAY-501/journal": () => json({ error: "no_run" }, 404),
    });
    await waitFor(() => expect(screen.getByText("Künye")).toBeInTheDocument());
    await userEvent.click(screen.getByRole("tab", { name: /Ticket defteri/ }));

    await waitFor(() => expect(screen.getByText("Veri alınamadı")).toBeInTheDocument());
    expect(document.body.textContent).not.toContain("no_run");
  });
});

describe("clarify", () => {
  it("sends the answer as a clarificationAnswered signal", async () => {
    const stub = stubFetch({
      "/api/runs/UGURPAY-712/signals/clarificationAnswered": () => json({ accepted: true }),
      "/api/studio/runs": () => json(RUN_PAGE),
    });
    renderScreen(<ClarifyScreen />, { fetchImpl: stub.fetchImpl });

    await userEvent.type(screen.getByLabelText("Ticket"), "UGURPAY-712");
    await userEvent.type(screen.getByLabelText("Yanıt"), "p95 < 800 ms");
    await userEvent.click(screen.getByRole("button", { name: "Yanıtı gönder" }));

    await waitFor(() => {
      const call = stub.calls.find((entry) => entry.url.includes("clarificationAnswered"));
      expect(call?.method).toBe("POST");
      expect(call?.body).toEqual({ text: "p95 < 800 ms" });
    });
  });

  /**
   * The open-2b list is now the REAL queue: it filters on `state.step`, which
   * only the joined endpoint carries. The old screen showed every running run.
   */
  it("lists only the runs actually parked on step 2b", async () => {
    const stub = stubFetch({ "/api/studio/runs": () => json(RUN_PAGE) });
    renderScreen(<ClarifyScreen />, { fetchImpl: stub.fetchImpl });

    await waitFor(() => expect(screen.getByText("UGURPAY-712")).toBeInTheDocument());
    // Running, at another gate, done, failed and not-started rows are all out.
    expect(screen.queryByText("UGURPAY-501")).not.toBeInTheDocument();
    expect(screen.queryByText("UGURPAY-777")).not.toBeInTheDocument();
    expect(screen.queryByText("UGURDESK-45")).not.toBeInTheDocument();
    // The reporter is who the reminder ladder chases — shown, not invented.
    expect(screen.getAllByText("mehmet.demir@ugurbank").length).toBeGreaterThan(0);
  });

  it("keeps the send button disabled until both fields are filled", async () => {
    const stub = stubFetch({
      "/api/studio/runs": () => json({ items: [], nextCursor: null }),
    });
    renderScreen(<ClarifyScreen />, { fetchImpl: stub.fetchImpl });

    const send = screen.getByRole("button", { name: "Yanıtı gönder" });
    expect(send).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Ticket"), "UGURPAY-712");
    expect(send).toBeDisabled();

    await userEvent.type(screen.getByLabelText("Yanıt"), "cevap");
    expect(send).toBeEnabled();
    expect(stub.calls.some((call) => call.url.includes("/signals/"))).toBe(false);
  });
});

describe("workmode", () => {
  it("confirms before sending the modeChange signal", async () => {
    const stub = stubFetch({
      "/api/runs/UGURPAY-503/signals/modeChange": () =>
        json({ accepted: true, mode: "human_lead" }),
    });
    renderScreen(<WorkmodeScreen />, { fetchImpl: stub.fetchImpl });

    await userEvent.type(screen.getByLabelText("Ticket"), "UGURPAY-503");
    await userEvent.selectOptions(screen.getByLabelText("Yeni mod"), "human_lead");
    await userEvent.click(screen.getByRole("button", { name: "Modu değiştir" }));

    // The modal stands between the click and the request.
    expect(stub.calls.some((call) => call.url.includes("/signals/"))).toBe(false);
    const dialog = await screen.findByRole("dialog");
    await userEvent.click(within(dialog).getByRole("button", { name: "Değiştir" }));

    await waitFor(() => {
      const call = stub.calls.find((entry) => entry.url.includes("modeChange"));
      expect(call?.body).toEqual({ mode: "human_lead" });
    });
  });

  /**
   * Every mode is rendered, and rendered TRANSLATED.
   *
   * The enum drives the loop — that is the part worth keeping, because it is
   * what fails when `WorkMode` gains a member nobody wired up. What changed is
   * the expected text: asserting the raw `full_auto` was appearing on screen
   * had frozen the leak into the suite, so the bug could not be fixed without
   * a test going red. It went red; this is the corrected expectation.
   */
  it("renders every mode from the frozen WorkMode enum, translated", () => {
    const stub = stubFetch({});
    renderScreen(<WorkmodeScreen />, { fetchImpl: stub.fetchImpl });

    const translated: Readonly<Record<string, string>> = {
      full_auto: "Tam otomatik",
      ai_assist: "AI destekli",
      human_lead: "İnsan öncülüğünde",
      human_only: "Yalnız insan",
    };

    for (const [mode, label] of Object.entries(translated)) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
      expect(screen.queryByText(mode)).not.toBeInTheDocument();
    }
  });
});

describe("fanout", () => {
  /**
   * The tree is READ from the record now, not inferred from the Jira project.
   * The fixture deliberately puts a child in a DIFFERENT project (UGURDESK-9):
   * the old project-prefix heuristic would have missed it, and a fan-out that
   * silently drops the cross-app child defeats the point of M100.
   */
  const TREE = {
    items: [
      {
        ...record("UGURPAY-500", {
          childTicketKeys: ["UGURPAY-502", "UGURDESK-9", "UGURPAY-999"],
        }),
        state: state("UGURPAY-500", "running", "3"),
      },
      {
        ...record("UGURPAY-502", { parentTicketKey: "UGURPAY-500" }),
        state: state("UGURPAY-502", "gate", "12"),
      },
      {
        ...record("UGURDESK-9", { parentTicketKey: "UGURPAY-500", appId: "destek-portali" }),
        state: state("UGURDESK-9", "running", "6a"),
      },
      // Same project, NOT a child — the old heuristic would have listed it.
      { ...record("UGURPAY-478"), state: state("UGURPAY-478", "done", "13") },
    ],
    nextCursor: null,
  };

  it("shows the real parent/child tree, including a child in another project", async () => {
    const { fetchImpl } = stubFetch({ "/api/studio/runs": () => json(TREE) });
    renderScreen(<FanoutScreen />, { fetchImpl });

    await waitFor(() => expect(screen.getByText("Etki matrisi")).toBeInTheDocument());
    await userEvent.type(screen.getByLabelText("Ana ticket anahtarı"), "UGURPAY-500");

    await waitFor(() => expect(screen.getByText("UGURPAY-502")).toBeInTheDocument());
    // The cross-project child is in the tree because the RECORD says so.
    expect(screen.getByText("UGURDESK-9")).toBeInTheDocument();
    expect(screen.getByText("destek-portali")).toBeInTheDocument();
    // A same-project run that is not a child must NOT appear.
    expect(screen.queryByText("UGURPAY-478")).not.toBeInTheDocument();
  });

  /**
   * A child the parent claims but which is not on the visible page is reported
   * as missing rather than dropped — a tree that under-reports its own scope
   * would understate the blast radius of the change.
   */
  it("names children it cannot see instead of quietly omitting them", async () => {
    const { fetchImpl } = stubFetch({ "/api/studio/runs": () => json(TREE) });
    renderScreen(<FanoutScreen />, { fetchImpl });

    await userEvent.type(screen.getByLabelText("Ana ticket anahtarı"), "UGURPAY-500");

    await waitFor(() => expect(screen.getByText("Görünmeyen alt ticket'lar")).toBeInTheDocument());
    expect(screen.getByText("UGURPAY-999")).toBeInTheDocument();
  });

  it("still states that the impact matrix itself has no endpoint", async () => {
    const { fetchImpl } = stubFetch({ "/api/studio/runs": () => json(TREE) });
    renderScreen(<FanoutScreen />, { fetchImpl });

    await waitFor(() => expect(screen.getByText("Etki matrisi")).toBeInTheDocument());
    expect(screen.getByText(/Etki matrisi analiz belgesinde yaşıyor/)).toBeInTheDocument();
  });
});

describe("evidence", () => {
  const PACKAGE = {
    runId: "run-123-dddddddd",
    ticketKey: "UGURPAY-123",
    createdAt: "2026-08-02T10:00:00.000Z",
    templateVersion: "v3",
    files: [
      {
        name: "01-analiz.md",
        sha256: "a".repeat(64),
        bytes: 28672,
        contentType: "text/markdown",
      },
    ],
    approvals: [
      {
        step: "12",
        decision: "approve",
        actorUserId: "ayse.kaya@ugurbank",
        actorGroup: "tech-leads",
        sodVerified: true,
        signatureSeq: 81402,
        source: "jira",
        at: "2026-08-02T09:00:00.000Z",
      },
    ],
    retentionYears: 10,
    objectLock: true,
  };

  it("renders the manifest and the signed approval chain", async () => {
    const stub = stubFetch({
      "/api/studio/runs/UGURPAY-123/evidence": () => json(PACKAGE),
    });
    const { fetchImpl } = stub;
    renderScreen(<EvidenceScreen />, { fetchImpl });

    await userEvent.type(screen.getByLabelText("Ticket"), "UGURPAY-123");

    await waitFor(() => expect(screen.getByText("01-analiz.md")).toBeInTheDocument());

    // K1 regression: the manifest route is /studio/runs/..., not /runs/....
    // Typing fires a request per keystroke, so the FULL key is the last one.
    const evidenceCalls = stub.calls.filter((entry) => entry.url.includes("/evidence"));
    expect(evidenceCalls.at(-1)!.url).toContain("/api/studio/runs/UGURPAY-123/evidence");
    // No call, at any keystroke, may go to the /runs prefix.
    expect(evidenceCalls.every((entry) => entry.url.includes("/api/studio/runs/"))).toBe(true);
    expect(screen.getByText("28 KB")).toBeInTheDocument();
    expect(screen.getByText("ayse.kaya@ugurbank")).toBeInTheDocument();
    // sodVerified comes from the decision, and is shown as such.
    expect(screen.getByText("doğrulandı")).toBeInTheDocument();
  });

  it("reports an unverified SoD rather than showing a green tick anyway", async () => {
    const unverified = {
      ...PACKAGE,
      approvals: [{ ...PACKAGE.approvals[0]!, sodVerified: false }],
    };
    const { fetchImpl } = stubFetch({
      "/api/studio/runs/UGURPAY-123/evidence": () => json(unverified),
    });
    renderScreen(<EvidenceScreen />, { fetchImpl });

    await userEvent.type(screen.getByLabelText("Ticket"), "UGURPAY-123");
    await waitFor(() => expect(screen.getByText("doğrulanmadı")).toBeInTheDocument());
    expect(screen.queryByText("doğrulandı")).not.toBeInTheDocument();
  });

  it("asks for a ticket before fetching anything", () => {
    const stub = stubFetch({});
    renderScreen(<EvidenceScreen />, { fetchImpl: stub.fetchImpl });

    expect(screen.getByText("Paketi görmek için bir ticket anahtarı yaz.")).toBeInTheDocument();
    expect(stub.calls).toHaveLength(0);
  });
});

describe("live", () => {
  it("draws the pipeline from the contract's step table and lists real in-flight work", async () => {
    const { fetchImpl } = stubFetch({ "/api/studio/runs": () => json(RUN_PAGE) });
    renderScreen(<LiveScreen />, { fetchImpl });

    // Steps come from STEP_IDS — 2b is a step id that only exists there.
    expect(screen.getAllByText("2b").length).toBeGreaterThan(0);
    expect(screen.getAllByText("insan kapısı").length).toBeGreaterThan(0);

    await waitFor(() => expect(screen.getByText("UGURPAY-501")).toBeInTheDocument());
    // Gates are in flight too — they are what a person is needed for.
    expect(screen.getByText("UGURPAY-777")).toBeInTheDocument();
    // Finished and failed work is not.
    expect(screen.queryByText("UGURPAY-478")).not.toBeInTheDocument();
    expect(screen.queryByText("UGURDESK-45")).not.toBeInTheDocument();
  });
});
