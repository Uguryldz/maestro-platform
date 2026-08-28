import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CommandsScreen } from "../src/screens/Commands.tsx";
import { HealthScreen } from "../src/screens/Health.tsx";
import { McpScreen } from "../src/screens/Mcp.tsx";
import { NotifyScreen } from "../src/screens/Notify.tsx";
import { OnboardScreen } from "../src/screens/Onboard.tsx";
import { RunnersScreen } from "../src/screens/Runners.tsx";
import { SandboxScreen } from "../src/screens/Sandbox.tsx";
import { YamlScreen } from "../src/screens/Yaml.tsx";
import { renderScreen, stubFetch } from "./harness.tsx";

function runner(overrides: Record<string, unknown>) {
  return {
    runnerId: "lnx-01",
    pool: "docker-linux",
    platform: "linux-node",
    state: "idle",
    capacity: 4,
    activeSandboxes: 2,
    lastHeartbeatAt: "2026-08-08T12:00:00.000Z",
    note: null,
    ...overrides,
  };
}

function pool(overrides: Record<string, unknown>) {
  return {
    pool: "docker-linux",
    capacity: 4,
    busy: 2,
    machines: 1,
    unhealthy: 0,
    ...overrides,
  };
}

describe("runners screen", () => {
  it("puts an unreachable machine at the top and raises an alert", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/studio/runners",
        body: {
          items: [
            runner({ runnerId: "aaa-healthy", state: "idle" }),
            runner({ runnerId: "zzz-dead", state: "unreachable", activeSandboxes: 0 }),
          ],
          nextCursor: null,
          pools: [pool({ machines: 2, capacity: 8, busy: 2 })],
        },
      },
    ]);
    renderScreen(<RunnersScreen />, { fetchImpl });

    expect(await screen.findByText(/1 makineye ulaşılamıyor/)).toBeInTheDocument();

    // Worst news first: the dead machine precedes the healthy one even though
    // it sorts last alphabetically.
    const rows = screen.getAllByRole("row").slice(1);
    expect(within(rows[0] as HTMLElement).getByText("zzz-dead")).toBeInTheDocument();
  });

  it("says how many of a pool's machines are dark beside the server's totals", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/studio/runners",
        body: {
          items: [
            runner({ runnerId: "a", state: "busy" }),
            runner({ runnerId: "b", state: "unreachable" }),
          ],
          nextCursor: null,
          // The BFF sums capacity; the screen must render ITS number, not a
          // second opinion computed here.
          pools: [pool({ machines: 2, capacity: 8, busy: 4, unhealthy: 1 })],
        },
      },
    ]);
    renderScreen(<RunnersScreen />, { fetchImpl });

    const note = await screen.findByText(/1 ulaşılamıyor/);
    const tile = note.closest("section") as HTMLElement;
    expect(within(tile).getByText("4/8")).toBeInTheDocument();
  });

  it("shows a translated failure instead of the server code", async () => {
    const { fetchImpl } = stubFetch([
      { path: "/studio/runners", status: 500, body: { error: "internal_error" } },
    ]);
    renderScreen(<RunnersScreen />, { fetchImpl });

    expect(await screen.findByText("Veri alınamadı")).toBeInTheDocument();
    expect(screen.getByText("Sunucuda bir hata oluştu.")).toBeInTheDocument();
    expect(screen.queryByText(/internal_error/)).not.toBeInTheDocument();
  });

  it("reads an unwired read model as 'not available here', not a red error", async () => {
    // The runners store has no producer in this deployment, so it refuses by
    // name with 503 capability_not_wired. That is "not wired here", not a
    // breakage — the screen must say so rather than show "Veri alınamadı".
    const { fetchImpl } = stubFetch([
      { path: "/studio/runners", status: 503, body: { error: "capability_not_wired", details: { capability: "runners.list" } } },
    ]);
    renderScreen(<RunnersScreen />, { fetchImpl });

    expect(await screen.findByText("Bu bölüm henüz yayında değil")).toBeInTheDocument();
    expect(screen.queryByText("Veri alınamadı")).not.toBeInTheDocument();
  });
});

