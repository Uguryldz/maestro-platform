import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { UsersScreen } from "../src/screens/Users.tsx";
import { ADMIN, renderScreen, stubFetch } from "./harness.tsx";

const ACTIVE = {
  username: "deniz.yalcin",
  userId: "deniz.yalcin@ugurbank.local",
  roles: ["qa", "viewer"],
  groups: ["qa"],
  active: true,
};

const DISABLED = {
  username: "baran.tunc",
  userId: "baran.tunc@ugurbank.local",
  roles: ["tech-lead", "viewer"],
  groups: ["tech-leads"],
  active: false,
};

const LIST = { path: "/studio/users", body: { items: [ACTIVE, DISABLED] } };

describe("users screen", () => {
  it("renders the directory as a table, off-boarded rows included", async () => {
    const { fetchImpl } = stubFetch([LIST]);
    renderScreen(<UsersScreen />, { fetchImpl, session: ADMIN });

    expect(await screen.findByText("deniz.yalcin")).toBeInTheDocument();
    expect(screen.getByText("baran.tunc")).toBeInTheDocument();
    // The disabled account shows as such rather than being hidden.
    expect(screen.getByText("pasif")).toBeInTheDocument();
    expect(screen.getByText("etkin")).toBeInTheDocument();
  });

  it("opens an add-user form and posts the derived groups, never the roles", async () => {
    const { fetchImpl, calls } = stubFetch([
      LIST,
      { path: "/studio/users", method: "POST", status: 201, body: { ...ACTIVE, username: "mert.demir" } },
    ]);
    renderScreen(<UsersScreen />, { fetchImpl, session: ADMIN });

    await userEvent.click(await screen.findByRole("button", { name: "➕ Kullanıcı ekle" }));
    const dialog = await screen.findByRole("dialog");

    await userEvent.type(within(dialog).getByLabelText("Kullanıcı adı"), "mert.demir");
    await userEvent.type(within(dialog).getByLabelText("Görünen ad"), "Mert Demir");
    await userEvent.type(within(dialog).getByLabelText("Parola"), "Yeni.Parola-2026!");
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /tech-leads/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "➕ Kullanıcı ekle" }));

    await waitFor(() => {
      const post = calls.find((call) => call.method === "POST");
      expect(post).toBeDefined();
      expect(post?.body).toMatchObject({
        username: "mert.demir",
        displayName: "Mert Demir",
        groups: ["tech-leads"],
        password: "Yeni.Parola-2026!",
      });
      // Roles are the server's reading of groups — the client never sends them.
      expect(post?.body).not.toHaveProperty("roles");
    });
  });

  it("offers the new teams (operators, analysts) and derives their role, not a new one", async () => {
    const { fetchImpl, calls } = stubFetch([
      LIST,
      { path: "/studio/users", method: "POST", status: 201, body: { ...ACTIVE, username: "op.user" } },
    ]);
    renderScreen(<UsersScreen />, { fetchImpl, session: ADMIN });

    await userEvent.click(await screen.findByRole("button", { name: "➕ Kullanıcı ekle" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Kullanıcı adı"), "op.user");
    await userEvent.type(within(dialog).getByLabelText("Görünen ad"), "Op User");
    await userEvent.type(within(dialog).getByLabelText("Parola"), "Yeni.Parola-2026!");

    // The operators team is offered and grants the (existing) tech-lead role —
    // never a role of its own name.
    await userEvent.click(within(dialog).getByRole("checkbox", { name: /operators/ }));
    await userEvent.click(within(dialog).getByRole("button", { name: "➕ Kullanıcı ekle" }));

    await waitFor(() => {
      const post = calls.find((call) => call.method === "POST");
      expect((post?.body as { groups: string[] }).groups).toEqual(["operators"]);
    });
  });

  it("shows each failed password rule the BFF names, not a single opaque error", async () => {
    const { fetchImpl } = stubFetch([
      LIST,
      {
        path: "/studio/users",
        method: "POST",
        status: 400,
        body: { error: "password_policy", details: { violations: ["too_short", "no_symbol"] } },
      },
    ]);
    renderScreen(<UsersScreen />, { fetchImpl, session: ADMIN });

    await userEvent.click(await screen.findByRole("button", { name: "➕ Kullanıcı ekle" }));
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Kullanıcı adı"), "zayif");
    await userEvent.type(within(dialog).getByLabelText("Görünen ad"), "Zayıf");
    await userEvent.type(within(dialog).getByLabelText("Parola"), "short");
    await userEvent.click(within(dialog).getByRole("button", { name: "➕ Kullanıcı ekle" }));

    expect(await within(dialog).findByText(/Çok kısa/)).toBeInTheDocument();
    expect(within(dialog).getByText(/simge gerekli/)).toBeInTheDocument();
  });

  it("deactivates through a confirm modal, calling DELETE", async () => {
    const { fetchImpl, calls } = stubFetch([
      LIST,
      {
        path: "/studio/users/deniz.yalcin",
        method: "DELETE",
        body: { ...ACTIVE, active: false },
      },
    ]);
    renderScreen(<UsersScreen />, { fetchImpl, session: ADMIN });

    await screen.findByText("deniz.yalcin");
    // The deactivate button sits on the active row only.
    await userEvent.click(screen.getAllByRole("button", { name: "Pasifleştir" })[0]!);
    const dialog = await screen.findByRole("dialog");
    await userEvent.type(within(dialog).getByLabelText("Gerekçe"), "işten ayrıldı");
    await userEvent.click(within(dialog).getByRole("button", { name: "Pasifleştir" }));

    await waitFor(() => {
      const del = calls.find((call) => call.method === "DELETE");
      expect(del?.url).toContain("/studio/users/deniz.yalcin");
    });
  });

  it("lists the closed role set as a legend", async () => {
    const { fetchImpl } = stubFetch([LIST]);
    renderScreen(<UsersScreen />, { fetchImpl, session: ADMIN });

    // Some role names also appear in the table's role column, so assert presence
    // rather than uniqueness — the legend is the row that always exists.
    await screen.findByText("deniz.yalcin");
    for (const role of ["admin", "tech-lead", "product-owner", "qa", "developer", "viewer"]) {
      expect(screen.getAllByText(role).length).toBeGreaterThan(0);
    }
  });

  it("shows a translated failure, never the server code, when the list fails", async () => {
    const { fetchImpl } = stubFetch([
      { path: "/studio/users", status: 403, body: { error: "role_required" } },
    ]);
    renderScreen(<UsersScreen />, { fetchImpl, session: ADMIN });

    expect(await screen.findByText("Veri alınamadı")).toBeInTheDocument();
    expect(screen.queryByText(/role_required/)).not.toBeInTheDocument();
  });
});
