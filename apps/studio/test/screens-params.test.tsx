import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ParamsScreen } from "../src/screens/Params.tsx";
import { renderScreen, stubFetch } from "./harness.tsx";

const GUARDED = {
  key: "gates.gate_set",
  scope: "global",
  type: "string",
  guarded: true,
  descriptionKey: "params.description.gate_set",
  defaultValue: "risk_tiered",
};

const PLAIN = {
  key: "quota.warn_pct",
  scope: "global",
  type: "number",
  guarded: false,
  descriptionKey: "params.description.quota_warn_pct",
  defaultValue: 80,
};

function paramsRoutes(overrides: { pending?: unknown[]; values?: unknown[] } = {}) {
  return [
    {
      path: "/params",
      body: {
        definitions: [GUARDED, PLAIN],
        values: overrides.values ?? [],
        pending: overrides.pending ?? [],
      },
    },
  ];
}

describe("params screen", () => {
  it("lists every definition, including one that has never been changed", async () => {
    const { fetchImpl } = stubFetch(paramsRoutes());
    renderScreen(<ParamsScreen />, { fetchImpl });

    expect(await screen.findByText("gates.gate_set")).toBeInTheDocument();
    expect(screen.getByText("quota.warn_pct")).toBeInTheDocument();
    // Never edited: the default value is shown rather than a blank cell.
    expect(screen.getByText("risk_tiered")).toBeInTheDocument();
  });

  it("marks a guarded parameter as four-eyes and offers 'send for approval', not 'save'", async () => {
    const { fetchImpl } = stubFetch(paramsRoutes());
    renderScreen(<ParamsScreen />, { fetchImpl });

    await screen.findByText("gates.gate_set");
    expect(screen.getAllByText("4-göz").length).toBeGreaterThan(0);

    await userEvent.click(screen.getByRole("button", { name: "İncele" }));

    // The guarded editor must not offer a plain save: the write is a proposal.
    expect(await screen.findByRole("button", { name: "Onaya gönder" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Kaydet" })).not.toBeInTheDocument();
  });

  it("offers a plain save for an unguarded parameter", async () => {
    const { fetchImpl } = stubFetch(paramsRoutes());
    renderScreen(<ParamsScreen />, { fetchImpl });

    await screen.findByText("quota.warn_pct");
    await userEvent.click(screen.getByRole("button", { name: "Düzenle" }));

    expect(await screen.findByRole("button", { name: "Kaydet" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Onaya gönder" })).not.toBeInTheDocument();
  });

  it("says the old value is still in force when the server answers 202 pending", async () => {
    const { fetchImpl } = stubFetch([
      ...paramsRoutes(),
      {
        path: "/params/gates.gate_set",
        method: "PUT",
        status: 202,
        body: {
          status: "pending",
          pending: {
            key: "gates.gate_set",
            scopeRef: null,
            value: "always_six",
            proposedBy: "ugur.yildiz@ugurbank.local",
            at: "2026-08-08T10:00:00.000Z",
          },
        },
      },
    ]);
    renderScreen(<ParamsScreen />, { fetchImpl });

    await screen.findByText("gates.gate_set");
    await userEvent.click(screen.getByRole("button", { name: "İncele" }));
    const field = await screen.findByLabelText("Yeni değer");
    await userEvent.clear(field);
    await userEvent.type(field, "always_six");
    await userEvent.click(screen.getByRole("button", { name: "Onaya gönder" }));

    const alert = await screen.findByText(/ikinci onaylayana gönderildi/i);
    expect(alert).toHaveTextContent("eski değer hâlâ geçerli");
  });

  it("shows who proposed an open four-eyes change beside the live value", async () => {
    const { fetchImpl } = stubFetch(
      paramsRoutes({
        pending: [
          {
            key: "gates.gate_set",
            scopeRef: null,
            value: "always_six",
            proposedBy: "mert.demir@ugurbank.local",
            at: "2026-08-08T10:00:00.000Z",
          },
        ],
      }),
    );
    renderScreen(<ParamsScreen />, { fetchImpl });

    expect(await screen.findByText("onay bekliyor")).toBeInTheDocument();
    expect(
      screen.getByText(/mert\.demir@ugurbank\.local önerdi → always_six/),
    ).toBeInTheDocument();
  });

  /**
   * O1 regression. Four-eyes counts PEOPLE. The BFF refuses a proposer's own
   * confirmation and answers `status: "pending"` again
   * (apps/bff/src/params-service.ts:82), so a button reading "Approve the
   * change" for that person promises an outcome the server will not deliver —
   * the operator walks away believing a guarded parameter is live when it is
   * still waiting.
   */
  const OWN_PENDING = {
    key: "gates.gate_set",
    scopeRef: null,
    value: "always_six",
    proposedBy: "ugur.yildiz@ugurbank.local",
    at: "2026-08-08T10:00:00.000Z",
  };

  it("never offers to approve a change to the person who proposed it", async () => {
    const { fetchImpl } = stubFetch(paramsRoutes({ pending: [OWN_PENDING] }));
    // ADMIN in the harness IS ugur.yildiz@ugurbank.local — the proposer.
    renderScreen(<ParamsScreen />, { fetchImpl });

    await screen.findByText("gates.gate_set");
    // A guarded row's action reads "İncele" (review), not "Düzenle".
    await userEvent.click(screen.getByRole("button", { name: "İncele" }));

    const field = await screen.findByLabelText("Yeni değer");
    await userEvent.clear(field);
    // Typing the pending value byte-for-byte is what used to flip the label.
    await userEvent.type(field, "always_six");

    expect(screen.queryByRole("button", { name: "Öneriyi onayla" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Onaya gönder" })).toBeInTheDocument();
    // And the operator is told why, rather than left to guess.
    expect(screen.getByText(/kendi önerini onaylayamazsın/i)).toBeInTheDocument();
  });

  it("offers to approve when a DIFFERENT person proposed the same value", async () => {
    const { fetchImpl } = stubFetch(
      paramsRoutes({ pending: [{ ...OWN_PENDING, proposedBy: "mert.demir@ugurbank.local" }] }),
    );
    renderScreen(<ParamsScreen />, { fetchImpl });

    await screen.findByText("gates.gate_set");
    await userEvent.click(screen.getByRole("button", { name: "İncele" }));

    const field = await screen.findByLabelText("Yeni değer");
    await userEvent.clear(field);
    await userEvent.type(field, "always_six");

    expect(screen.getByRole("button", { name: "Öneriyi onayla" })).toBeInTheDocument();
  });

  it("treats an AI delegate as the same pair of eyes as the human behind it", async () => {
    const { fetchImpl } = stubFetch(
      paramsRoutes({ pending: [{ ...OWN_PENDING, proposedBy: "ai-via:ugur.yildiz@ugurbank.local" }] }),
    );
    renderScreen(<ParamsScreen />, { fetchImpl });

    await screen.findByText("gates.gate_set");
    await userEvent.click(screen.getByRole("button", { name: "İncele" }));

    const field = await screen.findByLabelText("Yeni değer");
    await userEvent.clear(field);
    await userEvent.type(field, "always_six");

    // ugur and ai-via:ugur are one person holding two credentials (M32/M101).
    expect(screen.queryByRole("button", { name: "Öneriyi onayla" })).not.toBeInTheDocument();
  });

  it("renders a translated sentence, never the server's error code, when the list fails", async () => {
    const { fetchImpl } = stubFetch([
      { path: "/params", status: 403, body: { error: "role_required" } },
    ]);
    renderScreen(<ParamsScreen />, { fetchImpl });

    expect(await screen.findByText("Bu işlem için yetkin yok.")).toBeInTheDocument();
    expect(screen.queryByText(/role_required/)).not.toBeInTheDocument();
  });

  it("refuses a value that does not match the declared type before sending it", async () => {
    const { fetchImpl, calls } = stubFetch(paramsRoutes());
    renderScreen(<ParamsScreen />, { fetchImpl });

    await screen.findByText("quota.warn_pct");
    await userEvent.click(screen.getByRole("button", { name: "Düzenle" }));
    const field = await screen.findByLabelText("Yeni değer");
    await userEvent.clear(field);
    await userEvent.type(field, "seksen");
    await userEvent.click(screen.getByRole("button", { name: "Kaydet" }));

    expect(await screen.findByText("Değer bu parametrenin türüne uymuyor.")).toBeInTheDocument();
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(0);
  });
});