describe("sandbox screen", () => {
  it("shows an empty state rather than inventing a session", async () => {
    const { fetchImpl } = stubFetch([
      { path: "/studio/sandboxes", body: { items: [], nextCursor: null } },
    ]);
    renderScreen(<SandboxScreen />, { fetchImpl });

    expect(await screen.findByText("Açık sandbox oturumu yok")).toBeInTheDocument();
  });

  it("renders a workspace a human is holding as its own state, and offers no delete", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/studio/sandboxes",
        body: {
          items: [
            {
              ticketKey: "UGURPAY-503",
              runnerId: "lnx-02",
              state: "human_held",
              sizeBytes: 2_306_867,
              lastAccessAt: "2026-08-08T11:00:00.000Z",
            },
          ],
          nextCursor: null,
        },
      },
    ]);
    renderScreen(<SandboxScreen />, { fetchImpl });

    expect(await screen.findByText("UGURPAY-503")).toBeInTheDocument();
    expect(screen.getByText("insan çalışıyor")).toBeInTheDocument();
    // A delete control here is how somebody destroys the session a human is
    // mid-way through; the retention job owns removal (M65).
    expect(screen.queryByRole("button", { name: /[Ss]il/ })).not.toBeInTheDocument();
  });

  it("never renders a session transcript, and says why", async () => {
    const { fetchImpl } = stubFetch([
      { path: "/studio/sandboxes", body: { items: [], nextCursor: null } },
    ]);
    renderScreen(<SandboxScreen />, { fetchImpl });

    expect(await screen.findByText(/maskelenmemiş ticket metni/)).toBeInTheDocument();
  });
});
describe("yaml screen", () => {
  const POLICY = {
    appId: "ugurpay",
    platform: "linux-node",
    repo: "Odeme/_git/ugurpay",
    yaml: "platform: linux-node\ncommands:\n  build: npm run build",
    protectedPaths: {
      platformDefaults: ["prisma/migrations/**", ".env*"],
      repoAdditions: ["src/payment-core/**"],
    },
    fetchedAt: "2026-08-08T12:00:00.000Z",
  };

  it("lists platform defaults read-only and offers removal only for repo additions", async () => {
    const { fetchImpl } = stubFetch([{ path: "/repo-policy", body: { policies: [POLICY] } }]);
    renderScreen(<YamlScreen />, { fetchImpl });

    expect(await screen.findByText("prisma/migrations/**")).toBeInTheDocument();
    expect(screen.getByText("kaldırılamaz")).toBeInTheDocument();

    // Exactly one remove control: the repo addition. A default must offer none.
    const removeButtons = screen.getAllByRole("button", { name: "Kaldır" });
    expect(removeButtons).toHaveLength(1);
    expect(screen.getByText("src/payment-core/**")).toBeInTheDocument();
  });

  it("only ever adds a protected path, never deletes a default", async () => {
    const { fetchImpl, calls } = stubFetch([
      { path: "/repo-policy", body: { policies: [POLICY] } },
      { path: "/protected-paths", method: "POST", body: POLICY },
    ]);
    renderScreen(<YamlScreen />, { fetchImpl });

    await userEvent.type(await screen.findByLabelText("Yeni korumalı yol"), "keystore/**");
    await userEvent.click(screen.getByRole("button", { name: "Ekle" }));

    await waitFor(() => {
      const post = calls.find((call) => call.method === "POST");
      expect(post?.body).toEqual({ path: "keystore/**" });
    });
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("refuses to send an empty path", async () => {
    const { fetchImpl, calls } = stubFetch([
      { path: "/repo-policy", body: { policies: [POLICY] } },
    ]);
    renderScreen(<YamlScreen />, { fetchImpl });

    await userEvent.click(await screen.findByRole("button", { name: "Ekle" }));
    expect(await screen.findByText("Yol boş olamaz.")).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });
});

describe("mcp screen", () => {
  it("shows the forbidden tools as absent by design", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/mcp/manifest",
        body: {
          endpoint: "/mcp",
          auditActor: "ai-via:ugur.yildiz@ugurbank.local",
          tools: [
            {
              name: "propose_killswitch",
              scope: "admin-proposal",
              descriptionKey: "params.description.kill_switch_state",
            },
          ],
          forbiddenTools: ["approve_gate", "reject_gate", "merge_pr"],
        },
      },
    ]);
    renderScreen(<McpScreen />, { fetchImpl });

    expect(await screen.findByText("approve_gate")).toBeInTheDocument();
    expect(screen.getByText("merge_pr")).toBeInTheDocument();
    expect(screen.getByText(/karar veremez/)).toBeInTheDocument();
    // The proposal scope must be labelled as such, not as a plain admin power.
    expect(screen.getByText("admin-öneri")).toBeInTheDocument();
  });
});

