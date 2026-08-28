import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ConnectorsPanel } from "../src/screens/settings/ConnectorsPanel.tsx";
import { ADMIN, VIEWER, renderScreen, stubFetch } from "./harness.tsx";

/**
 * The connector-management screen.
 *
 * The properties under test mirror what the BFF also enforces: an admin sees
 * the add/edit/test/delete controls and a viewer sees none; a saved token is
 * shown only as a mask; the live test calls the endpoint and renders the result
 * inline; and an edit that does not touch the token omits it from the payload
 * (so the stored credential is preserved).
 */

const GITHUB = {
  id: "github",
  kind: "github",
  displayName: "GitHub kurumsal",
  baseUrl: "https://api.github.com",
  authKind: "bearer",
  config: {},
  secretRef: "connector:github:abc",
  secretMask: "1234",
  secretSet: true,
  enabled: true,
  createdAt: "2026-08-10T09:00:00.000Z",
  updatedAt: "2026-08-10T09:00:00.000Z",
  lastTestedAt: null,
  lastTestOk: null,
};

const LIST = { path: "/studio/connections", body: { connections: [GITHUB] } };

describe("connectors panel", () => {
  it("lists connections and shows the token only as a mask (****abcd)", async () => {
    const { fetchImpl } = stubFetch([LIST]);
    renderScreen(<ConnectorsPanel />, { fetchImpl, session: ADMIN });

    expect(await screen.findByText("GitHub")).toBeInTheDocument();
    // The token is a mask, never the value.
    expect(screen.getByText("****1234")).toBeInTheDocument();
  });

  it("shows a tri-state status — never tested renders as ⚪, not a green light", async () => {
    const { fetchImpl } = stubFetch([LIST]);
    renderScreen(<ConnectorsPanel />, { fetchImpl, session: ADMIN });
    await screen.findByText("GitHub");
    expect(screen.getByText("test edilmedi")).toBeInTheDocument();
  });

  it("hides every write control from a viewer (M86)", async () => {
    const { fetchImpl } = stubFetch([LIST]);
    renderScreen(<ConnectorsPanel />, { fetchImpl, session: VIEWER });
    await screen.findByText("GitHub");
    expect(screen.queryByRole("button", { name: /Bağlantı ekle/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Test et/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Sil" })).not.toBeInTheDocument();
  });

  it("runs a live test and renders the result inline", async () => {
    const { fetchImpl } = stubFetch([
      LIST,
      {
        path: "/studio/connections/github/test",
        method: "POST",
        body: { ok: true, messageKey: "connections.test.ok_as", messageParams: { who: "ugurbank-bot" }, testedAt: "2026-08-10T10:00:00.000Z" },
      },
    ]);
    renderScreen(<ConnectorsPanel />, { fetchImpl, session: ADMIN });
    await screen.findByText("GitHub");

    await userEvent.click(screen.getByRole("button", { name: /Test et/ }));
    // The catalog key is rendered in Turkish with the returned account name.
    expect(await screen.findByText("Bağlantı başarılı — ugurbank-bot")).toBeInTheDocument();
  });

  it("a corrected bot account reads as a WARNING, not a green tick", async () => {
    // The connection works, so the BFF answers ok:true — but it also reports
    // that the stored bot account did not belong to the token. A plain green
    // "bağlı" here would tell the operator the opposite of what happened.
    const { fetchImpl } = stubFetch([
      LIST,
      {
        path: "/studio/connections/github/test",
        method: "POST",
        body: {
          ok: true,
          messageKey: "connections.test.ok_bot_fixed",
          messageParams: {
            was: "712020:7ee7a2ab-23e7-47aa-a61e-38b79b7eb4d1",
            now: "712020:b836c135-c9d3-499a-a665-aed43d362cfd",
          },
          testedAt: "2026-08-10T10:00:00.000Z",
          botAccountCorrected: {
            from: "712020:7ee7a2ab-23e7-47aa-a61e-38b79b7eb4d1",
            to: "712020:b836c135-c9d3-499a-a665-aed43d362cfd",
          },
        },
      },
    ]);
    renderScreen(<ConnectorsPanel />, { fetchImpl, session: ADMIN });
    await screen.findByText("GitHub");

    await userEvent.click(screen.getByRole("button", { name: /Test et/ }));

    // The operator is told, in full, WHICH id was replaced by WHICH — the badge
    // renders the live outcome text, so both ids are on screen to compare.
    const shown = await screen.findAllByText(/712020:7ee7a2ab/);
    expect(shown.length).toBeGreaterThan(0);
    expect(screen.getAllByText(/712020:b836c135/).length).toBeGreaterThan(0);
    // Never the plain "connected" badge — that would hide the correction.
    expect(screen.queryByText("bağlı")).not.toBeInTheDocument();
    // The badge carries the amber warning tone, not the green success tone.
    const badge = shown[0]?.closest(".ui-badge");
    expect(badge?.className).toContain("amber");
    expect(badge?.className).not.toContain("green");
  });

  it("a config-only edit omits the token — the stored credential is preserved", async () => {
    const { fetchImpl, calls } = stubFetch([
      LIST,
      { path: "/studio/connections/github", method: "PUT", body: { connection: { ...GITHUB, displayName: "GitHub (prod)" } } },
    ]);
    renderScreen(<ConnectorsPanel />, { fetchImpl, session: ADMIN });
    await screen.findByText("GitHub");

    await userEvent.click(screen.getByRole("button", { name: "Düzenle" }));
    const dialog = await screen.findByRole("dialog");
    // The token field is LOCKED (shows the mask), not an input to prefill.
    expect(within(dialog).getByText("****1234")).toBeInTheDocument();

    const name = within(dialog).getByLabelText("Görünen ad");
    await userEvent.clear(name);
    await userEvent.type(name, "GitHub (prod)");
    await userEvent.click(within(dialog).getByRole("button", { name: "Düzenle" }));

    await waitFor(() => {
      const put = calls.find((c) => c.method === "PUT");
      expect(put).toBeDefined();
      // No token in the payload — the credential was not touched.
      expect((put?.body as { token?: string }).token).toBeUndefined();
      expect((put?.body as { displayName: string }).displayName).toBe("GitHub (prod)");
    });
  });

  it("creating a connection posts the typed fields including the token", async () => {
    const { fetchImpl, calls } = stubFetch([
      LIST,
      { path: "/studio/connections", method: "POST", status: 201, body: { connection: GITHUB } },
    ]);
    renderScreen(<ConnectorsPanel />, { fetchImpl, session: ADMIN });
    await screen.findByText("GitHub");

    await userEvent.click(screen.getByRole("button", { name: /Bağlantı ekle/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Kimlik (id)"), "jira");
    await userEvent.type(within(dialog).getByLabelText("Görünen ad"), "Jira");
    await userEvent.type(within(dialog).getByLabelText(/URL/), "https://ugurbank.atlassian.net");
    // Jira Cloud authenticates the token WITH this address — the form is
    // `jira_cloud` by default, and its probe builds `basicAuth(email, token)`.
    await userEvent.type(within(dialog).getByLabelText(/Bot hesabının e-postası/), "bot@ugurbank.com");
    await userEvent.type(within(dialog).getByLabelText("Token"), "s3cr3t-token");
    await userEvent.click(within(dialog).getByRole("button", { name: /Bağlantı ekle/ }));

    await waitFor(() => {
      const post = calls.find((c) => c.method === "POST");
      expect(post).toBeDefined();
      const body = post?.body as { id: string; token: string; config: Record<string, string> };
      expect(body.id).toBe("jira");
      expect(body.token).toBe("s3cr3t-token");
      expect(body.config["email"]).toBe("bot@ugurbank.com");
    });
  });

  /**
   * The failure this whole per-kind table was written for: the form used to
   * offer three boxes for all ten kinds, so `jira_cloud` — whose probe REQUIRES
   * `config.email` — could be saved without one. The row then failed its live
   * test with a 401, which reads as a bad token and sends the operator off to
   * re-issue a credential that was fine.
   */
  it("will not post a Jira Cloud row whose account e-mail is missing", async () => {
    const { fetchImpl, calls } = stubFetch([LIST]);
    renderScreen(<ConnectorsPanel />, { fetchImpl, session: ADMIN });
    await screen.findByText("GitHub");

    await userEvent.click(screen.getByRole("button", { name: /Bağlantı ekle/ }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Kimlik (id)"), "jira");
    await userEvent.type(within(dialog).getByLabelText("Görünen ad"), "Jira");
    await userEvent.type(within(dialog).getByLabelText(/URL/), "https://ugurbank.atlassian.net");
    await userEvent.type(within(dialog).getByLabelText("Token"), "s3cr3t-token");
    await userEvent.click(within(dialog).getByRole("button", { name: /Bağlantı ekle/ }));

    // Refused in the form, so the request is never made and the dialog stays
    // open on the box that needs filling.
    expect(calls.find((c) => c.method === "POST")).toBeUndefined();
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });
});