describe("health screen", () => {
  const SERVICE = {
    service: "postgres",
    state: "healthy",
    version: "16.4",
    checkedAt: "2026-08-08T12:00:00.000Z",
    note: null,
  };

  it("renders the overall state the server decided, not one recomputed here", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/studio/health",
        body: {
          state: "degraded",
          services: [SERVICE, { ...SERVICE, service: "redis", state: "degraded" }],
        },
      },
    ]);
    renderScreen(<HealthScreen />, { fetchImpl });

    expect(await screen.findByText("Bazı servisler sorunlu")).toBeInTheDocument();
  });

  it("shows an unknown service by its id instead of blanking the page", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/studio/health",
        body: {
          state: "down",
          services: [SERVICE, { ...SERVICE, service: "brand_new_thing", state: "down" }],
        },
      },
    ]);
    renderScreen(<HealthScreen />, { fetchImpl });

    // The catalogued one still renders...
    expect(await screen.findByText("PostgreSQL")).toBeInTheDocument();
    // ...and the uncatalogued one appears rather than throwing behind the
    // error boundary and taking the whole page with it.
    expect(screen.getByText("brand_new_thing")).toBeInTheDocument();
  });

  it("an unconfigured LLM says so honestly and points at the settings screen", async () => {
    // "Not set up" must be its own state — not a fake green and not a red that
    // pages somebody — and the row must say WHERE to fix it, in the wizard's
    // own words (Setup.tsx uses the same link label).
    const { fetchImpl } = stubFetch([
      {
        path: "/studio/health",
        body: {
          state: "healthy",
          services: [
            SERVICE,
            {
              service: "llm",
              state: "not_configured",
              version: "llm",
              checkedAt: SERVICE.checkedAt,
              note: "health.note.not_configured",
            },
          ],
        },
      },
    ]);
    renderScreen(<HealthScreen />, { fetchImpl });

    expect(await screen.findByText("Model sağlayıcı (LLM)")).toBeInTheDocument();
    expect(screen.getByText("yapılandırılmadı")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Ayarlar & bağlantılar'a git" });
    expect(link).toHaveAttribute("href", "/settings");
    // An unconfigured connector is a to-do, not an outage — the platform badge
    // the server computed stays green beside it.
    expect(screen.getByText("Tüm servisler sağlıklı")).toBeInTheDocument();
  });

  it("a failing Jira credential reads kapalı, with the fix link beside the reason", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/studio/health",
        body: {
          state: "down",
          services: [
            {
              service: "jira",
              state: "down",
              version: "jira_cloud",
              checkedAt: SERVICE.checkedAt,
              note: "connections.test.no_token",
            },
          ],
        },
      },
    ]);
    renderScreen(<HealthScreen />, { fetchImpl });

    expect(await screen.findByText("kapalı")).toBeInTheDocument();
    // The stored test verdict travels as a catalog key and renders as a sentence.
    expect(screen.getByText(/Token tanımlı değil/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Ayarlar & bağlantılar'a git" })).toHaveAttribute(
      "href",
      "/settings",
    );
  });
});
describe("commands screen", () => {
  it("states that a comment with extra text is not an approval", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/commands",
        body: {
          commands: [
            {
              name: "/approve",
              roles: ["tech-lead"],
              takesArgument: false,
              whenKey: "commands.check.right_step",
              effectKey: "commands.check.sod",
            },
          ],
        },
      },
    ]);
    renderScreen(<CommandsScreen />, { fetchImpl });

    expect(await screen.findByText("/approve")).toBeInTheDocument();
    expect(screen.getByText(/onay SAYILMAZ/)).toBeInTheDocument();
    expect(screen.getByText(/sonradan onay yazılamaz/)).toBeInTheDocument();
  });
});

describe("notify screen", () => {
  it("says no rung of the ladder auto-rejects", async () => {
    const { fetchImpl } = stubFetch([
      {
        path: "/notify",
        body: {
          ladder: [{ afterHours: 24, channels: ["jira"], kind: "notify" }],
          delegations: [],
          waiting: [
            {
              ticketKey: "UGURPAY-504",
              step: "analysis",
              waitingHours: 386,
              lastActionKey: null,
            },
          ],
          routing: { default: ["teams"], byEvent: {} },
          ladderRaw: {
            steps: [
              { id: "reminder-24h", afterHours: 24, channel: "jira", event: "gate_reminder", action: "notify" },
            ],
            businessHoursOnly: false,
            calendar: {},
          },
        },
      },
    ]);
    renderScreen(<NotifyScreen />, { fetchImpl });

    expect(await screen.findByText(/otomatik reddedilmez/)).toBeInTheDocument();
    // 386 hours is 16 days 2 hours — formatted through the catalog, not concatenated.
    expect(screen.getByText("16 gün 2 saat")).toBeInTheDocument();
  });
});

describe("onboard screen", () => {
  const OPTIONS = {
    path: "/onboarding/options",
    body: { jiraProjects: ["UGURKREDI"], adoRepos: [], platforms: ["linux-node"] },
  };
  const JIRA_CONNS = {
    path: "/onboarding/jira-connections",
    body: { connections: [{ id: "jira", kind: "jira_cloud", displayName: "Jira" }] },
  };
  const JIRA_PROJECTS = {
    // stubFetch strips the query string before matching, so the path is bare.
    path: "/onboarding/jira-projects",
    body: { ok: true, projects: [{ key: "UGURKREDI", name: "Ugur Kredi" }] },
  };
  const SCM_CONNS = {
    path: "/onboarding/scm-connections",
    body: { connections: [{ id: "github", kind: "github", displayName: "GitHub" }] },
  };
  const SCM_REPOS = {
    path: "/onboarding/scm-repos",
    body: { ok: true, repos: [{ id: "1", fullName: "Uguryldz/maestro-pilot" }] },
  };
  const PICKERS = [OPTIONS, JIRA_CONNS, JIRA_PROJECTS, SCM_CONNS, SCM_REPOS];

  /** Pick Jira connection → (live) project, then SCM connection → (live) repo. */
  async function pickProjectAndRepo(): Promise<void> {
    await userEvent.selectOptions(await screen.findByLabelText("Jira bağlantısı"), "jira");
    await screen.findByRole("option", { name: "UGURKREDI · Ugur Kredi" });
    await userEvent.selectOptions(screen.getByLabelText("Jira projesi"), "UGURKREDI");
    await userEvent.selectOptions(screen.getByLabelText("SCM bağlantısı"), "github");
    // The repo select is disabled until the live list arrives; wait for the option.
    await screen.findByRole("option", { name: "Uguryldz/maestro-pilot" });
    await userEvent.selectOptions(screen.getByLabelText("Repo"), "Uguryldz/maestro-pilot");
  }

  it("blocks submission until a dry run has been seen", async () => {
    const { fetchImpl, calls } = stubFetch([...PICKERS]);
    renderScreen(<OnboardScreen />, { fetchImpl });

    // Single form now: project+repo+platform are all on screen, no "İleri".
    await pickProjectAndRepo();
    await userEvent.selectOptions(await screen.findByLabelText("Platform profili"), "linux-node");

    const submit = await screen.findByRole("button", { name: "Admin onayına gönder" });
    expect(submit).toBeDisabled();
    // The block message points the operator at the dry-run button on the same
    // form, since every field is already filled in above it.
    expect(await screen.findByText(/Kuru koşum yap.*butonuna basın/)).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  it("names the tickets that matched no rule instead of hiding them", async () => {
    const { fetchImpl } = stubFetch([
      ...PICKERS,
      {
        path: "/onboarding/dry-run",
        method: "POST",
        body: { byRule: ["A-1"], bySuggestion: [], unresolved: ["UGURKREDI-3", "UGURKREDI-9"] },
      },
    ]);
    renderScreen(<OnboardScreen />, { fetchImpl });

    await pickProjectAndRepo();
    await userEvent.click(screen.getByRole("button", { name: "Kuru koşum yap" }));

    expect(await screen.findByText(/UGURKREDI-3, UGURKREDI-9/)).toBeInTheDocument();
    expect(screen.getByText("atama gerekir: 2")).toBeInTheDocument();
  });

  it("lists project and repo LIVE from the chosen connections, never a hard-coded list", async () => {
    const { fetchImpl, calls } = stubFetch([...PICKERS]);
    renderScreen(<OnboardScreen />, { fetchImpl });

    // Before a Jira connection is picked, the project select prompts for one.
    await screen.findByLabelText("Jira bağlantısı");
    expect(screen.getByText("Önce Jira bağlantısı seç")).toBeInTheDocument();
    // Picking the Jira connection triggers the LIVE project call.
    await userEvent.selectOptions(screen.getByLabelText("Jira bağlantısı"), "jira");
    expect(await screen.findByRole("option", { name: "UGURKREDI · Ugur Kredi" })).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes("/onboarding/jira-projects?connectionId=jira"))).toBe(true);

    // Before an SCM connection is picked, the repo select prompts for one.
    expect(screen.getByText("Önce SCM bağlantısı seç")).toBeInTheDocument();
    // Picking the SCM connection triggers the LIVE repo call.
    await userEvent.selectOptions(screen.getByLabelText("SCM bağlantısı"), "github");
    expect(await screen.findByRole("option", { name: "Uguryldz/maestro-pilot" })).toBeInTheDocument();
    expect(calls.some((c) => c.url.includes("/onboarding/scm-repos?connectionId=github"))).toBe(true);
  });
});
